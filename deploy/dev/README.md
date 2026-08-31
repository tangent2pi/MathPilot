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
web-next ──same-origin──▶ api-next ──▶ PostgreSQL science-v3 facts/read models
                                  │
                                  ├─outbox──▶ Temporal ──▶ learning-next ──▶ fixed DeepSeek model
                                  ├────────▶ content-next ──▶ normalized official/teacher content
                                  └────────▶ storage-next ──▶ MinIO

pi-chat-runtime ──▶ content-next candidate work only
```

学习对话不经过 `pi-chat-runtime`。后台与前台模型调用都固定使用
`deepseek-v4-flash-vision-exp`；不得改成旧主/辅模型。新的环境变量是：

```sh
PI_MODEL_API_BASE=https://api.scnet.cn/api/llm/v1
PI_MODEL_API_KEY=<provider-key>
```

已有本地 `.env` 若仍保存为 `MODEL_API_BASE`/`MODEL_API_KEY`，Compose 会直接把这两个
现有值注入 Next 服务，不改写密钥文件；显式 `PI_MODEL_API_BASE`/`PI_MODEL_API_KEY`
时以新变量为准。模型 ID 在组合中固定，不从本地旧变量读取。

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
