# 数学智元（MathPilot）— 高中数学知识掌握诊断与学习规划 Agent

数学智元（MathPilot）是一套面向高中数学学习与教学管理的**证据型诊断教学系统**：聊天式一题一诊断 + 错因归因追问 + 传统程序科学基准
（BKT/保持率）+ Dream 画像大模型最终更新 + 1-4 周学习计划。

## 产品定位（一句话）

> 学生以聊天 + 可选草稿做题，每次作答变成可追溯的判定、程序基准与教学总结；
> 跨题证据由画像模型整理成可展开的状态与计划；教师复核内容与诊断，改判以
> "取代 + 重放"呈现，让每个结论都能回到原始学习证据。

## 核心设计

| 设计要点 | 位置 |
|---|---|
| 设计宪法与完整规格 | `design-docs/系统设计v3.3-…md`、`架构修订v4`、`科学内核与Dream设计v1` |
| 产品决策与需求溯源 | `design-docs/产品重构基线v1-用户任务与信息架构.md` |
| 用户呈现形式（界面规格） | `design-docs/用户呈现形式v1` |
| 标准运行时 Skills | `/opt/mathpilot-skills` 统一九项树；数学智元六项源于 `src/services/agent-runtime/skills/`，Core/Search/Edu 源于固定 Qwen-MM 本地克隆 |
| 任务策略源 | `policies/`（只管理任务目标、prompt_version 与主/辅模型角色） |
| 算法侧车（pyBKT） | `sidecars/pybkt/`（ADR-001：Python 只作算法侧车） |

## 架构

```text
apps/web-next（正式对话前端：assistant-ui Thread / ThreadList / Generative UI）
services/api-next（Better Auth 网关与账户/线程授权）
services/pi-chat-runtime（自托管 react-pi 线程宿主：Pi JSONL/工作区/附件/卡片）
services/content-next（新对话的规范化 K/T/Q/E/R、候选复核、ER handoff、内容包）
services/storage-next（私有 MinIO 对象登记、校验、浏览器预签名直传直下）
services/agent-runtime（既有批处理 Pi 宿主；不承载 next 对话线程）
services/content（旧 learning 链保留实现；不作为 Next 内容事实入口）
services/learning（一题一 Session：判答→错因归因→追问卡→双产物）
services/profile（画像采集→Dream 三段式（pyBKT Roster 基准+画像大模型）→快照/计划）
services/review（教师复核：supersede+重放+修订 SLR）
packages/contracts（21 契约 schema） mastery（OATutor 移植+保持率） selector（选题） providers/{model,ocr}
db/（主 PostgreSQL：身份/学习/审计）+ mathpilot_pi（线程归属/ACL/卡片事件）+ MinIO（归档）
```

## 快速启动（开发环境）

```sh
nix develop            # 进入开发环境（python312+gcc 用于侧车）
test -d references/qwen-mm-plugins/.git || git clone https://github.com/QwenLM/Qwen-MM-Plugins.git references/qwen-mm-plugins
git -C references/qwen-mm-plugins checkout dd029da3bcadfe497de4b4ca8976b11177997cf0
cd deploy/dev && cp .env.example .env   # 配置 MODEL_API_KEY / OCR_API_TOKEN
docker compose up -d   # 主库+Pi 库+MinIO+领域服务+next 对话入口(8080)
```

- 前端：http://localhost:8080（assistant-ui 正式对话入口）
- next 开发与容器数据边界：`docs/pi-chat-development.md`
- home 切换和旧库保留：`docs/home-next-deployment.md`
- 无外部调用现状回归：`bash tests/e2e/current-state-smoke.sh`
- 无外部调用浏览器回归：按 `deploy/dev/README.md` 的命令在 Agent Runtime 中运行 `browser-visual-smoke.mjs`
- 真实端到端（会调用模型，并可能按 Agent 判断调用 OCR）：`bash tests/e2e/real-smoke.sh`
- 侧车：`nix develop -c bash sidecars/pybkt/setup.sh` 建 venv；`test.sh` 跑对拍测试

## 验证现状

- 全 workspace `tsc --noEmit` 全绿；mastery（BKT 对拍）/retention/selector 契约测试全绿；
- 统一九项 Skill 树通过 `skill-creator` 结构检查；自动测试覆盖元数据、模板、上游固定提交、有效输出与危险/损坏输出拒绝；
- 21 契约 schema 样例校验通过；PaddleOCR-VL 接口、原件/版面/图片持久化与 Agent 路由已接入；
- 官方初始内容由 home 已提取的 K/T/Q/E/R 五份清单一次导入，共 174 个固定修订；学生案例不导入。教师新内容经普通 Pi KTQ/ER 会话、独立复核页和班级发布生成；
- 无模型 key 时所有模型路径**显式 502 不伪造**（严禁回退方案纪律）。

## 项目资料索引

- 代码仓库：本仓库（含 README/部署说明）
- 官方初始清单：`db/migration-data/official-content-manifest.csv` → `data/` 中五份已核验 CSV（导入后 PostgreSQL 为事实源）
- 产品与交互：`design-docs/产品重构基线v1-用户任务与信息架构.md`、`design-docs/Web信息架构与响应式交互重构v2.md`
- Agent 架构：`design-docs/统一Pi-Agent能力壳与工作区会话架构v1.md`、`design-docs/架构修订v4-Pi原生运行时与成品复用.md`
- 数据说明：`docs/数据整理说明.md`
