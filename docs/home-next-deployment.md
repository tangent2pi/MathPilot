# home：next 对话实现容器部署与数据复制

目标主机为 `home`，当前部署根为 `/srv/stacks/mathpilot-next`，唯一 Compose 根为
`deploy/dev/compose.yaml`。

2026-09-05 Agent 工具补丁：learning-next 通过 Pi SDK 显式加载现有 sandbox 与 Core/Search/OCR 插件，
并直接调用共享的 `@mathpilot/self-test` 模型工具。测评按钮向聊天发送意图；判答与下一题分离。
新增依赖需构建 `learning-next` 和 `api`；learning 镜像使用 Compose additional_contexts 复用 Pi 镜像。
前端更新 `deploy/dev/web-dist` 即生效。以下首次切换记录中的 `/srv/stacks/mathpilot` 是历史目录。

答辩演示（2026-09-05）部署在 `deploy/dev/web-dist/defense/`，来源为用户提供的
`MathPilot答辩演示网页.zip`；`mathpilot-defense.html` 同时作为 `index.html`。
`/defense` 跳转至 `/defense/`，附件和视频使用同目录静态资源；无需重启网页容器。
更新主站产物时须保留 `web-dist/defense/`，不要使用全目录删除式同步。

2026-09-05 下载链路修复：storage 必须注入 `MATHPILOT_INTERNAL_CONTENT_TO_STORAGE_KEYRING`。
生产 `MINIO_PUBLIC_ENDPOINT=https://mathpilot.tangentpi.com`，web 将三个 `mathpilot-*` 桶的
对象路径同域转发至 `minio:9000`，保留签名 Host/原始 URI，仍由 MinIO 验签。
不要把容器内端口 `9000` 或仅 Tailscale 可达的映射 `9010` 当作公网下载地址。

## 不可破坏约束

1. 旧 PostgreSQL 卷 `mathpilot_pgdata` 必须保留，禁止删除、清空或挂载为新库的写入目标。
2. 新部署使用 `mathpilot_pgdata_next`。本机当前 `mathpilot` 与 `mathpilot_pi` 通过逻辑备份复制进去。
3. 本机 `~/.mathpilot/runtime` 必须同步到新卷 `mathpilot_pi_chat_runtime`；线程索引与这些文件是一组数据。
4. 旧 `mathpilot_pi_sessions`、`mathpilot_agent_workspaces` 与 `mathpilot_content_artifacts` 保留。
5. 不把 `pi-chat-runtime` 合并回旧 `agent-runtime`。后者继续服务 learning/content/profile 的批处理任务。
6. `.env`、数据库 dump、Pi runtime 归档和模型/对象存储密钥都不得提交 Git。

## 新容器拓扑

```text
web (web-next, :8080 → :80)
  └─ /api/* → api-next (:3101)
                    ├─ content-next (:3016)
                    └─ storage-next (:3017) ──▶ minio:9000

learning-next ──▶ storage-next
content-next  ──▶ pi-chat-runtime (:3105，仅 Compose 内网)
pi-chat-runtime ├─▶ content-next
                └─▶ storage-next
```

PostgreSQL、Pi 和领域服务不向公网映射端口。浏览器通过同源 `/api/*` 请求对象授权后，
直接访问 `MINIO_PUBLIC_ENDPOINT` 的短时效预签名 URL；因此 MinIO API 必须由受控反代或
专用域名对浏览器可达，并只允许配置的 CORS origin。

## 首次切换顺序

以下命令中的 dump 路径使用临时目录，完成并核验后再清理。不要使用
`docker compose down -v`。

1. 在开发机分别对 `mathpilot`、`mathpilot_pi` 执行 `pg_dump -Fc --no-owner --no-acl`。
2. 打包 `~/.mathpilot/runtime`，保留 `agent/sessions`、`sessions` 和附件状态目录。
3. 推送 Git 的 `next` 分支，并把同一提交同步到 `/srv/stacks/mathpilot`；远端
   `deploy/dev/.env` 单独保留。
