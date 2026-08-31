# 科学内核、错因闭环与 Dream 封版设计 v3

> 状态：**本范围的权威设计基线**
> 日期：2026-08-31
> 需求来源：Claude 线程 `a9939c42-8b52-4670-a406-d106bf1ed525` 及其后的用户澄清
> 范围：科学内核、错因闭环、Dream，以及它们直接依赖的选题、切题、QuestionSession、后台 Agent Runtime 和用户可见前端设施

## 1. 这套设计是什么

这是一套证据驱动的对话式学习内核。学生始终在普通对话中学习，但后台把“当前在做哪一道题”“哪些回答可以成为测量证据”“某种错因是否真的成立”“什么时候应复测”“哪些跨题规律值得长期记住”分成独立、可回放的事实与投影。

它解决六个相互牵制的问题：

1. 一段自然对话可以连续完成多道题，但不同题目的证据不能串台；
2. 复杂、反复变化的选题要求应由模型理解，程序又必须守住权限、题目有效性和并发一致性；
3. 掌握、遗忘和错因不是同一个数，也不能由 Dream 随意改写；
4. 错因不能停留在会话末尾的一个标签，必须真正驱动追问、教学、选题、复测和内容改进；
5. 评分、诊断、切题和 Dream 需要可靠的异步执行，又不应把后台 Pi Session 暴露成学生会话。
6. 后端已经形成的证据、状态和记忆必须有配套的对话卡片、个人记录与可追溯界面，又不能让前端或模型伪造科学事实。

## 2. 审查边界

### 2.1 本套文档覆盖

- `M`：知识点/题型掌握状态；
- `R`：随时间变化的可提取性与复测调度；
- `C_e`：错因假设、证据和状态投影；
- Judgment、Observation、证据资格、教师纠正与重放；
- 自由训练与阶段训练的统一学习流；
- 模型主导选题、需求修订与原子提交；
- 一题一 `QuestionSession` 和切题事务；
- Light → REM → Deep 三相位 Dream；
- 支撑以上能力的统一耐久 Agent Runtime、最小工具、Skills 和只读工作区投影；
- 对话内题卡/判定/切题反馈、个人学习记录、科学状态、记忆、复习和证据查看的前后端配套设施。

### 2.2 明确不覆盖

- 内容生产、OCR、课件解析和 KTQER 全流程；
- 通用 Web 信息架构、全站品牌重构和非学习页面；本文只定义科学内核与 Dream 的直接前端；
- 通用账号、班级、计费、部署与运维架构；
- 全产品数据迁移与兼容策略。

这些系统只作为接口边界出现。本设计不要求兼容旧架构；实现时可直接迁移到这里定义的目标形态。

## 3. 总体结论

这套目标值得实现，也可以实现，但不能把“普通对话”误解为“只有一个后台 Session”。最终结构是五种身份彼此独立：

```text
学生看到的普通对话
ConversationThread
        │ 由应用持有规范消息流
        ├── ForegroundAgentEpoch 0..n   Pi 的临时上下文，可压缩/轮换
        ├── QuestionSession 0..n        一题一个证据与切题边界
        ├── LearningActivity 0..n       可选的目标/预算/覆盖策略，不是 UI 模式
        └── Temporal Workflow 0..n
                └── AgentAttempt 0..n   隐藏的评分、诊断、选题、Dream Pi 运行
```

前台可以看起来完全连续，后台仍必须保留一题一 `QuestionSession`。否则重复提交、改题、教师纠正、证据归属和 Dream 来源都会失去可验证边界。

## 4. 封版决策

