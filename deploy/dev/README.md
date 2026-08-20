# deploy/dev — 全模块组合根（实施规划 §4）

一条命令启动本地组合环境：

```sh
test -d references/qwen-mm-plugins/.git || git clone https://github.com/QwenLM/Qwen-MM-Plugins.git references/qwen-mm-plugins
git -C references/qwen-mm-plugins checkout dd029da3bcadfe497de4b4ca8976b11177997cf0
cd deploy/dev
cp .env.example .env        # 按需修改
docker compose up -d
```

`references/qwen-mm-plugins` 是构建输入，不在镜像构建时联网下载另一份源码。Agent Runtime
从该固定提交安装 Core/Search，并把上游 Core、Search、Edu Agent 与数学智元的六个产品
Skill 装配为唯一的 `/opt/agmath-skills`。本地克隆提交与固定 revision 不一致时，装配测试会失败。

## 当前覆盖

- **postgresql**：唯一事实源（`db-migrate` 幂等迁移 job + `db-seed` dev 种子；RLS + 不可变事件 trigger + 列级处理元数据守卫）
- **持久卷**：原始文档、Artifact、Agent 工作区和 Pi Session 分别进入明确的本地命名卷。
- **全部 6 服务 + 正式 web 已启用**：api（Better Auth Session + 角色门）、learning（教学闭环，题目只读已发布章节包）、profile（Dream 消费 + Validator + 快照）、review（纠正 supersede + 重放 + 修订 SLR 入队）、content（原件→KTQ 按需 OCR→独立 ER→本批复核→发布 + 字段血缘）、agent-runtime（统一 Pi Agent Harness 宿主）、web（nginx 同源反代）。

## 鉴权

- 登录、密码哈希、Session Cookie、CSRF 与 Origin 校验由 Better Auth 负责；领域角色和租户在 API 服务端映射。
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

## 模型调用路径（设计 §4.3）

```
learning/content/profile ──HTTP──▶ agent-runtime（Pi 宿主）
                                     ├─ pi-agent-core：每任务独立 Agent Session（一任务一 Session，租户绑定）
                                     │   ├─ task prompt = policies/ 版本化任务目标（tasks.manifest.json 注册）
                                     │   ├─ Skills = 标准 SKILL.md 树（由 ResourceLoader 自动发现）
                                     │   ├─ model = pi-ai（scnet provider：Qwen3.8-Max 主 / DeepSeek-V4-Flash-0731 辅）
                                     │   └─ tools = Bash + Qwen-MM Core/Search + PaddleOCR-VL + respond
                                     └─ 密钥：agent-runtime 直读本服务 env；领域服务经 @mathpilot/providers-model
```

- 任务提示/纪律全部在仓库 `policies/`（版本化策略源，manifest 统一管理 prompt_version 与主/辅模型角色）；
  模型行为只通过策略、Skills 与工作区文件控制，Agent 循环内无动作限制逻辑；Pi 本体零修改（SDK 扩展接入）。

## 供应商密钥（.env；只注入使用该 Provider 的宿主服务，绝不入库、不进沙箱/前端）

```sh
MODEL_API_BASE=https://api.scnet.cn/api/llm/v1
MODEL_API_KEY=<scnet-key>
MODEL_ID_MAIN=Qwen3.8-Max
MODEL_ID_AUX=DeepSeek-V4-Flash-0731
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
