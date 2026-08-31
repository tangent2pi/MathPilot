# MathPilot 科学内核、Dream 与配套前端实施 Goal

> 用途：为一个长期开发 Session 提供单一、耐久、可验证的实施目标。
> 状态：ready；尚未据此宣称任何实现阶段完成。
> 设计基线：[README.md](./README.md)
> Goal 机制依据：[OpenClaw Goal](../../references/openclaw/docs/tools/goal.md)

## 1. 启动命令

在支持 Goal 的会话中使用：

```text
/goal start 在 MathPilot 当前主工作区端到端实现 design-docs/科学内核与Dream封版v3/GOAL.md 定义的科学内核、错因闭环、对话式学习流、统一异步 Agent Runtime、三相位 Dream 及配套前端；以 README 与 01–07 文档为权威设计，直接替换冲突旧路径，直到 P0–P7 和全部终态验收均有当前证据证明后才算完成。
```

这是一个 Goal，不是一组彼此独立、可任选完成的任务。P0–P7 是同一目标的实施阶段；完成其中一部分不能缩减最终目标。

## 2. 单一目标

在 `/home/tangent/MathPilot` 当前主工作区中，将 [科学内核、错因闭环与 Dream 封版设计 v3](./README.md) 实现为唯一生产目标架构：

- 学生在普通 ConversationThread 中连续完成多道题；
- 每题由独立 QuestionSession 保证证据、幂等和切题边界；
- M、R、C_e 分别由可重放事实和版本化程序投影产生；
- 错因被诊断、教学、选题、迁移验证、报告和教师纠正持续消费；
- 自由训练与阶段活动复用同一 Intent → QuestionSession → Cut 流程；
- 模型理解复杂选题需求，宿主执行硬资格与原子提交；
- Temporal 承担耐久异步、子工作流、恢复和 Dream 调度，Pi 只执行有界 AgentAttempt；
- Light → REM → Deep 只产生有来源的语义 Annotation，不改科学数值或错因状态；
- assistant-ui 承担对话 primitives，后端读模型配套题卡、判定、个人记录、状态、记忆、复习、证据和 Agent 上下文透明界面；
- 与目标设计冲突的旧写路径、旧状态权威和重复实现被删除或退役，不建立长期兼容层。

只有当本文件的全部终态成功条件都由当前代码、数据库、运行结果和测试证据证明，Goal 才能标记 `complete`。

## 3. 权威来源与优先级

遇到冲突时按以下顺序处理：

1. 用户在当前 Goal 会话中的最新明确 steering；
2. 本文件定义的目标、范围和终态条件；
3. [README.md](./README.md) 的封版决策与不可破坏不变量；
4. 主题契约：
   - [01-科学内核与证据契约.md](./01-科学内核与证据契约.md)
   - [02-错因证据与消费闭环.md](./02-错因证据与消费闭环.md)
   - [03-选题切题与对话式学习流.md](./03-选题切题与对话式学习流.md)
   - [04-Dream三相位语义记忆.md](./04-Dream三相位语义记忆.md)
   - [05-统一AgentRuntime工具Skills与工作区.md](./05-统一AgentRuntime工具Skills与工作区.md)
   - [06-场景审计复用选型与验收.md](./06-场景审计复用选型与验收.md)
   - [07-前端设施后端读模型与统一交互语言.md](./07-前端设施后端读模型与统一交互语言.md)
5. 当前工作树、数据库迁移、运行服务和测试结果，用于判断“现状是什么”，不能反向覆盖目标设计；
6. 旧系统设计、原始对话和历史实现只用于迁移溯源，不作为冲突时的权威。

不要把本文件扩写成第二份系统设计。新的语义决策先更新对应 01–07 文档，再在这里更新目标或验收引用。

## 4. 范围

### 4.1 必须完成