4. 在远端 `deploy/dev/.env` 明确设置：

   ```dotenv
   MATHPILOT_ENVIRONMENT=production
   DEFAULT_TENANT_ID=<production-tenant-id>
   # 可选多租户 worker 覆盖；省略时使用 DEFAULT_TENANT_ID
   LEARNING_NEXT_TENANT_IDS=
   POSTGRES_VOLUME=mathpilot_pgdata_next
   PI_CHAT_RUNTIME_VOLUME=mathpilot_pi_chat_runtime
   MINIO_VOLUME=mathpilot_minio_data
   MINIO_PUBLIC_ENDPOINT=https://mathpilot.tangentpi.com
   MINIO_CORS_ALLOWED_ORIGINS=https://mathpilot.tangentpi.com
   MATHPILOT_INTERNAL_REPLAY_MODE=memory-single-replica
   # 以下六项必须使用六份独立随机 key；示例故意保留占位符
   BETTER_AUTH_SECRET=
   LEARNING_EVIDENCE_SECRET=
   MATHPILOT_INTERNAL_API_TO_CONTENT_KEYRING={"active":"prod-v1","keys":{"prod-v1":"<base64url-32-to-64-random-bytes>"}}
   MATHPILOT_INTERNAL_API_TO_STORAGE_KEYRING={"active":"prod-v1","keys":{"prod-v1":"<base64url-32-to-64-random-bytes>"}}
   MATHPILOT_INTERNAL_CONTENT_TO_PI_KEYRING={"active":"prod-v1","keys":{"prod-v1":"<base64url-32-to-64-random-bytes>"}}
   MATHPILOT_INTERNAL_PI_TO_CONTENT_KEYRING={"active":"prod-v1","keys":{"prod-v1":"<base64url-32-to-64-random-bytes>"}}
   MATHPILOT_INTERNAL_PI_TO_STORAGE_KEYRING={"active":"prod-v1","keys":{"prod-v1":"<base64url-32-to-64-random-bytes>"}}
   MATHPILOT_INTERNAL_LEARNING_TO_STORAGE_KEYRING={"active":"prod-v1","keys":{"prod-v1":"<base64url-32-to-64-random-bytes>"}}
   ```

   `BETTER_AUTH_SECRET`、`LEARNING_EVIDENCE_SECRET` 与六条内部边的 key material 全部独立。
   key ID 为 1–32 位字母数字、点、下划线或连字符；每个 keyring 最多包含一个 active 和
   两个 previous key。生产预检拒绝缺失项、非规范 base64url、少于 32 或多于 64 字节、
   任意跨边复用，以及 development/test fixture key。各服务只接收自己 touching edges
   的 keyring 和出站 URL，不存在共享万能 secret、主体头或环境变量 fallback。

   当前 replay store 是进程内单副本实现。生产必须显式声明
   `memory-single-replica`，且在接入共享 replay store 前不得横向扩容任一接收服务。

5. 仅启动新 PostgreSQL 容器，确认它实际挂载 `mathpilot_pgdata_next`，再创建并恢复两个数据库。
6. 把 Pi runtime 归档解入 `mathpilot_pi_chat_runtime` 的卷根。
7. 运行 `pi-db-migrate`，使 schema 幂等收敛并向 `mathpilot_app` 授最小权限。
8. 构建并启动 `minio`、`storage-next`、`content-next`、`pi-chat-runtime`、`learning-next`、`api`、`web`。
9. 先运行官方导入 dry-run 并审核报告，再加 `--execute` 导入固定清单；确认 174 个修订和
   `pkg_official_home_v1` 后才切流。其余领域服务与旧 `agent-runtime` 保留原职责。

正式启动前先运行以下不回显密钥值的门禁：

```sh
set -e
docker compose --env-file deploy/dev/.env -f deploy/dev/compose.yaml config --quiet
docker compose --env-file deploy/dev/.env -f deploy/dev/compose.yaml run \
  --rm --no-deps internal-identity-preflight
docker compose --env-file deploy/dev/.env -f deploy/dev/compose.yaml run \
  --rm --no-deps --build --quiet-build --quiet -T api \
  corepack pnpm --filter @mathpilot/api-next run preflight:production
```

第二条命令在只读、无网络、无 capability 的一次性容器中验证全部六条边；第三条验证 API
自身的 Better Auth、evidence 与默认租户配置。任一门禁失败都阻止五个生产服务启动；错误只
报告配置名和规则，不回显 key material。

