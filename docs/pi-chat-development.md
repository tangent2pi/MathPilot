# Pi 对话与鉴权开发运行

本链路只用于 `web-next` 开发入口，不修改正式 Web，也不依赖 Docker/Compose。

## 数据边界

- `DATABASE_URL`：既有 MathPilot 主业务库，Better Auth、用户、租户与师生绑定的事实源。
- `PI_DATABASE_URL`：新建的独立空库，只执行 `src/apps/web-next/db/migrations/`，保存线程归属、Pi session/工作区位置、ACL 与 MinIO 索引。
- Pi JSONL 与工作区仍是会话事实源；MinIO 归档二者，不把消息复制进 PostgreSQL。

## 初始化独立 Pi 库

```sh
nix develop -c createdb mathpilot_pi
PI_DATABASE_URL=postgres://localhost:5432/mathpilot_pi \
  nix develop -c pnpm --filter @mathpilot/web-next db:migrate
```

迁移启用并强制 RLS。`agent-runtime` 会在每次数据库事务内注入网关已验证的 `mathpilot.tenant_id`、`mathpilot.user_id`、角色与有效师生范围。

## 启动三个开发进程

三端必须使用相同、至少 32 字符的 `PI_GATEWAY_SECRET`：

```sh
DATABASE_URL=postgres://localhost:5432/mathpilot \
BETTER_AUTH_URL=http://localhost:5174 \
BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:5174 \
PI_GATEWAY_SECRET=replace-with-a-development-secret-at-least-32-chars \
  nix develop -c pnpm --filter @mathpilot/api start
```

```sh
PI_DATABASE_URL=postgres://localhost:5432/mathpilot_pi \
PI_GATEWAY_SECRET=replace-with-a-development-secret-at-least-32-chars \
MODEL_API_BASE=https://api.deepseek.com \
MODEL_ID=deepseek-v4-flash-vision-exp \
MODEL_API_KEY=... \
MINIO_ENDPOINT=127.0.0.1:9000 \
MINIO_ACCESS_KEY=... \
MINIO_SECRET_KEY=... \
  nix develop -c pnpm --filter @mathpilot/agent-runtime start
```

Pi 对话只读取 `MODEL_ID`，不读取既有批处理 runtime 的
`MODEL_ID_MAIN/MODEL_ID_AUX`。切换模型或兼容端点只需调整上述环境变量并重启；
runtime 会据此生成 Pi 原生 `models.json/auth.json`，会话仍按原 JSONL 恢复。

```sh
nix develop -c pnpm --filter @mathpilot/web-next dev
```

浏览器只访问 `http://localhost:5174/api/*`。Vite 将同源请求代理给 API 网关；浏览器不接触服务密钥、模型密钥或 runtime 地址。
