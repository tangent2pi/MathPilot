# AGMATH — 高中数学知识掌握诊断与学习规划 Agent

长株潭 Agent 训练营暨创新开发大赛（命题赛道）参赛作品。基于"解三角形"章节试点，
构建**证据型诊断教学系统**：聊天式一题一诊断 + 错因归因追问 + 传统程序科学基准
（BKT/保持率）+ Dream 画像大模型最终更新 + 1-4 周学习计划。

## 产品定位（一句话）

> 学生以聊天 + 可选草稿做题，每次作答变成可追溯的判定、程序基准与教学总结；
> 跨题证据由画像模型整理成可展开的状态与计划；教师复核内容与诊断，改判以
> "取代 + 重放"呈现——不是"会出题的聊天机器人"。

## 核心设计

| 设计要点 | 位置 |
|---|---|
| 设计宪法与完整规格 | `design-docs/系统设计v3.3-…md`、`架构修订v4`、`科学内核与Dream设计v1` |
| 赛题问题 ↔ 设计选择 ↔ 解决方式 | `design-docs/赛题映射与设计溯源v1` |
| 用户呈现形式（界面规格） | `design-docs/用户呈现形式v1` |
| Agent 策略源（pi Skills） | `policies/`（tasks.manifest.json 管理 prompt_version 与主/辅模型角色） |
| 算法侧车（pyBKT） | `sidecars/pybkt/`（ADR-001：Python 只作算法侧车） |

## 架构

```text
apps/web（正式前端·数学卷宗设计）  apps/web-test（流程演示）
services/api（OIDC 网关） agent-runtime（Pi 宿主：提供商/运行时 pi 原生管理）
services/content（OCR→KTQ/ER 双 Session→复核→不可变章节包+字段血缘）
services/learning（一题一 Session：判答→错因归因→追问卡→双产物）
services/profile（画像采集→Dream 三段式（pyBKT Roster 基准+画像大模型）→快照/计划）
services/review（教师复核：supersede+重放+修订 SLR）
packages/contracts（21 契约 schema） mastery（OATutor 移植+保持率） selector（选题） providers/{model,ocr}
db/（PostgreSQL 唯一事实源：RLS+不可变事件触发器，迁移 0001-0009）
```

## 快速启动（开发环境）

```sh
nix develop            # 进入开发环境（python312+gcc 用于侧车）
cd deploy/dev && cp .env.example .env   # 配置 MODEL_API_KEY / OCR_API_TOKEN
docker compose up -d   # postgres+迁移+种子+6 服务+web(8080)+web-test(3000)
```

- 前端：http://localhost:8080（正式）/ http://localhost:3000（演示）
- 端到端（需真实模型与 OCR key）：`bash tests/e2e/real-smoke.sh`
- 侧车：`nix develop -c bash sidecars/pybkt/setup.sh` 建 venv；`test.sh` 跑对拍测试

## 验证现状

- 11 包 `tsc --noEmit` 全绿；mastery（BKT 对拍）/retention/selector 契约测试全绿；
- 21 契约 schema 样例校验通过；OCR 真实 API 实测打通（PDF→片段→题框入库）；
- 无模型 key 时所有模型路径**显式 502 不伪造**（严禁回退方案纪律）。

## 交付物索引

- 代码仓库：本仓库（含 README/部署说明）
- 结构化数据：`data/`（知识点/题型/错因/题目/规则/学生案例）+ 数据整理说明 `docs/数据整理说明.md`
- 技术方案：`design-docs/赛题映射与设计溯源v1`（测评流程/出题策略/归因逻辑/掌握度/计划）
- 演示视频：由正式系统派生录制（`docs/` 待录）