- 新事实、projection、Annotation、规范消息和 View contracts；
- PostgreSQL schema、迁移、约束、索引、outbox 和重放入口；
- Temporal OSS 开发组合、TypeScript Worker、Workflows、Activities、Signals/Updates、Schedules 和测试；
- PiTaskExecutor、Task Registry、最小工具/Skill 授权和只读 WorkspaceProjection；
- Judgment → Observation/ErrorEvidence 编译及资格拒绝；
- OATutor BKT 薄适配、pyBKT 离线对拍接口、`ts-fsrs` RetentionEngine；
- ErrorEvidence reducer、探针关系矩阵、教学/选题/验证/报告/教师纠正消费；
- SelectionIntent、单一 `question_catalog`、Selector Agent、Cut/commit 并发事务；
- Light、REM、Deep、gates、AnnotationChangeSet、preimage、Diary、rollback 和 stale 处理；
- app-owned canonical messages、assistant-ui External Store、DomainUIPart 和输出专用 presentation registry；
- 对话卡片、AnswerReceipt、学习上下文栏、学习概览、历程、状态、错因、记忆、复习、证据详情和响应式/无障碍设施；
- 旧冲突路径的删除、迁移或明确只读归档；
- 契约、算法、Workflow、Agent eval、集成、端到端、权限、可访问性和恢复测试；
- 与最终实现一致的运行文档和验证证据。

### 4.2 不扩张到

- 内容生产、OCR、课件解析和完整 KTQER 重构；只实现本 Goal 所需的稳定接口；
- 通用账号、班级、计费、全站品牌或非学习页面重构；
- 外部生产发布、PR、push 或真实学生数据迁移，除非用户另行授权；
- 为兼容旧 mode/run/PUD、旧 Dream Snapshot 或旧展示工具而保留双写权威；
- 与终态无关的顺手重构。

## 5. 不可破坏约束

实施过程中始终满足：

1. 事实先于状态，所有 M/R/C_e/Annotation 能由生效事实和版本重放；
2. 模型不直接写 `p_mastery`、FSRS Card、ErrorPattern state 或计划完成度；
3. Dream 不重复计算已经进入科学内核的事实；
4. 提示后成功、同题立即改对和无可靠 rubric 的外部题不能冒充独立掌握证据；
5. 一个 QuestionSession 只有一个生效关闭提交，旧 intent revision 不能提交新题；
6. 切题硬路径只等待判定/显式 unresolved、诊断结论/显式 inconclusive、科学投影和关闭事务；
7. ConversationThread、ForegroundAgentEpoch、QuestionSession、Workflow 和 AgentAttempt ID 不复用；
8. 多数后台任务零业务工具，Selector 只有一个 catalog 工具；无默认 Bash、SQL、任意网络或全量 Skills；
9. Agent 能读取身份、能力、数据新鲜度和授权会话，但历史内容始终是数据而非指令；
10. 权威题卡、判定、关闭和状态更新只由领域事件投影器产生，模型不能伪造 `mathpilot.ui.*`；
11. 已形成事实的消息不能通过 assistant-ui 编辑、分支或重生成改写历史；
12. 科学状态和 Dream Annotation 并排、不同标签、不同写权威；
13. 学生能查看记忆依据、报告不准确、暂停个性化并知道本轮 Agent 实际参考了什么；
14. 每个用户组件都有读模型、权限、命令和空/错/旧状态，每个用户可见投影都有入口；
15. 不手写已有成熟能力：队列、租约、工作流恢复、FSRS/BKT 算法、聊天 primitives、路由/cache/focus trap 等优先使用成品或现有仓库设施。

任何临时实现若违反这些约束，不得作为完成证据；应在对应阶段结束前删除。

## 6. 实施阶段与阶段门槛

阶段顺序来自第 06 文档。可在依赖允许时并行开发，但验收依赖不能跳过。

### P0：契约与权限冻结

交付：

- 事实、projection、Annotation、LearningView、DomainUIPart、TaskSpec 和 operation schemas；
- 正例、拒绝例、版本与 supersession 规则；
- schema 层不可表达 Dream 数值写、前端 projection 直写和模型权威 UI。

