# 架构修订 v4：Pi 原生运行时与成品复用

> 日期：2026-08-18  
> 性质：对 v3.3 的运行架构（§4）做结构性修订，纠正"手写 Provider / 手写任务会话协议 / 手写运行时"的偏离。  
> 依据：用户复审意见 + `references/pi`（pi-agent-core / pi-ai 0.83.0 源码）原生能力核对。  
> 原则（用户原话）：**pi agent 是统一 AI 入口，提供商与运行时由 pi 天然管理；模型身份与动作由 prompts 和 skills 管理；整个 agent 运行时复用，只需要一个插件管理运行时与状态，并管理 agent 的文件系统。references 就是用来 clone 项目并参考的。**

---

## 0. 修订结论（先给结论）

1. **provider 注册改为 pi-ai 原生机制**：`createProvider() + openAICompletionsApi() + envApiKeyAuth()`（文档化标准模式），删除手写的 auth resolve / 模型元数据硬编码组装；模型 ID（Qwen3.8-Max / DeepSeek-V4-Flash-0731）仍是环境配置实例（v3.3 §1.2.2）。
2. **运行时改为 pi 原生 Agent**（`@earendil-works/pi-agent-core` 的 `Agent`：agent loop、流式、工具执行、事件、transcript 状态），删除手写的"会话注册表 + create/prompt/delete 三段协议"；**会话生命周期收进宿主内部**，领域服务只剩一次 `runTask` 调用。
3. **"一个插件"= AGMATH 运行时插件**（agent-runtime 内单一模块）：管任务会话、租户绑定、respond 结构化输出工具、工作区文件系统（设计 §5.1 的 AGENTS.md 编译 + task/student/chapter/output 目录），不扩散到领域服务。
4. **模型身份与动作由 prompts/skills 管理**：`policies/` 即 pi Skills 目录（SKILL.md 机制，`loadSkills` + `formatSkillInvocation` + `formatSkillsForSystemPrompt` 原生装载）；manifest 单一管理 prompt_version 与主/辅模型角色；Agent 循环内零动作限制。
5. **references 成品落地点**（见 §3，随调研定稿）：pyBKT = BKT 内核（Python 侧车）、OATutor = 掌握阈值/复习调度参考、Qwen-MM-Plugins 四模块 = Provider 落地点（§13）、Dream 画像 = 成品替代方案。

## 1. Pi 原生能力核对（0.83.0 源码事实）

| 我们之前手写的 | pi 原生提供（references/pi 源码确认） |
|---|---|
| `scnet-provider.ts`：手写 auth resolve、模型元数据硬编码 | `pi-ai` `createProvider({auth:{apiKey: envApiKeyAuth(name, envVars)}})` + `openAICompletionsApi()`；任意 OpenAI 兼容端点原生支持（README"Any OpenAI-compatible API"） |
| 会话注册表 `Map` + `/runtime/sessions` create→prompt→delete | `Agent`（agent-core）：owns transcript、`prompt()`、`subscribe` 事件、`abort`、`state`；会话状态是 Agent 自身属性 |
| `extractRespondOutput` 手写遍历消息 | 结构化输出仍属领域契约（respond 工具调用 details），保留为插件内实现，不扩散 |
| 任务提示 TS 模板字符串（已迁 policies/） | `loadSkills()`（SKILL.md / 目录内 .md）+ `formatSkillInvocation()` + `formatSkillsForSystemPrompt()`（三层上下文 §5.3 的 Skill 层正是此机制） |
| （阶段 B）bash/read/write 沙箱工具 | harness/tools 已含 bash/read/write/edit 实现，沙箱接入时复用 |
| （阶段 B）持久会话 | `Session` + `InMemorySessionStorage` / `JsonlSessionRepo`（harness/session）已存在 |

