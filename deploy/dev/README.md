# deploy/dev — 全模块组合根（实施规划 §4）

一条命令启动本地组合环境：

```sh
test -d references/qwen-mm-plugins/.git || git clone https://github.com/QwenLM/Qwen-MM-Plugins.git references/qwen-mm-plugins
git -C references/qwen-mm-plugins checkout dd029da3bcadfe497de4b4ca8976b11177997cf0
cd deploy/dev
cp .env.example .env        # 按需修改
docker compose up -d
```

默认 Web 只监听 `127.0.0.1:8080`。远端部署时在 `.env` 中把
`WEB_BIND_ADDRESS` 设置为反向代理可达的专用地址；数据库和内部服务仍不对外暴露。

`web` 与 `api` 现在分别构建 `web-next`、`api-next`；`pi-chat-runtime` 是独立的
assistant-ui/react-pi 线程宿主。旧 `agent-runtime` 仍只承载 learning/content/profile
批处理任务，禁止把两套运行时重新合并。home 的首次数据切换严格按
[`docs/home-next-deployment.md`](../../docs/home-next-deployment.md) 执行。

`references/qwen-mm-plugins` 是构建输入，不在镜像构建时联网下载另一份源码。Agent Runtime
从该固定提交安装 Core/Search，并把上游 Core、Search、Edu Agent 与数学智元的六个产品
Skill 装配为唯一的 `/opt/mathpilot-skills`。本地克隆提交与固定 revision 不一致时，装配测试会失败。

## 当前覆盖

- **PostgreSQL**：`mathpilot` 保存身份/学习/审计；`mathpilot_pi` 只保存线程归属、ACL、卡片事件和文件位置。两库在同一 PostgreSQL 实例中，事实边界不合并。
- **对象与运行时持久化**：活动 Pi JSONL/工作区使用 `PI_CHAT_RUNTIME_VOLUME`；归档使用内部 MinIO 的 `MINIO_VOLUME`；数据库使用 `POSTGRES_VOLUME`。
- **正式对话链**：web-next（assistant-ui）→ api-next（Better Auth + 线程授权）→ pi-chat-runtime（官方 Pi Thread）→ PostgreSQL/MinIO。
- **既有领域链保留**：learning、profile、review、content 与旧 agent-runtime 维持原职责，本阶段不接“下一题” fork、后台判答或 Dream 到新对话链。

## 鉴权

- 登录、密码哈希、Session Cookie、CSRF 与 Origin 校验由 api-next 中的 Better Auth 负责；领域角色和租户在网关服务端映射。
- 学生请求强制使用本人范围；教师只能查看已绑定学生和本人内容库；管理员才能发布公共内容。
- Nginx 覆盖写入 `X-Real-IP`，Better Auth 用该地址执行限流。开发环境的 API、Agent Runtime 和数据库端口只绑定本机。
- 开发账号由 `.env` 中的 `BETTER_AUTH_*_EMAIL/PASSWORD` 创建。生产部署需要替换 Secret，使用 HTTPS URL、Secure Cookie 和准确的 Trusted Origins，并让领域服务只在私网监听。

## 验证

```sh
bash ../../tests/e2e/current-state-smoke.sh     # 不调用模型/OCR，保留当前数据
bash ../../tests/e2e/draft-file-edit-smoke.sh   # 待确认资料集追加/移除；测试对象自动清理
bash ../../tests/e2e/content-scope-smoke.sh     # 公共库/教师库隔离
docker compose exec -T agent-runtime sh /app/tests/e2e/agent-db-sandbox-smoke.sh
set -a; . ./.env; set +a
: "${BETTER_AUTH_TEACHER_EMAIL:=teacher@mathpilot.local}"; : "${BETTER_AUTH_TEACHER_PASSWORD:=MathPilotTeacher123!}"
: "${BETTER_AUTH_STUDENT_EMAIL:=student@mathpilot.local}"; : "${BETTER_AUTH_STUDENT_PASSWORD:=MathPilotStudent123!}"
docker compose exec -T \
  -e VISUAL_EMAIL="$BETTER_AUTH_TEACHER_EMAIL" -e VISUAL_PASSWORD="$BETTER_AUTH_TEACHER_PASSWORD" \
  -e VISUAL_STUDENT_EMAIL="$BETTER_AUTH_STUDENT_EMAIL" -e VISUAL_STUDENT_PASSWORD="$BETTER_AUTH_STUDENT_PASSWORD" \
  agent-runtime node --input-type=module < ../../tests/e2e/browser-visual-smoke.mjs
bash ../../tests/e2e/real-smoke.sh              # 真实端到端；会产生模型/OCR费用
```

