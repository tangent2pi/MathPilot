# Pi 对话、鉴权与卡片开发运行

本文描述当前 `web-next + api-next + pi-chat-runtime` 实现。它与旧正式 Web、旧 API
和批处理 `agent-runtime` 分离；Pi 对话代码不得放回旧服务。

## 服务边界

```text
浏览器
  └─ 同源 /api/*
      └─ api-next :3101
          ├─ Better Auth Cookie → 用户、角色、租户、师生范围
          ├─ 主库 mathpilot → 身份与账户事实
          └─ 受信网关头 → pi-chat-runtime :3105
              ├─ assistant-ui 官方 PiThreadSupervisor / PiClient
              ├─ agentDir/extensions → sandbox、附件、respond、内容库、Core/Search/OCR
              ├─ 独立库 mathpilot_pi → 用户线程归属、ACL、卡片事件、附件登记
              ├─ PI_CHAT_RUNTIME_ROOT → Pi JSONL、线程工作区
              ├─ content-next → K/T/Q/E/R、候选复核、包与 ER 命令
              └─ storage-next → 私有 MinIO 对象登记与预签名 PUT/GET
```

- 浏览器不持有模型密钥、MinIO 凭据、网关密钥或内部 runtime 地址。
- Better Auth Cookie 只由 `api-next` 解释。`pi-chat-runtime` 只接受携带共享
  `PI_GATEWAY_SECRET` 和网关已验证主体头的请求。
- `mathpilot` 仍是身份、租户、角色、师生关系和既有学习数据的事实源。
- `mathpilot_pi` 是新建最小库，不复制身份表、学生可见 ID 或消息正文；线程只保留
  `owner_user_id`，卡片事件记录 `actor_user_id`。
- Pi JSONL 与工作区是对话事实；PostgreSQL 只保存归属和索引。
- `pi_thread_acl` 目前只允许读取当前用户自己的授权行；ACL 写入接口尚未开放，避免
  通过原始表写入扩大权限。需要共享线程时再补 owner 控制的领域路由。ACL 中的
  `read/write/admin` 是单线程访问级别，不是新增产品角色；线程删除始终只允许 owner。
- KTQ/ER 是普通对话，不在 Pi 表中增加 `thread_type`、`parent_thread_id` 或
  `workflow_id`。宿主通过工作区外的主体文件把当前网关主体交给内容工具，模型不能
  自行填写租户、班级、角色或 SQL。

## 当前功能范围

- assistant-ui 官方 Thread、ThreadList、附件与 Pi 线程运行时。
- Better Auth 登录、注册、Cookie Session、退出及账户资料。
- 普通文件经浏览器预签名直传/直下，Pi 只按稳定 `object_id` 物化工作副本；图片保留视觉消息表示并同时登记对象。
- `present_question_card` 与 `present_learning_artifact` 的 assistant-ui Tool UI。
- 题卡事件写入 `pi_card_events`，只记录交互审计，不在此处判答。
- `present_teaching_ui` 当前不展示。
- `content_library_search` 与 `content_library_get` 是内容 Skill 的唯一检索工具；前者只
  接收 `entity_kinds/query/cursor/limit`，后者只接收稳定 `entity_ref` 或 `package_ref`。
  由 `content-next` 查询规范化实体/修订和固定包，不读取旧 payload 表。
- `respond` 对 KTQ/ER 结果文件和 SHA-256 校验回执做宿主侧校验；通过后返回可供
  内容服务登记的结构化摘要，未通过校验的结果不会产生候选。有效结果返回真实
  `candidate_set_id`，assistant-ui 可打开 `/content/review/:id`；ER 批准后返回真实内容包。
- 通过校验的结果与回执由 runtime 使用内部预签名 PUT 直存 MinIO；storage-next 复核
  SHA-256/对象版本后，content-next 才接受两份稳定对象 ID。
- 返回修改后，`content-next` 通过数据库 outbox 重试把冻结批注送回原普通 Pi 会话；同一
  决定 ID 在 runtime 中幂等，新的 `respond` 结果指向被替代候选集并生成新修订。
- Core、Search、OCR 通过与上述扩展相同的 Pi `agentDir/extensions` 发现机制加载；
  Core/OCR 只挂载当前线程，Search 不挂载工作区，OCR 长结果由 checkpoint 固化到输出文件。
