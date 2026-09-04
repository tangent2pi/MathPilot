# deploy/dev — Next 本地组合根

本目录只启动 MathPilot Next / science-v3 正式链路。旧 `learning`、`profile`、
`content`、`review`、`agent-runtime` 不在组合中，也不会作为回退路径启动。

## 启动

`pi-chat-runtime` 的内容候选工具仍需要仓库内固定版本的 Qwen-MM-Plugins 参考副本：

```sh
test -d references/qwen-mm-plugins/.git || git clone https://github.com/QwenLM/Qwen-MM-Plugins.git references/qwen-mm-plugins
git -C references/qwen-mm-plugins checkout dd029da3bcadfe497de4b4ca8976b11177997cf0
cd deploy/dev
test -f .env || cp .env.example .env
docker compose up -d --build
```

默认 Web 地址是 <http://127.0.0.1:8080>。开发账号由 `.env` 中的
`BETTER_AUTH_*_EMAIL/PASSWORD` 创建。

默认 PostgreSQL 卷是 `mathpilot_pgdata_next`；旧 `mathpilot_pgdata` 不会被打开、
迁移或删除。启动时会从 `db/migration-data/official-content-manifest.csv` 自动、幂等地
导入 home 已审核提取的 174 条 K/T/Q/E/R 内容。导入器只读这些 CSV，不读取旧表；
无法追溯的 owner 统一设为 `DEFAULT_TEACHER_USER_ID`，本地默认是唯一教师
`usr_teacher01`。

## 正式链路

```text
browser / assistant-ui
        │
        ▼
web-next / React Pi ──same-origin──▶ api-next
                                      │
                                      ├─atomic admission──▶ PostgreSQL canonical facts/read models
                                      ├─signed api-to-pi──▶ pi-chat-runtime / Pi AgentSession
                                      │                         │ native snapshot + SSE stream
                                      │                         └─signed pi-to-learning──▶ learning-next
                                      │                                                   └─atomic final commit──▶ PostgreSQL
                                      ├───────────────▶ content-next ──▶ normalized official/teacher content
                                      └───────────────▶ storage-next ──▶ MinIO

PostgreSQL background outbox ──▶ Temporal ──▶ learning-next background activities
```

前台学习对话由 Pi AgentSession 管理文本、reasoning、工具事件、取消和断线重连；
PostgreSQL 仍是规范消息、学习动作和最终结果的唯一事实源。前台不进入 Temporal，
Dream、选题、判定等后台任务继续由 Temporal 管理。当前部署契约为
`memory-single-replica`，前台思考等级固定为 `high`。

前台对话和 `reasoning` 任务使用主模型，`fast` 任务使用副模型；当前两者都配置为
`deepseek-v4-flash-vision-exp`。端点、密钥和两个模型 ID 均由环境变量显式注入，
运行时代码及 Compose 不提供隐藏回退：

```sh
PI_MODEL_API_BASE=https://api.deepseek.com
PI_MODEL_API_KEY=<provider-key>
PI_MODEL_ID_MAIN=deepseek-v4-flash-vision-exp
PI_MODEL_ID_AUX=deepseek-v4-flash-vision-exp
```

本地 `.env` 也可使用不带 `PI_` 前缀的 `MODEL_API_BASE`、`MODEL_API_KEY`、
`MODEL_ID_MAIN`、`MODEL_ID_AUX`；显式 `PI_MODEL_*` 时优先。两个 Next runtime 都使用
Pi 的 `openai-responses` provider 访问官方 DeepSeek Responses API。

## MinIO 浏览器端点

`MINIO_ENDPOINT=http://minio:9000` 只在 Compose 内部使用。浏览器签名 URL 和 CORS
由部署变量控制：

```sh
# 本地
MINIO_PUBLIC_ENDPOINT=http://localhost:9000
MINIO_CORS_ALLOWED_ORIGINS=http://localhost:8080

# mathpilot.tangentpi.com 反代部署
MINIO_PUBLIC_ENDPOINT=https://mathpilot.tangentpi.com
MINIO_CORS_ALLOWED_ORIGINS=https://mathpilot.tangentpi.com
```

生产部署同时需要 HTTPS Better Auth URL、Secure Cookie、准确的 Trusted Origins，
以及替换全部开发 secret。供应商密钥只进入需要它的宿主服务，不进入浏览器、数据库
或模型工具沙箱。

## 快速核验

```sh
docker compose config --quiet
docker compose ps
curl --fail http://127.0.0.1:3101/readyz
docker compose exec -T postgres psql -U mathpilot -d mathpilot -c \
  "select count(*) as official_items from content_package_item where package_id='pkg_official_home_v1';"
```

正式导入结果应为 174 项，其中 84 项是题目。外部模型、搜索或 OCR 不可用时返回真实
错误，不生成假结果或回退到旧服务。