真实端到端覆盖：教师确认资料 → KTQ 独立 Session → ER 独立 Session → 复核门；以及教学判答、连续学习摘要、Dream 和计划。OCR 是否调用由 Agent 根据原件质量和版面复杂度决定。

## 模型调用路径

```
learning/content/profile ──HTTP──▶ agent-runtime（Pi 宿主）
                                     ├─ pi-agent-core：每任务独立 Agent Session（一任务一 Session，租户绑定）
                                     │   ├─ task prompt = policies/ 版本化任务目标（tasks.manifest.json 注册）
                                     │   ├─ Skills = 标准 SKILL.md 树（由 ResourceLoader 自动发现）
                                     │   ├─ model = pi-ai（scnet provider：Qwen3.8-Max 主 / DeepSeek-V4-Flash-0731 辅）
                                     │   └─ tools = Bash + Qwen-MM Core/Search + PaddleOCR-VL + respond
                                     └─ 密钥：agent-runtime 直读本服务 env；领域服务经 @mathpilot/providers-model

browser ──同源──▶ api-next ──受信主体头──▶ pi-chat-runtime
                                               ├─ @assistant-ui/react-pi 官方线程协议
                                               ├─ MODEL_API_BASE / MODEL_ID / MODEL_API_KEY
                                               └─ extensions + skills 插件式注入（Pi 本体零修改）
```

- 任务提示/纪律全部在仓库 `policies/`（版本化策略源，manifest 统一管理 prompt_version 与主/辅模型角色）；
  模型行为只通过策略、Skills 与工作区文件控制，Agent 循环内无动作限制逻辑；Pi 本体零修改（SDK 扩展接入）。

## 供应商密钥（.env；只注入使用该 Provider 的宿主服务，绝不入库、不进沙箱/前端）

```sh
MODEL_API_BASE=https://api.scnet.cn/api/llm/v1
MODEL_API_KEY=<scnet-key>
MODEL_ID_MAIN=Qwen3.8-Max
MODEL_ID_AUX=DeepSeek-V4-Flash-0731
PI_GATEWAY_SECRET=<32+ character shared secret>
PI_MODEL_API_BASE=https://api.deepseek.com
PI_MODEL_API_KEY=<deepseek-key>
PI_MODEL_ID=deepseek-v4-flash-vision-exp
MINIO_ROOT_USER=<internal-access-key>
MINIO_ROOT_PASSWORD=<internal-secret-key>
OCR_API_BASE=https://paddleocr.aistudio-app.com
OCR_API_TOKEN=<paddleocr-token>
OCR_MODEL=PaddleOCR-VL-1.6
SERPER_API_KEY=<serper-key>
```

- 无任何 fake/回退路径：模型不可用（配额/网络）时各服务显式 502，绝不伪造结果；
  题目未发布/不可达时 learning 显式 404/502，无内置兜底题（Review-001"严禁回退方案"）。
- 多租户：agent-runtime 会话创建时绑定租户，prompt/查询/销毁跨租户一律 403；
  PostgreSQL RLS + 不可变事件触发器；Better Auth Session 只在 API 网关解析。
- Dream 模型声明 `review_required` 时升级教师复核（student_diagnosis 队列），不物化快照（设计 §9.3）。

## 约定

单一组合根：**禁止**复制出 demo/competition 第二套组合根。任何 Provider 实现（含未接入的本地/MCP/自建模式）必须产生与正式实现同构的 ProviderTrace 字段。