## 内部 edge key 轮换

每条边独立轮换，不能同时把调用方和接收方直接切到一把只有新 key 的 keyring：

1. 先把接收方部署为 `active=new` 且同时接受 `old,new`；此时尚未更新的调用方仍可用 old。
2. 再用同一 keyring 部署调用方；新请求只由 new 签发，回滚仍可使用 old。
3. 等待断言 TTL 60 秒加 5 秒时钟容差，并确认没有 `assertion_previous_key_verified` 观测后，
   从该边两端移除 old。

轮换只改变 keyring 内容，不改变 loader、codec、header、验证器或领域 adapter。每次部署仍先
运行全拓扑 preflight，避免把同一 key material 误配给另一条边。

## 切换前后核验

- `docker volume inspect mathpilot_pgdata` 仍成功，且没有容器把它作为新 PostgreSQL 写入卷。
- 新 PostgreSQL 同时存在 `mathpilot` 和 `mathpilot_pi`。
- 新主库的迁移表、Better Auth `user/session/account`、身份表和既有学习数据存在。
- `mathpilot_pi.pi_threads` 数量与开发机一致；对应 JSONL 和工作区存在于 Pi runtime 卷。
- `web` 仅反代 `api-next`；API 只走 API→Content/Storage 两条边，Pi 只由 Content 调度。
- 未登录主页可见；首次发送要求登录；登录后旧线程可读、新线程可建、消息可发送。
- 图片与普通文件在消息中可见且可下载；对象存在 MinIO，Pi JSONL/工作区仍在 runtime 卷。
- `content_entity_revision` 与官方包项均为 174；`student_cases.*` 未进入官方内容库。
- 浏览器 PUT/GET 的响应体不经过 api-next，数据库没有保存预签名 URL。

若此前误执行过废弃的六个纯增量内容迁移，只能按 [`db/cutover/README.md`](../db/cutover/README.md)
处理：空对象可用受保护脚本清理；已有数据时停止并换用核验过的新卷，禁止猜测性删除。

## 2026-08-30 切换基线

- 切换前远端旧数据库卷：`mathpilot_pgdata`，只含数据库 `mathpilot`。
- 开发机 Pi 库：9 条线程记录、0 条 MinIO 归档引用。
- 开发机 Pi runtime 目录约 7 MiB；因此本次迁移以数据库与 runtime 文件联合快照为准。

## 2026-08-30 实际执行结果

- 部署代码提交：`b84ce21`（`next` 分支已推送到 `origin`）。
- 旧展开源码保存为 `/srv/stacks/mathpilot-source-pre-next-20260830`。
- 旧数据库卷 `mathpilot_pgdata` 仍存在，切换后挂载容器数为 0。
- 新 PostgreSQL 实际挂载 `mathpilot_pgdata_next`；主库迁移收敛到 30 条，领域用户 4 个。
- 新 Pi 库保留 9 条线程；`pi_card_events` 由 `pi-db-migrate` 创建，初始事件数为 0。
- `mathpilot_app` 注入租户/用户 GUC 后可通过强制 RLS 读取 9 条所属线程。
- Pi runtime 实际挂载 `mathpilot_pi_chat_runtime`，恢复约 6.9 MiB、23 个工作区目录。
- MinIO 实际挂载 `mathpilot_minio_data`，镜像固定为
  `quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z`。
- `web`、`api-next`、`pi-chat-runtime`、MinIO 与 PostgreSQL 均为 running；首页和
  `/api/auth/get-session` 均返回 HTTP 200。
- 两端包含 dump、Pi 会话副本和开发凭据的临时迁移目录已删除。

## home 构建使用本机 7897 代理

只有远端下载明显停滞时才建立临时反向隧道：

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -R 127.0.0.1:17897:127.0.0.1:7897 home
```

Docker 构建使用 host 网络访问这个仅绑定远端 loopback 的端口，并通过 build args 注入
`HTTP_PROXY/HTTPS_PROXY=http://127.0.0.1:17897`。代理仅用于构建层，禁止写入 Compose
运行环境。构建结束立即终止 SSH 隧道。
