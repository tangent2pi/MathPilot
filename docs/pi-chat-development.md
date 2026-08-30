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
              ├─ 独立库 mathpilot_pi → 用户线程归属、ACL、卡片事件、附件登记
              ├─ PI_CHAT_RUNTIME_ROOT → Pi JSONL、线程工作区、上传文件
              └─ MinIO → 已归档线程的工作区与 JSONL
```

- 浏览器不持有模型密钥、MinIO 凭据、网关密钥或内部 runtime 地址。
- Better Auth Cookie 只由 `api-next` 解释。`pi-chat-runtime` 只接受携带共享
  `PI_GATEWAY_SECRET` 和网关已验证主体头的请求。
- `mathpilot` 仍是身份、租户、角色、师生关系和既有学习数据的事实源。
- `mathpilot_pi` 是新建最小库，不复制身份表、学生可见 ID 或消息正文；线程只保留
  `owner_user_id`，卡片事件记录 `actor_user_id`。
- Pi JSONL 与工作区是对话事实；PostgreSQL 只保存归属和索引。
- `pi_thread_acl` 目前只允许读取当前用户自己的授权行；ACL 写入接口尚未开放，避免
  通过原始表写入扩大权限。需要共享线程时先补齐 owner/admin 专用领域路由。
- KTQ/ER 是普通对话，不在 Pi 表中增加 `thread_type`、`parent_thread_id` 或
  `workflow_id`。宿主通过工作区外的主体文件把当前网关主体交给内容工具，模型不能
  自行填写租户、班级、角色或 SQL。

## 当前功能范围

- assistant-ui 官方 Thread、ThreadList、附件与 Pi 线程运行时。
- Better Auth 登录、注册、Cookie Session、退出及账户资料。
- 图片和普通文件上传、对话内显示及下载。
- `present_question_card` 与 `present_learning_artifact` 的 assistant-ui Tool UI。
- 题卡事件写入 `pi_card_events`，只记录交互审计，不在此处判答。
- `present_teaching_ui` 当前不展示。
- `content_library_search` 与 `content_library_get` 是内容 Skill 的唯一检索工具；前者只
  接收 `entity_kinds/query/cursor/limit`，后者只接收稳定 `entity_ref` 或 `package_ref`。
  目前内容服务以 `legacy-adapter` 投影旧表，待主库规范化迁移获批后替换实现。
- `respond` 对 KTQ/ER 结果文件和 SHA-256 校验回执做宿主侧校验；通过后返回可供
  内容服务登记的结构化摘要，未通过校验的结果不会终止模型回合。候选集入库和教师
  复核页仍属于主库规范化迁移阶段，当前不会伪造已入库的候选 ID。
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
MODEL_API_BASE=https://api.deepseek.com \
MODEL_ID=deepseek-v4-flash-vision-exp \
MODEL_API_KEY=<key> \
MINIO_ENDPOINT=127.0.0.1:9000 \
MINIO_ACCESS_KEY=<access-key> \
MINIO_SECRET_KEY=<secret-key> \
MINIO_BUCKET=mathpilot-workspaces \
  nix develop -c pnpm --filter @mathpilot/pi-chat-runtime start
```

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
| 已归档线程与产物对象 | `MINIO_VOLUME` | 否 |
| 旧批处理 Pi Session | `mathpilot_pi_sessions` | 与新对话运行时无关 |

数据库迁移时必须同时迁移 `PI_CHAT_RUNTIME_ROOT`。只复制 `mathpilot_pi` 会留下指向
不存在 JSONL/工作区的线程记录。
