# deploy/dev — 全模块组合根（实施规划 §4）

一条命令启动本地组合环境：

```sh
cd deploy/dev
cp .env.example .env        # 按需修改
docker compose up -d
```

## 当前覆盖

- **postgresql**：唯一事实源（`db-migrate` 幂等迁移 job + `db-seed` dev 种子；RLS + 不可变事件 trigger + 列级处理元数据守卫）
- **minio**：对象存储（原始文档、笔迹流、Artifact、Session 归档）
- **keycloak**：OIDC 认证（realm 见 `keycloak/realm-agmath.json`；healthcheck 探测 realm well-known）
- **otel-collector**：trace 贯通 API/Session/Provider/Decision
- **全部 6 服务 + web-test 已启用**（设计 §2.4 模块清单）：api（OIDC 验签 + JIT 用户映射 + 角色门）、learning（教学闭环，题目只读已发布章节包）、profile（Dream 消费 + Validator + 快照）、review（纠正 supersede + 重放 + 修订 SLR 入队）、content（文档→OCR→KTQ/ER 双 Session→复核门→发布 + 字段血缘）、agent-runtime（Pi Agent Harness 宿主）、web-test（nginx 同源反代）

## 鉴权（WP-03）

- 带 `Authorization: Bearer` 的请求严格验签（issuer + JWKS + exp），principal 的
  tenant/user/roles 来自服务端；学生角色强制自域，教师端点要求 teacher 角色。
- 无 token 且 `AUTH_DEV_FALLBACK=true`（默认）时走 dev 直通，保持流程验证可用；
  **生产必须置 `AUTH_DEV_FALLBACK=false`（无 token 即 401）并移除 realm 中的
  `agmath-dev-cli` 客户端（password grant 仅供 dev smoke 取 token）**。
- dev 账号：`teacher.dev` / `student.dev`，密码 `dev-only`。

## 验证

```sh
bash ../../tests/e2e/real-smoke.sh   # 端到端（需 .env 配真实 key，见下）
```

覆盖：Teaching Agent 模型主判（经 Pi Session；正例 correct / 负例漏补角分支）→
PaddleOCR 真实解析赛题 PDF → KTQ/ER 抽取 Agent（经 Pi，独立 Session + 字段血缘）→ Dream。

## 模型调用路径（设计 §4.3）

```
learning/content/profile ──HTTP──▶ agent-runtime（Pi 宿主）
                                     ├─ pi-agent-core：每任务独立 Agent Session（一任务一 Session，租户绑定）
                                     │   ├─ systemPrompt = policies/ 策略源编译的 AGENTS.md（tasks.manifest.json 注册）
                                     │   ├─ model = pi-ai（scnet provider：Qwen3.8-Max 主 / DeepSeek-V4-Flash-0731 辅）
                                     │   └─ tools = [respond]（结构化输出）
                                     └─ 密钥：agent-runtime 直读本服务 env；领域服务经 @agmath/providers-model
```

- 任务提示/纪律全部在仓库 `policies/`（版本化策略源，manifest 统一管理 prompt_version 与主/辅模型角色）；
  模型行为只通过策略、Skills 与工作区文件控制，Agent 循环内无动作限制逻辑；Pi 本体零修改（SDK 扩展接入）。

## 供应商密钥（.env；只注入使用该 Provider 的宿主服务，绝不入库、不进沙箱/前端）

```sh
MODEL_API_BASE=https://api.scnet.cn/api/llm/v1
MODEL_API_KEY=sk-tp-…          # scnet 临时 key（Token Plan 配额；耗尽返回 429 quota exceeded）
MODEL_ID_MAIN=Qwen3.8-Max
MODEL_ID_AUX=DeepSeek-V4-Flash-0731
OCR_API_BASE=https://paddleocr.aistudio-app.com
OCR_API_TOKEN=b9e428ee…        # PaddleOCR 官方 API
OCR_MODEL=PaddleOCR-VL-1.6
```

- 试点题数值经真实模型复核（两解条件 b·sinA < a < b 必须成立）。
- 无任何 fake/回退路径：模型不可用（配额/网络）时各服务显式 502，绝不伪造结果；
  题目未发布/不可达时 learning 显式 404/502，无内置兜底题（Review-001"严禁回退方案"）。
- 多租户：agent-runtime 会话创建时绑定租户，prompt/查询/销毁跨租户一律 403；
  PostgreSQL RLS + 不可变事件触发器；OIDC 路径 principal 来自服务端。
- Dream 模型声明 `review_required` 时升级教师复核（student_diagnosis 队列），不物化快照（设计 §9.3）。

## 约定

单一组合根：**禁止**复制出 demo/competition 第二套组合根。任何 Provider 实现（含未接入的本地/MCP/自建模式）必须产生与正式实现同构的 ProviderTrace 字段。