| 争议 | 封版结论 | 原因 |
|---|---|---|
| 多道题是否放在同一可见对话 | 是 | 符合自然学习；assistant-ui 可渲染应用自持有的消息状态 |
| 一道题是否仍是一条独立 Session | 是，保留 `QuestionSession` | 它是领域/证据/切题事务边界，不是 UI 线程 |
| 可见线程是否必须绑定一个 Pi Session | 否 | `ForegroundAgentEpoch` 可以轮换，应用消息流才是规范记录 |
| 普通对话是否意味着不设状态 | 否 | UI 不暴露“模式”，后台仍需少量明确生命周期和幂等事务 |
| 自由训练与阶段训练是否是两条流程 | 否 | 只在选题意图来源和可选策略约束上不同，后续完全复用 |
| 阶段范围/预算如何保存 | 可选 `LearningActivity` | 它承载正式测评覆盖和计划履约，但不制造另一套交互 |
| 谁做复杂选题 | 模型最终选择 | 自然语言需求不应被压成万能条件 DSL |
| 程序选择器还做什么 | 安全检索、硬资格、去重、原子提交 | 这些必须确定且可并发校验 |
| 一次给模型几个选题工具 | 一个 `question_catalog` | 小批量结果直接包含完整题干与选择元数据，避免 search/get 重叠 |
| 是否自建通用 Job 表和租约器 | 否，采用 Temporal OSS | 子工作流、等待、重试、取消、恢复和调度不再手写 |
| BKT 是否重写 | 否 | 复用现有 OATutor 薄移植，pyBKT 只做离线校准/对拍 |
| I90 是否继续自研网格 | 否，迁移到 `ts-fsrs` | FSRS 的 Stability 本身就是 `R=90%` 的时间，且已有调度、回滚和优化器 |
| Dream 能否改 `p_mastery` | 不能 | 数值状态只由版本化程序引擎消费合格事实得到 |
| Dream 能否改错因状态 | 不能 | 错因状态由追加证据和确定性 reducer 得到 |
| Dream 能写什么 | 带范围、正反证据和来源的语义附注 | 例如“题型 p=0.8，但在需自行补线的情境不稳定” |
| Dream 相位 | Light → REM → Deep | 参考 OpenClaw 标准相位和单一深层写入口 |
| 后台任务能否直接改前台 Pi Session | 不能 | 通过工作流结果和领域事实交接，前台上下文只读刷新 |
| Agent 是否能查看自己的其他可见会话 | 能 | 同账号、同权限的会话以只读投影链接进工作区，不另造会话查询工具 |
| 权威题卡/判定卡由谁产生 | 后端领域事件投影器 | 模型生成的 UI 不能冒充 QuestionOpened、Judgment 或科学状态 |
| 用户怎样查看长期结果 | 对话内摘要 + 个人学习空间 | 高频动作留在普通对话，记录/状态/记忆/证据使用同源读模型展开 |
| 学生能否控制 Dream 记忆 | 可查依据、报告不准确、暂停用于个性化；不能直接改写 | 兼顾用户控制权、来源链和可回滚性 |

## 5. 不可破坏的系统不变量

1. **事实先于状态**：Attempt、Judgment、Observation、ErrorEvidence 追加保存；M/R/C_e 和附注都能从事实重放。
2. **模型不直接写科学数值**：模型提出判定和语义，程序做资格校验、参数计算、状态投影和原子提交。
3. **Dream 不二次计数**：已经进入 BKT/FSRS 的作答不能再由 Dream 以“综合判断”调整数值。
4. **提示后成功不是独立掌握证据**：它可以证明教学有效，却不能伪装成无帮助作答。
5. **错因是可证伪假设，不是人格标签**：每个错因必须可区分、可干预、可验证。
6. **一题只有一个生效的关闭提交**：重复切题、网络重试和并发选题必须幂等。
7. **旧意图不能提交新题**：选题提交必须校验最新 `intent_revision`。
8. **切题只等待硬事实**：评分/显式 unresolved、诊断结论/显式 inconclusive、科学投影和关闭提交是硬路径；总结、连续性、Light、REM、Deep 都是软异步。
9. **前台、题目和后台运行身份不复用**：Thread、AgentEpoch、QuestionSession、Workflow、AgentAttempt 均有独立 ID。
10. **工具按任务最小授予**：除结构化 `respond` 外，多数后台任务零业务工具；需要检索的任务最多拿到一个专用能力工具。
11. **Agent 对自身环境透明**：它能读到身份、当前题、能力清单、Skills、数据新鲜度和获授权的历史会话，但看不到凭据、跨账号会话或隐藏推理。
12. **任何投影都可解释**：每个数值、状态和附注都带版本、输入引用、生成时间和 supersession 关系。
13. **权威 UI 只能由后端事实投影**：模型不能通过 tool call 或自由文本制造“已开题、已判定、已更新状态”。
14. **前后端设施逐项配对**：每个用户组件都有读模型、权限、空/错状态和命令；每个用户可见投影都有明确入口。
15. **证据消息不可原地改史**：已形成 Attempt、Judgment、Closure 或 Annotation 通知的消息只追加 supersession，不使用通用编辑/分支改写历史。

## 6. 文档架构与阅读顺序

| 文档 | 回答的问题 |
|---|---|
| [01-科学内核与证据契约.md](./01-科学内核与证据契约.md) | M/R/C_e 各是什么，什么证据能进入内核，模型和程序如何分工 |
| [02-错因证据与消费闭环.md](./02-错因证据与消费闭环.md) | 错因如何被区分、积累、消费、验证、纠正和评估 |
| [03-选题切题与对话式学习流.md](./03-选题切题与对话式学习流.md) | 同一对话怎样做多题，需求变化、自由/阶段、选题和切题如何工作 |
| [04-Dream三相位语义记忆.md](./04-Dream三相位语义记忆.md) | Light/REM/Deep 分别做什么，哪些内容能成为长期语义记忆 |
| [05-统一AgentRuntime工具Skills与工作区.md](./05-统一AgentRuntime工具Skills与工作区.md) | 后台任务、子 Agent、最小工具、Skill 与会话透明怎样实现 |
| [06-场景审计复用选型与验收.md](./06-场景审计复用选型与验收.md) | 还有哪些失败与边界场景，复用哪些成品，现状差距和验收门槛是什么 |
| [07-前端设施后端读模型与统一交互语言.md](./07-前端设施后端读模型与统一交互语言.md) | 后端事实如何配套 assistant-ui 卡片、个人记录、记忆、证据与响应式界面 |

