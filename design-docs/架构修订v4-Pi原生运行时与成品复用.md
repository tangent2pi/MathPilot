# 架构修订 v4：Pi 原生运行时与成品复用

> 日期：2026-08-18；2026-08-20 按统一能力壳实现更新
> 性质：对 v3.3 的运行架构（§4）做结构性修订，纠正"手写 Provider / 手写任务会话协议 / 手写运行时"的偏离。  
> 依据：用户复审意见 + Pi 运行时源码核对；当前部署为 `pi-coding-agent@0.84.1`。
> 原则（用户原话）：**pi agent 是统一 AI 入口，提供商与运行时由 pi 天然管理；模型身份与动作由 prompts 和 skills 管理；整个 agent 运行时复用，只需要一个插件管理运行时与状态，并管理 agent 的文件系统。references 就是用来 clone 项目并参考的。**

---

## 0. 修订结论（先给结论）

1. **provider 注册改为 pi-ai 原生机制**：`createProvider() + openAICompletionsApi() + envApiKeyAuth()`（文档化标准模式），删除手写的 auth resolve / 模型元数据硬编码组装；模型 ID（Qwen3.8-Max / DeepSeek-V4-Flash-0731）仍是环境配置实例（v3.3 §1.2.2）。
2. **运行时改为 Pi 原生 Agent Session**（`@earendil-works/pi-coding-agent` 的 `createAgentSession`、`SessionManager` 与原生 Bash/ResourceLoader：agent loop、流式、工具执行、事件、transcript 状态），删除手写的“create/prompt/delete”业务协议；**会话生命周期收进宿主内部**，领域服务只剩一次 `runTask` 调用。
3. **"一个插件"= MathPilot 运行时插件**（agent-runtime 内单一模块）：管任务会话、租户绑定、respond 结构化输出工具、工作区文件系统（设计 §5.1 的 AGENTS.md 编译 + task/student/chapter/output 目录），不扩散到领域服务。
4. **模型任务与能力分层管理**：`policies/` 保存当前任务 Prompt 与通用纪律；`src/services/agent-runtime/skills/` 保存可发现的标准 Skill（SKILL.md、模板、验证器、元数据），由 Pi ResourceLoader 原生装载。manifest 单一管理 prompt_version 与主/辅模型角色；Agent 循环内不硬编码业务步骤。
5. **references 成品落地点**（见 §3）：pyBKT = BKT 内核（Python 侧车）、OATutor = 掌握阈值/复习调度参考、Qwen-MM-Plugins Core/Search/Edu = 统一本地能力树，PaddleOCR = 高精度文字与版面能力。

## 1. Pi 原生能力核对（当前 0.84.1 实现）

| 我们之前手写的 | pi 原生提供（references/pi 源码确认） |
|---|---|
| `scnet-provider.ts`：手写 auth resolve、模型元数据硬编码 | `pi-ai` `createProvider({auth:{apiKey: envApiKeyAuth(name, envVars)}})` + `openAICompletionsApi()`；任意 OpenAI 兼容端点原生支持（README"Any OpenAI-compatible API"） |
| 会话注册表 + `/runtime/sessions` create→prompt→delete | `createAgentSession` + `SessionManager`：管理 transcript、`prompt()`、事件与恢复；MathPilot 只保留正在执行回合的引导队列 |
| `extractRespondOutput` 手写遍历消息 | 结构化输出仍属领域契约（respond 工具调用 details），保留为插件内实现，不扩散 |
| 任务提示 TS 模板字符串（已迁 policies/） | 任务 Prompt 编译进当前工作区 `AGENTS.md`；标准能力 Skill 由 ResourceLoader 从独立目录按需发现（对应三层上下文 §5.3 的 Skill 层） |
| Bash/文件工具 | 复用 Pi `createBashToolDefinition`，由 Bubblewrap 为当前 `/workspace` 建立只读根、独立 PID/网络命名空间和有限写区 |
| 持久会话 | `SessionManager` JSONL 续接；终态 transcript 压缩归入 Workspace Capsule |

MathPilot 不修改 Pi 循环。任务差异由同一 ResourceLoader 下的 Skills、工作区文件、任务 Prompt、数据库身份与目标形成。

## 2. 修订后的 agent-runtime