门槛：共享 contracts 校验、拒绝样例和权限 contract tests 全部通过。

### P1：耐久 Runtime

交付：

- Temporal 开发服务与 Worker；
- outbox → Workflow 桥、PiTaskExecutor Activity、Task Registry；
- retry、timeout、cancel、child、Signal/Update、Schedule、Continue-As-New 和 operation result。

门槛：Worker/服务重启、重复投递、响应丢失和长等待测试证明可恢复；不存在进程内 Map/Cron 作为生产权威。

### P2：题级事实与切题

交付：

- canonical messages、ForegroundAgentEpoch、简化 QuestionSession；
- Attempt/Judgment/Observation 基础链；
- CutRequest/FinalizeQuestionWorkflow；
- SelectionIntent 与 optional LearningActivity 的统一入口。

门槛：并发提交、重复切题、判定失败、Epoch 轮换和软异步失败均不串题、不双开、不永久卡住。

### P3：M/R 科学内核

交付：

- EvidencePolicy 和 JudgmentCompiler；
- OATutor BKT 薄适配及 pyBKT 对拍；
- RetentionUnit、DelayedReviewEvent 和 `ts-fsrs` 薄适配；
- 教师纠正后的 replay/rollback。

门槛：M/R 从事实全量重放与增量结果一致；第三方 golden outputs、资格表驱动测试和参数版本测试通过；旧 I90 生产写路径退役。

### P4：错因消费闭环

交付：

- ErrorCauseDefinition、DiagnosisRule outcome relation matrix；
- DiagnosticClaim、ErrorEvidence、ErrorPatternProjection reducer；
- Teaching、Selection、Verification、Report、Teacher Review 和 ContentInsight 消费。

门槛：错误 → 候选 → 探针 → 正反/不可区分证据 → 干预 → near/far/delayed 验证 → improving/resolved/recurrence 的端到端用例通过。

### P5：模型选题与需求修订

交付：

- 单一 `question_catalog`；
- Selector TaskSpec/Skill/AgentAttempt；
- intent revision、Signal、commit revalidation 和无候选处理；
- QuestionOpened 自动产生权威题卡消息。

门槛：复杂、反复变化和互相冲突的自然语言需求正确处理；陈旧选择无法提交；Selector 没有相似重复工具。

### P6：三相位 Dream

交付：

- QuestionSession 级 Light；
- REM window/compiler/theme candidates；
- Deep gates、AnnotationChangeSet、preimage、Diary、rollback、stale 和使用偏好；
- relevant annotations 和只读历史 workspace。

门槛：有正反证据和 scope 的 Annotation 能稳定产生、supersede 和回滚；所有 M/R/C_e/计划越权写测试被拒绝；失败保留旧记忆。

### P7：读模型与用户前端

交付：

- LearningView assembler、ACL、cursor/ETag 和授权事件流；
- assistant-ui External Store、DomainUIPart registry、消息 action capability gating；
- QuestionCard、AnswerReceipt、Judgment、Probe、Closure、Learning/Memory/Review update；
- LearningContextPanel、History、State、ErrorPattern、MemoryLedger、ReviewQueue、EvidenceDetail 和 AgentContextTransparency；
- 记忆反馈、mute/unmute、教师同源审计视图；
- desktop/tablet/mobile、keyboard、screen reader、dark mode、200% zoom 和 reduced motion。

门槛：组件—读模型—命令配对清单全部落地；模型无法伪造权威卡；跨设备/刷新/重复提交状态一致；第 07 文档全部前端验收通过。

## 7. 复用与实现纪律