注意：0.83.0 的 `AgentHarness`（v2 耐久运行时）已随 agent-core 发布但 `prompt()` 仍是 NotImplemented 骨架（restore 未实现），因此本期运行时用经典 `Agent`；AgentHarness 就绪后宿主平移，插件接口不变。

## 2. 修订后的 agent-runtime

```text
src/services/agent-runtime/src/
  index.ts       Pi 宿主：POST /runtime/tasks（单次 runTask）+ /capabilities；租户头强制
  providers.ts   pi-ai 原生注册：createProvider + openAICompletionsApi + envApiKeyAuth
                 （id=scnet，baseUrl/模型 ID 来自 env；删除手写 provider）
  skills.ts      policies/ → pi skills（loadSkills + formatSkillInvocation），manifest 装载
  workspace.ts   工作区文件系统（设计 §5.1 宿主侧骨架）：
                 <ws-root>/<tenant>/<task>/ AGENTS.md + task/task.json + tmp/ + output/
                 生成即编译 AGENTS.md（基础纪律 + 任务 skill 引用 + 输出契约），结束即清理
  runtime.ts     AGMATH 运行时插件（"一个插件"）：
                 runTask = 编译提示 → Agent 原生运行 → respond 输出 → trace/prompt_version → 清理
                 tenant 绑定、任务状态（turns/耗时/输出哈希）审计字段
policies/        pi skills 目录（agent.md + tasks/*.md + tasks.manifest.json）
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
| **Qwen-MM-Plugins 四模块** | 统一工具契约（`TOOL` + `handle(args) → list[dict]`）+ `mcp_framework.py`（FastMCP stdio）；core=本地媒体理解（无 key）、api=DashScope VL/OCR/grounding、search=web/image search（Serper→Tavily→Exa）、edu-agent=skill-only（hyperframes HTML/视频讲解 + 设计系统资产） | 设计 §13 落地点：`MediaUnderstandingProvider`（core/api）、`SearchProvider`（search）、`ExplanationRenderer`+`ArtifactPublisher`（edu-agent）；宿主以 MCP stdio 子进程接入（core/api/search），edu-agent 走 `npx hyperframes` + 资产复用 |
| **teammate-models TEACHER** | OCR→题干/答案/解析+图片关联管线；Excel 知识库 schema（难度/掌握标准/补弱建议/前置知识点ID） | content 管线参考（§7.1 题图入库、知识点库结构）；错因库与前置关系进知识图谱与复习调度 |
| **deepseek-harness** | 工具注册/执行管线、MCP client、schedule（session 锚定提醒） | 宿主侧工具目录与复习提醒的架构参考（不依赖） |
| **艾宾浩斯保持率 + 复习调度** | 所有 repo 均无现成时间衰减/复习调度（OATutor 无 decay、pyBKT forgets 非时间衰减） | **必须自建**（v3.3 §9.6 保持率网格 + I90 后验），deepseek-harness schedule 作架构参考 |

**Dream 路径修订**：`pyBKT Roster` 承担"程序科学评价 + 状态归约"的成品实现（不再手写 bktReplay）；Dream 画像大模型仍按 v3.3 §9.3 独立 Session 综合双产物，其数值基准（p_baseline）由 Roster 程序输出提供，Validator 不变。教学阶段的快速 BKT 用 OATutor 移植引擎（TS，零延迟），两者数学对拍。

**落地进度**：✅ packages/mastery 已按 OATutor BKT-brain.js 移植（同型后验公式 + probMastery/probTransit/probSlip/probGuess 参数 schema + MASTERY_THRESHOLD=0.95 约定 + 契约测试，commit 5a83133 后追加）；⏳ pyBKT Roster 侧车（Python）、Qwen-MM-Plugins 四模块落地点、前端 apps/web 待动工。

## 4. 修订后每开发一步的核对清单（用户要求的工作法）

每开发新功能：① 设计文档里它应该是什么样子 → ② 现在实现是什么样子 → ③ 结构是否简洁清晰。三者任一不符即停下修正。