- “下一题” fork、后台判答、教学闭环和 Dream 不在本阶段实现范围内。

## 数据库初始化

开发机当前 PostgreSQL 可使用非默认端口；以实际 URL 为准，不把 `5432` 写死到代码。

```sh
nix develop -c createdb -h 127.0.0.1 -p <port> mathpilot_pi
PI_DATABASE_URL=postgresql://127.0.0.1:<port>/mathpilot_pi \
  nix develop -c pnpm --filter @mathpilot/web-next db:migrate
```

`pnpm ... db:migrate` 与容器中的 `pi-db-migrate` 都通过 schema-aware runner 按当前
状态执行 `0001_pi_threads.sql` 至 `0005_pi_attachments.sql`，可安全重复运行；它会
避免在 `student_id` 已移除后重放历史 RLS。容器环境由 `pi-db-migrate` 创建/迁移该库，
并把最小表权限授予非超级用户 `mathpilot_app`；
runtime 每个事务仍注入 `mathpilot.tenant_id`、`mathpilot.user_id` 和角色，由强制 RLS
做第二道边界。旧库已有的 `student_id` 会在 `0003/0004` 中移除；不要只执行前两个
迁移后启动新 runtime。

## 启动开发进程

三端必须使用相同且至少 32 字符的 `PI_GATEWAY_SECRET`。

```sh
DATABASE_URL=postgresql://127.0.0.1:<port>/mathpilot \
BETTER_AUTH_URL=http://localhost:5174 \
BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:5174 \
PI_CHAT_RUNTIME_URL=http://127.0.0.1:3105 \
PI_GATEWAY_SECRET=<shared-development-secret> \
  nix develop -c pnpm --filter @mathpilot/api-next start
```

```sh
PI_DATABASE_URL=postgresql://127.0.0.1:<port>/mathpilot_pi \
PI_GATEWAY_SECRET=<shared-development-secret> \
PI_CHAT_RUNTIME_ROOT=<runtime-root> \
PI_CHAT_WORKSPACE_ROOT=<runtime-root>/sessions \
MODEL_API_BASE=https://api.deepseek.com \
MODEL_ID=deepseek-v4-flash-vision-exp \
MODEL_API_KEY=<key> \
CONTENT_NEXT_URL=http://127.0.0.1:3016 \
CONTENT_NEXT_SECRET=<shared-development-secret> \
STORAGE_NEXT_URL=http://127.0.0.1:3017 \
STORAGE_NEXT_SECRET=<shared-development-secret> \
SERPER_API_KEY=<optional-search-key> \
PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN=<optional-ocr-key> \
  nix develop -c pnpm --filter @mathpilot/pi-chat-runtime start
```

MinIO 管理凭据只注入 `storage-next`。本地设置
`MINIO_PUBLIC_ENDPOINT=http://localhost:9000`、`MINIO_CORS_ALLOWED_ORIGINS=http://localhost:5174`；
生产当前设置为 `https://mathpilot.tangentpi.com` 及实际 Web origin。预签名 URL 不入库。

```sh
nix develop -c pnpm --filter @mathpilot/web-next dev
```

前端入口是 `http://localhost:5174`。Vite 只在开发态把 `/api/*` 代理到
`api-next`。切换模型只修改 Pi runtime 的 `MODEL_API_BASE/MODEL_ID/MODEL_API_KEY`
并重启该服务；Pi 会继续从原生 JSONL 恢复线程。

## 容器数据

| 数据 | 容器卷 | 是否可由数据库重建 |
|---|---|---|
| 主库与 Pi 库 | `POSTGRES_VOLUME` | 否 |
| Pi JSONL、线程工作区、活动附件 | `PI_CHAT_RUNTIME_VOLUME` | 否 |
| 附件与内容对象 | `MINIO_VOLUME` | 否 |
| 旧批处理 Pi Session | `mathpilot_pi_sessions` | 与新对话运行时无关 |

数据库迁移时必须同时迁移 `PI_CHAT_RUNTIME_ROOT`。只复制 `mathpilot_pi` 会留下指向
不存在 JSONL/工作区的线程记录。