- 所有开发、构建和测试通过根目录 `nix develop`；缺失工具按根 `AGENTS.md` 使用 Nix；
- 新增或调用具体库前核对当前官方文档；持续依赖进入 `flake.nix`/workspace，禁止全局安装；
- Temporal 负责耐久编排，不另造 Job/lease/heartbeat/Cron 框架；
- Pi SDK 负责 Agent loop，不复制 Agent runtime；
- OATutor/pyBKT/`ts-fsrs` 通过薄 adapter 使用，不复制或改写算法实现；
- assistant-ui 继续承担 Thread/Message/Composer/Attachment/ActionBar 和 typed part renderer；
- 现有 Base UI/Radix 封装、Lucide、KaTeX、ReactMarkdown 和 contracts 包继续复用；
- 页面 server-state、路由、虚拟化、焦点管理等若现有设施不足，选择成熟库，不手写大块已有逻辑；
- 第三方源码仅放 `references/` 阅读，产品源码通过依赖、协议或小型 adapter 复用；
- 保留用户已有和无关工作树改动；不得用 destructive git 命令覆盖它们；
- 不以“兼容旧设计更容易”为理由实现补丁架构，最终只保留新权威路径。

## 8. 当前状态与活动证据

本节是可更新的恢复记录，不是完成声明。

```text
conceptual phase: P0 complete; P1 durable runtime and database foundation
completed: authoritative design suite; prior Next stack checkpoint f355c48; science-v3 contracts and permission boundary
current: implement the new learning-next PostgreSQL facts/outbox/operation foundation and Temporal runtime
next action: add the clean-database v3 migration, then wire Temporal dev service, worker and outbox relay
implementation phases accepted: P0 — contracts, rejection examples and permission invariants verified in current tree
external blockers: none recorded
```

已知设计证据：

- `README.md` 与 01–07 已完成并互相链接；
- 设计 Markdown 已通过 ReactMarkdown + GFM 渲染和本地链接检查；
- `src/packages/contracts/schemas/science-v3/` 已冻结事实、投影、题级流、Annotation、
  LearningView、DomainUIPart、Command、TaskSpec、policy 与 operation 契约；
- `nix develop -c pnpm --dir src/packages/contracts test` 当前验证 33 组 examples / 34 个
  schemas，并通过 science-v3 权限、写权威、身份分离和禁旧 mode contract tests；
- 这只证明 P0，不证明 P1–P7 或真实服务 E2E 完成；
- 旧 `learning/profile/agent-runtime` 仅作为待退役现状，不作为 Next 实现来源或兼容目标。

每次恢复 Goal 时先更新：

- 当前 phase 与唯一 next action；
- 已通过且未被后续变更失效的证据；
- 当前失败的最小 owning surface；
- 任何会使旧阶段证据失效的 schema、算法、Workflow 或 UI contract 变更。

## 9. 完成证据矩阵

| 范围 | 最低权威证据 |
|---|---|
| Contracts/DB | schema examples、拒绝样例、迁移从干净库成功、约束/索引/ACL 测试 |
| Runtime | Temporal testing utilities 的 virtual time、retry、cancel、crash、Signal race、Continue-As-New 测试 |
| M | OATutor/pyBKT golden comparison、replay=incremental、参数版本测试 |
| R | `ts-fsrs` golden、due/retrievability、rollback/reschedule 和纠正重放测试 |
| C_e | reducer 全转移/property tests、正反/不可区分证据、near/far/delayed/recurrence 端到端测试 |
| Learning flow | 多题同 Thread、QuestionSession 隔离、Cut 幂等、intent revision race、外部题资格测试 |
| Selector | 固定候选工具返回的 Agent eval、复杂需求满足率、无候选诚实率、工具数审计 |
| Dream | phase 写权限、来源门禁、counterevidence、版本冲突、preimage/rollback、失败保旧测试 |
| Workspace | 同账号/同权限、新鲜度、历史为数据、prompt injection 和越权拒绝测试 |
| Frontend | External Store replay、DomainUIPart 来源、跨设备提交、组件读模型配对、responsive/a11y 回归 |
| Full system | 从自然语言选题到多题、错因干预、验证、Dream 记忆、个人记录和教师纠正重放的真实服务 E2E |
| Removal | 搜索、依赖图、写路径审计证明旧数值 Dream、旧 I90、旧 UI 工具和进程内 Runtime 权威已退役 |