上述七份文档组成一个整体；本文件负责决策优先级，具体契约以对应主题文档为准。

长期实施会话使用 [GOAL.md](./GOAL.md)。它把七份设计收敛成单一耐久目标、P0–P7 阶段门槛和 requirement → evidence 终态审计；它不是第八份设计，也不能覆盖上述主题契约。

## 7. 与旧文档的关系

以下内容仍可作为需求历史或现状说明，但在本范围内不再是权威设计：

| 旧文档/草案 | 状态 | 被替代的关键点 |
|---|---|---|
| `科学内核与Dream设计v1-pyBKT成品与画像记忆.md` | 历史实现基线 | 自研 I90、Dream 数值更新和 Dream 错因状态写入被替代 |
| `系统设计v3.3...md` 的科学内核/Dream 部分 | 历史综合设计 | 本套文档重新定义证据资格、保持层、错因和 Dream 写边界 |
| Claude 工作树中的 `科学内核设计v2...md` | 讨论草案 | 丰富判定保留为事实，但不以临时权重直接修补 BKT |
| Claude 工作树中的 `统一异步AgentRuntime...v0.2.md` | 讨论草案 | “一个可见线程必须绑定一个 Pi Session”被否定；切题边界被恢复 |
| “无限测量流、取消 AssessmentRun/QuestionSession”提议 | 未采纳 | 正式覆盖/预算和题级证据均需要明确但不显眼的领域边界 |
| `用户呈现形式v1`、`Web信息架构与响应式交互重构v2` 的学习状态/Dream 呈现 | 历史产品基线 | 本套第 07 文档替代其中 I90、Dream 最终画像、单题独立页和未配套读模型的部分；通用页面原则仍可参考 |

若旧文档与本套文档冲突，以本套为准。

## 8. 实现原则：薄适配，不重造轮子

目标代码结构应围绕少量领域端口组织：

```text
scientific-kernel/
  mastery-adapter       -> 现有 OATutor BKT 薄移植
  retention-adapter     -> ts-fsrs
  error-evidence-reducer
  evidence-policy

learning-orchestration/
  Temporal Workflows    -> 只写领域顺序与补偿
  Activities            -> 调用现有服务/PiTaskExecutor/数据库事务

agent-runtime/
  task-registry         -> schema + tool policy + skill + model policy
  pi-task-executor      -> 复用 Pi SDK 的隔离 Session
  workspace-projection  -> 只读、授权、可追溯
```

不实现自制队列、租约、心跳、Cron、子任务等待器、通用 SQL Agent、第二套聊天存储或第二套 FSRS/BKT 算法。

## 9. “设计完成”的含义

本轮完成的是该范围内的目标架构、行为语义、数据边界、复用选型、前后端呈现契约、失败策略和验收标准。它不是声称现有代码已经完成迁移。实现顺序、现状缺口和可验证完成条件见第 06 文档；组件和读模型的配对条件见第 07 文档。只要实现不越过这里的不变量，就不需要再次发明系统级概念。

## 10. 主要外部依据

- [OpenClaw Dreaming](../../references/openclaw/docs/concepts/dreaming.md)：Light/REM/Deep、深层单写入口、来源门禁、preimage 与 Dream Diary；
- [assistant-ui External Store Runtime](https://www.assistant-ui.com/docs/runtimes/custom/external-store)：应用可持有消息与线程状态，因此 UI Thread 不必等于 Pi Session；
- [assistant-ui Message primitives](https://www.assistant-ui.com/docs/ui/Message) 与 [Tool UI](https://www.assistant-ui.com/docs/tools/tool-ui)：复用消息部件和 typed renderer，同时将权威 UI 与模型工具权限分离；
- [Temporal TypeScript Child Workflows](https://docs.temporal.io/develop/typescript/workflows/child-workflows) 与 [Message Passing](https://docs.temporal.io/develop/typescript/workflows/message-passing)：耐久父子任务、Signal/Update 和可恢复控制；
- [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs)：TypeScript 调度器、可提取性、回滚/重排和参数优化绑定；
- [FSRS Algorithm](https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm)：Stability 定义为可提取性降到 90% 的时间；
- [OATutor](https://github.com/CAHLR/OATutor) 与 [pyBKT](https://github.com/CAHLR/pyBKT)：在线 BKT 参考实现和离线拟合/对拍基础。