```text
src/services/agent-runtime/src/
  index.ts       Pi 宿主：POST /runtime/tasks（单次 runTask）+ /capabilities；租户头强制
  providers.ts   pi-ai 原生注册：createProvider + openAICompletionsApi + envApiKeyAuth
                 （id=scnet，baseUrl/模型 ID 来自 env；删除手写 provider）
  skills.ts      policies/ → 当前任务 Prompt，manifest 装载
  workspace.ts   工作区文件系统（设计 §5.1 宿主侧骨架）：
                 <ws-root>/<tenant>/<session>/ AGENTS.md + task/runs + input/output/tmp + .agent/capsule
                 每轮记录来源与文件哈希；继续型保留输入，真正终态归档 transcript 并释放副本
  runtime.ts     MathPilot 运行时插件（"一个插件"）：
                 runTask = 编译提示 → Agent 原生运行 → respond 输出 → trace/prompt_version → 清理
                 tenant 绑定、任务状态（turns/耗时/输出哈希）审计字段
policies/        任务 Prompt 策略（agent.md + tasks/*.md + tasks.manifest.json）
src/services/agent-runtime/skills/  Pi 标准能力 Skill（每项含 SKILL.md、模板、验证器、agents 元数据）
packages/providers/model  客户端瘦身为一次 POST /runtime/tasks
```

- 领域服务（learning/content/profile）只调用 `runTask(taskType, sessionRef, tenantId, context)`；
- 一任务一 Agent 一工作区：模型历史、工作区、临时文件互不共享（v3.3 §4.1/§5.1）；
- 跨租户访问由宿主拒绝（x-tenant-id 绑定，403）；
- 密钥只进 agent-runtime（宿主侧），领域服务与前端不持有。

## 3. references 成品落地点（2026-08-18 调研定稿）

| 成品 | 复用点 | 落地点 |
|---|---|---|
| **pyBKT `models.Roster`** | 逐学生×逐技能掌握度跟踪：`update_state` / `get_mastery_prob`，默认阈值 0.95 | **Dream/画像更新的成品替代**（用户点名的"dream 成品案例"）：Python 侧车（ADR-001），薄 CLI 包装（JSON-lines in → JSON out） |
| **pyBKT `Model`** | `fit` / `partial_fit`（multigs/multilearn/forgets/multiprior 变体）+ `predict`（P(mastery)） | BKT 参数校准与批量画像重算（阶段 C：`calibration_status=prior_only` → `calibrated`） |
| **OATutor `BKT-brain.js`** | 20 行标准贝叶斯后验更新，数学与 pyBKT 一致；`MASTERY_THRESHOLD=0.95`；`defaultBKTParams.json` 参数 schema；`defaultHeuristic` 选题 | 掌握内核的 TS 侧实时引擎 + 阈值/参数 schema 与选题启发式（零侧车延迟）；`mastery` 包重写为移植 + pyBKT 对拍 |
| **Qwen-MM-Plugins** | Core=本地媒体/文档查看；Search=网页、内容与反向图片搜索；Edu Agent=Hyperframes 教学媒体 Skill | 本地固定提交安装 Core/Search MCP，并同步三项官方 Skill 到唯一 `/opt/agmath-skills`；Edu 使用本地 Chromium/ffmpeg/Hyperframes。Qwen `api` 不注册，主模型图像直接进入 SCNET，PaddleOCR-VL 单独承担高精度文字与版面提取 |
| **teammate-models TEACHER** | OCR→题干/答案/解析+图片关联管线；Excel 知识库 schema（难度/掌握标准/补弱建议/前置知识点ID） | content 管线参考（§7.1 题图入库、知识点库结构）；错因库与前置关系进知识图谱与复习调度 |
| **deepseek-harness** | 工具注册/执行管线、MCP client、schedule（session 锚定提醒） | 宿主侧工具目录与复习提醒的架构参考（不依赖） |
| **艾宾浩斯保持率 + 复习调度** | 所有 repo 均无现成时间衰减/复习调度（OATutor 无 decay、pyBKT forgets 非时间衰减） | **必须自建**（v3.3 §9.6 保持率网格 + I90 后验），deepseek-harness schedule 作架构参考 |

**Dream 路径修订**：`pyBKT Roster` 承担"程序科学评价 + 状态归约"的成品实现（不再手写 bktReplay）；Dream 画像大模型仍按 v3.3 §9.3 独立 Session 综合双产物，其数值基准（p_baseline）由 Roster 程序输出提供，Validator 不变。教学阶段的快速 BKT 用 OATutor 移植引擎（TS，零延迟），两者数学对拍。

**落地进度**：✅ packages/mastery 已按 OATutor BKT-brain.js 移植；✅ pyBKT 侧车与 Validator 已接入；✅ Qwen-MM Core/Search/Edu、PaddleOCR 路由、统一九项 Skill 树、Session Capsule 与正式响应式 Web 已接入并通过无付费回归。真实资料的新 KTQ→ER 运行、Word/PPT 上游接受度和人工内容复核仍属于外部验收阶段。

## 4. 修订后每开发一步的核对清单（用户要求的工作法）

每开发新功能：① 设计文档里它应该是什么样子 → ② 现在实现是什么样子 → ③ 结构是否简洁清晰。三者任一不符即停下修正。