“测试通过”只有在测试范围覆盖对应要求时才是证据。窄单测、mock-only 测试、静态页面截图或一次演示不能单独证明端到端完成。

## 10. 失败与变更策略

- 先定位最小 owning surface：contract、domain transaction、projection、Workflow、Agent semantics、read model 或 renderer；
- 第三方行为与假设不符时修薄 adapter 或钉版本，不 fork/复制整套算法；
- Workflow 失败修 Workflow/Activity 幂等和补偿，不回退进程内调度；
- Agent 结果不稳定先改 TaskSpec、Skill、输入 bundle、schema 或 eval，不增加一串重叠工具；
- 旧测试断言旧语义时，先证明它与封版设计冲突，再更新/删除测试；不为它恢复双写；
- UI 缺组件时先查 assistant-ui 和现有 `components/ui`，自定义组件必须沿用第 07 文档语言；
- 发现设计缺口时更新主题文档和本 Goal 的验收引用，再实现；不得让代码成为未记录的新设计；
- 外部权限、凭据或服务阻塞时，继续推进所有不依赖该条件的安全工作并记录精确 blocker。

## 11. 终态成功条件

以下条件必须同时成立：

1. P0–P7 每个阶段的交付和门槛都有当前、可复现、未失效证据；
2. 第 01–07 文档中的全部显式验收项都能映射到代码路径和测试/运行证据；
3. 完整真实服务 E2E 证明普通 Thread 内多题、切题、M/R/C_e、错因消费、Selector、Dream 和个人学习前端连通；
4. 所有科学状态可由事实重放，教师纠正和 supersession 后结果一致；
5. Dream 和模型权威 UI 的越权尝试被 schema、权限和测试共同阻断；
6. 系统重启、Worker crash、重复投递、网络回包丢失和跨设备提交不造成双写、串题或丢状态；
7. 学生能查看当前状态、历史、错因、复习、记忆依据和本轮 Agent 参考内容，并能反馈/暂停软记忆；
8. 教师能查看相同证据链并通过追加纠正触发重放，不直接改 projection；
9. 旧冲突写路径和重复工具已删除、退役或只读归档，没有两个生产权威；
10. `nix develop` 下相关 lint/typecheck/build/test、迁移、E2E、响应式和无障碍检查全部通过；
11. 依赖、许可证、配置、迁移、运行和验证文档与实际实现一致；
12. requirement → evidence 审计没有“缺失、间接、未验证或留待以后”的必需项。

### 不构成完成

- 仅完成设计或 contracts；
- 仅实现 happy path 或演示页面；
- P0–P6 后缺个人记录/记忆/证据 UI，或只做前端 mock；
- 保留旧 Dream 数值写、旧 I90、旧 selector 或旧题卡工具作为并行权威；
- 单测通过但没有恢复、并发、权限和真实服务 E2E；
- 因 token、时间、难度或“已经做了很多”而缩小终态。

## 12. Blocked 与停止条件

成功停止：第 11 节全部满足，完成审计逐项给出当前证据，然后才调用 `update_goal(status=complete)`。

阻塞停止：只有同一外部阻塞连续三个 Goal turn 都存在、没有其他有意义的范围内工作可推进时，才调用 `update_goal(status=blocked)`；记录：

- 精确阻塞对象；
- 已连续验证三次的证据；
- 只有用户/外部系统能执行的具体动作；
- 解除后第一项恢复动作。

普通失败、测试不绿、实现困难、需要重构、尚未调研或希望澄清，不构成 blocked。

## 13. 完成报告

完成时的最终报告至少包含：

- 目标结果和用户可见行为；
- P0–P7 requirement → evidence 表；
- 主要代码、schema、迁移和文档链接；
- 复用的第三方/现有设施及薄 adapter 边界；
- 实际执行的验证命令和结果；
- 旧路径删除/退役证明；
- 数据迁移或未迁移说明；
- 明确声明必需项无剩余工作。

在这些证据形成前，保持 Goal active，并继续推进真实终态，而不是提交一份看起来完整的阶段性总结。
