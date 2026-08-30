# home：next 对话实现容器部署与数据复制

目标主机为 `home`，部署根为 `/srv/stacks/mathpilot`，唯一 Compose 根为
`deploy/dev/compose.yaml`。

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
  └─ /api/* → api (api-next, :3101)
                    └─ pi-chat-runtime (:3105, 仅 Compose 内网)
                         ├─ postgres/mathpilot_pi
                         ├─ pi_chat_runtime volume
                         └─ minio:9000 → minio_data volume

learning/content/profile → agent-runtime :3005（保留的旧批处理链）
```

PostgreSQL、MinIO 与 `pi-chat-runtime` 不向公网映射端口。Nginx 对 SSE 关闭代理缓冲，
浏览器继续只访问同源 `/api/*`。

## 首次切换顺序

以下命令中的 dump 路径使用临时目录，完成并核验后再清理。不要使用
`docker compose down -v`。

1. 在开发机分别对 `mathpilot`、`mathpilot_pi` 执行 `pg_dump -Fc --no-owner --no-acl`。
2. 打包 `~/.mathpilot/runtime`，保留 `agent/sessions`、`sessions` 和附件状态目录。
3. 推送 Git 的 `next` 分支，并把同一提交同步到 `/srv/stacks/mathpilot`；远端 `.env` 单独保留。
4. 在远端 `.env` 明确设置：

   ```dotenv
   POSTGRES_VOLUME=mathpilot_pgdata_next
   PI_CHAT_RUNTIME_VOLUME=mathpilot_pi_chat_runtime
   MINIO_VOLUME=mathpilot_minio_data
   ```

5. 仅启动新 PostgreSQL 容器，确认它实际挂载 `mathpilot_pgdata_next`，再创建并恢复两个数据库。
6. 把 Pi runtime 归档解入 `mathpilot_pi_chat_runtime` 的卷根。
7. 运行 `pi-db-migrate`，使 schema 幂等收敛并向 `mathpilot_app` 授最小权限。
8. 构建并启动 `minio`、`pi-chat-runtime`、`api`、`web`；其余领域服务与旧
   `agent-runtime` 保留原职责。

## 切换前后核验

- `docker volume inspect mathpilot_pgdata` 仍成功，且没有容器把它作为新 PostgreSQL 写入卷。
- 新 PostgreSQL 同时存在 `mathpilot` 和 `mathpilot_pi`。
- 新主库的迁移表、Better Auth `user/session/account`、身份表和既有学习数据存在。
- `mathpilot_pi.pi_threads` 数量与开发机一致；对应 JSONL 和工作区存在于 Pi runtime 卷。
- `web` 仅反代 `api-next`；`api-next` 只通过内部地址访问 `pi-chat-runtime`。
- 未登录主页可见；首次发送要求登录；登录后旧线程可读、新线程可建、消息可发送。
- 图片与普通文件在消息中可见且可下载；归档后 MinIO 中出现 `pi-threads/<thread-id>/`。

## 2026-08-30 切换基线

- 切换前远端旧数据库卷：`mathpilot_pgdata`，只含数据库 `mathpilot`。
- 开发机 Pi 库：9 条线程记录、0 条 MinIO 归档引用。
- 开发机 Pi runtime 目录约 7 MiB；因此本次迁移以数据库与 runtime 文件联合快照为准。
