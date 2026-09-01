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
          ├─ api-to-content → content-next
          └─ api-to-storage → storage-next

content-next ──content-to-pi──▶ pi-chat-runtime :3105
             ◀──pi-to-content──┤
storage-next ◀──pi-to-storage──┘
```

- 浏览器不持有模型密钥、MinIO 凭据、内部 edge keyring 或 runtime 地址。
- Better Auth Cookie 只由 `api-next` 解释。所有服务间请求由
  `@mathpilot/internal-service` 签发 60 秒、绑定 edge/主体/method/path/规范 JSON 摘要的断言；
  接收端只从验证后的 service context 读取主体，不接受主体头。
- 六条生产 edge 各有独立、可轮换 keyring。共同 owner 统一加载、production fail-fast、
  JOSE codec、Fastify 401、replay、超时/取消和观测；领域服务只声明 edge 并调用薄 adapter。
- Pi 不持有 MinIO 管理凭据。对象控制面只经 `pi-to-storage`，实际上传/下载只使用
  Storage 返回的短时效预签名 URL；已退役的 Pi archive/MinIO fallback 不兼容也不恢复。
- `mathpilot` 仍是身份、租户、角色、师生关系和既有学习数据的事实源。
- `mathpilot_pi` 是新建最小库，不复制身份表、学生可见 ID 或消息正文；线程只保留
  `owner_user_id`，卡片事件记录 `actor_user_id`。
- Pi JSONL 与工作区是对话事实；PostgreSQL 只保存归属和索引。
- `pi_thread_acl` 目前只允许读取当前用户自己的授权行；ACL 写入接口尚未开放，避免
  通过原始表写入扩大权限。需要共享线程时再补 owner 控制的领域路由。ACL 中的
  `read/write/admin` 是单线程访问级别，不是新增产品角色；线程删除始终只允许 owner。
- KTQ/ER 是普通对话，不在 Pi 表中增加 `thread_type`、`parent_thread_id` 或
  `workflow_id`。宿主通过工作区外的主体文件把已验证的 service context 交给内容工具，模型不能
  自行填写租户、班级、角色或 SQL。

## 当前功能范围

- assistant-ui 官方 Thread、ThreadList、附件与 Pi 线程运行时。
- Better Auth 登录、注册、Cookie Session、退出及账户资料。
- 普通文件经浏览器预签名直传/直下，Pi 只按稳定 `object_id` 物化工作副本；图片保留视觉消息表示并同时登记对象。
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

本地必须显式使用 `MATHPILOT_ENVIRONMENT=development` 和
`MATHPILOT_INTERNAL_REPLAY_MODE=memory-single-replica`。development 可省略 keyring，统一 owner
会为六条边选择仓库公开且彼此独立的开发值；production 没有这个默认值，必须使用
[`deploy/dev/.env.example`](../deploy/dev/.env.example) 所列六个独立 keyring。调用方仍必须声明
自己的最终目标 URL。

```sh
DATABASE_URL=postgresql://127.0.0.1:<port>/mathpilot \
MATHPILOT_ENVIRONMENT=development \
MATHPILOT_INTERNAL_REPLAY_MODE=memory-single-replica \
MATHPILOT_INTERNAL_CONTENT_URL=http://127.0.0.1:3016 \
MATHPILOT_INTERNAL_STORAGE_URL=http://127.0.0.1:3017 \
BETTER_AUTH_URL=http://localhost:5174 \
BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:5174 \
  nix develop -c pnpm --filter @mathpilot/api-next start
```

```sh
MATHPILOT_ENVIRONMENT=development \
MATHPILOT_INTERNAL_REPLAY_MODE=memory-single-replica \
MATHPILOT_INTERNAL_CONTENT_URL=http://127.0.0.1:3016 \
MATHPILOT_INTERNAL_STORAGE_URL=http://127.0.0.1:3017 \
PI_DATABASE_URL=postgresql://127.0.0.1:<port>/mathpilot_pi \
PI_CHAT_RUNTIME_ROOT=<runtime-root> \
PI_CHAT_WORKSPACE_ROOT=<runtime-root>/sessions \
MODEL_API_BASE=https://api.deepseek.com \
MODEL_API_KEY=<key> \
MODEL_ID_MAIN=deepseek-v4-flash-vision-exp \
MODEL_ID_AUX=deepseek-v4-flash-vision-exp \
SERPER_API_KEY=<optional-search-key> \
PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN=<optional-ocr-key> \
  nix develop -c pnpm --filter @mathpilot/pi-chat-runtime start
```

```sh
MATHPILOT_ENVIRONMENT=development \
MATHPILOT_INTERNAL_REPLAY_MODE=memory-single-replica \
MATHPILOT_INTERNAL_PI_URL=http://127.0.0.1:3105 \
DATABASE_URL=postgresql://127.0.0.1:<port>/mathpilot \
  nix develop -c pnpm --filter @mathpilot/content-next start
```

`storage-next` 只需自身三条接收 edge 的 keyring；development 会使用公开默认值，不需要任何
出站 internal URL。MinIO 管理凭据只注入 `storage-next`。本地设置
`MINIO_PUBLIC_ENDPOINT=http://localhost:9000`、`MINIO_CORS_ALLOWED_ORIGINS=http://localhost:5174`；
生产当前设置为 `https://mathpilot.tangentpi.com` 及实际 Web origin。预签名 URL 不入库。

```sh
nix develop -c pnpm --filter @mathpilot/web-next dev
```

前端入口是 `http://localhost:5174`。Vite 只在开发态把 `/api/*` 代理到
`api-next`。切换供应商配置只修改 Pi runtime 的 `MODEL_API_BASE`、`MODEL_API_KEY`、
`MODEL_ID_MAIN`、`MODEL_ID_AUX` 并重启该服务；当前协议为标准 Responses API，Pi
会继续从原生 JSONL 恢复线程。

## 容器数据

| 数据 | 容器卷 | 是否可由数据库重建 |
|---|---|---|
| 主库与 Pi 库 | `POSTGRES_VOLUME` | 否 |
| Pi JSONL、线程工作区、活动附件 | `PI_CHAT_RUNTIME_VOLUME` | 否 |
| 附件与内容对象 | `MINIO_VOLUME` | 否 |
| 旧批处理 Pi Session | `mathpilot_pi_sessions` | 与新对话运行时无关 |

数据库迁移时必须同时迁移 `PI_CHAT_RUNTIME_ROOT`。只复制 `mathpilot_pi` 会留下指向
不存在 JSONL/工作区的线程记录。
