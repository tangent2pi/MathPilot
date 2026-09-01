# Next 实现隐藏省略与复用专项审计 v1

> **历史审计，已被整合替代，禁止据此直接实施。** 本文保留 `ad48c0c` 基线上的原始证据；条目状态、误判修正与当前执行入口统一见 [Next 实现整合审计 v3](./Next实现隐藏省略设计忠实度与复用整合审计v3.md)。任何修复仍须在 P7 干净 handoff commit 上重放。

> 审计基线：`ad48c0ca029a800166021a357e82a03f8ad883d8`
> 基线时间：2026-08-31 21:00:31 +08:00
> 基线说明：`feat(science-v3): add gated semantic Dream`
> 审计范围：正式 Next 链路，即 `web-next`、`api-next`、`pi-chat-runtime`、`content-next`、`storage-next`、`learning-next`，以及它们直接使用的 `contracts`、数据库迁移和 `deploy/dev` 组合。旧实现只在被错误用作 Next 验收证据时提及，不审计其内部质量。
> 工作树说明：项目持续开发中。本文所有代码判断均固定到上述提交；基线后的未提交或已提交 P7 工作不纳入问题判定。

## 1. 结论先行

当前工程不是“只有壳”，但也还不能称为端到端完成：Science v3 的数据库模型、领域约束、选题提交、答题收口、Temporal 运行时和 Dream 主体已经形成了相当完整的后端骨架；产品可见的 P7 读模型、命令入口和前端接线在该基线仍基本没有完成。

最重要的结论有四点：

1. **确有多处“声明完成但产品不可用”的隐藏省略。** 最典型的是 QuestionCard 的三个 action slot、诊断任务、教学前台任务、语义分解任务、历史消息编辑以及教学卡证据策略：名字、Schema、按钮或注册项已经存在，但缺少调用者、执行器、持久化闭环或 UI 消费者。
2. **选题不是随机抽取。** 当前 Selector 会让模型从 `question_catalog` 返回的候选中选择，并在提交前重新验证候选来源、最新意图、active slot 和硬约束；真正的问题是它尚未接入产品链路，而不是算法用随机数冒充智能选题。
3. **手写轮子的主要风险不在“小工具函数”，而在重复实现可靠执行语义。** 当前至少存在三套“接收任务—执行 Agent—失败恢复—重试—提交结果”的机制：Learning 的 Temporal、Content 的数据库轮询/退避、Pi 的进程内 Map/标记文件/转录扫描。它们职责不同，但运行机制相同，正是应抽象为统一后台 Runtime 的重复。
4. **库替代和抽象复用需要同时进行。** HTTP Schema、路由/服务端状态、上传、代理、配置、健康检查、CSV、迁移、MIME/文件识别等应优先采用成熟库；领域 reducer、证据门禁、选题约束、RLS 和领域事务不能被通用库稀释，但其外围执行机制应共享。

因此，当前最准确的工程进度表述是：

| 层面 | 基线实况 | 判断 |
|---|---|---|
| Next 登录、聊天、附件、Artifact 基础链路 | 已有可运行主体 | 可开发使用，但仍有生产配置、附件生命周期和 Artifact 隔离风险 |
| Science v3 数据库与领域内核 | P0–P6 的主体已实现 | 后端骨架较完整，但若干注册任务和状态没有真实执行路径 |
| 智能选题 | Selector、候选工具、硬约束复核和原子提交已实现 | 不是随机实现；尚无前端调用和 QuestionOpened 消费闭环 |
| 作答、评分、诊断、教学 | 作答/评分的存储与工作流主体存在 | P7 命令未接；诊断与部分教学任务仅注册、不可达 |
| Dream | Light/REM/Deep 与门禁主体存在 | 后端能力已形成；产品读模型与展示未接 |
| P7 前端设施、读模型、统一交互语言 | 基线仅有一个学习命令入口 | 当前主要开发阶段，尚不能验收为产品功能 |
| Next 端到端验收 | 没有覆盖上述完整链路的 Next E2E | P0–P6 的局部测试通过不能证明 P7 或真实服务闭环 |

这个判断也与仓库自己的阶段记录一致：`design-docs/科学内核与Dream封版v3/GOAL.md:209-279` 将概念阶段 P0–P6 记为完成、把 P7 列为当前工作，并明确已有证据不能证明 P7 或真实服务 E2E；`deploy/dev/README.md:25-31` 虽定义了正式 Next 服务链，但同时说明下一题、后台评分和 Dream 尚未接入新对话链。本文进一步指出的是：即使在 P0–P6 内部，也要把“注册/声明已存在”与“生产链路可执行”分开验收。

## 2. 审计方法与判定标准

本次不是只搜 `TODO`、`throw new Error("not implemented")` 或重复代码片段，而是沿以下五条路径反向查证：

- **可达性：** 每个按钮、action slot、TaskSpec、状态枚举、Schema 是否有生产调用者、执行器、提交路径和消费者。
- **真实性：** 标为智能、可靠、幂等、sandboxed、ready 的能力是否真的满足其语义，而不是名字存在或最简模拟。
- **运行机制：** 跨职责比较任务接收、Agent 执行、工作区、重试、恢复、事务、对象生命周期等机制，而不只比较相同函数文本。
- **权威来源：** 已声明为唯一事实源的 JSON Schema、Task Registry、数据库或 Temporal 是否真的控制运行时，还是旁边又存在手写分支。
- **库边界：** 通用协议、安全、并发、可访问性和生命周期问题优先找成熟库；数学智元特有的学习语义保留为自有代码。

优先级含义：

- **P0：** 会造成错误完成声明、安全边界失效、可靠性语义分裂，或阻断主产品闭环。
- **P1：** 当前单机开发可能可用，但进入多人开发、扩容、故障恢复或持续演进后会显著放大。
- **P2：** 主要是长期维护、漂移与验证成本，应在主闭环稳定后治理。

本文中的代码路径和行号均指 `ad48c0c` 审计基线，而非持续变化的当前工作树；上下文已经明确服务时会省略重复的目录前缀。

## 3. 用户已举例问题的复核

### 3.1 历史消息编辑：确认是无后端能力的 UI 动作

- `web-next` 在线程动作栏渲染了 `ActionBarPrimitive.Edit`，并存在 EditComposer：`src/apps/web-next/src/components/assistant-ui/elements/thread.aui.tsx:455-466`。
- 当前 `@assistant-ui/react-pi` External Store 没有消息编辑传输；已安装适配器中的 queue `move/edit/remove` 是显式空操作。
- Pi 服务没有 edit message、rewrite history 或 branch commit 接口。
- Science v3 设计又要求“已被事实消费的消息不可任意修改”，应依据 capability、lock reason 和事实消费状态控制动作，而不是实现任意历史重写。

**判定：P0 隐藏省略。** UI 暴露了一个没有产品语义和服务端提交路径的动作。修复方向是让服务端返回消息 capabilities，并对锁定消息隐藏/禁用编辑；只有真正设计了分支、版本和事实回滚语义后才开放编辑。

### 3.2 重试按钮：该基线未发现同类可见按钮

在 Next 基线中没有找到可见的 Retry/Reload/Regenerate 动作。因此不能把此前发现的重试问题继续记成当前基线缺陷。需要保留的防回归规则是：任何动作组件都必须有服务端 capability 或真实 transport，不能仅因 assistant-ui 模板提供 primitive 就展示。

### 3.3 选题：实现是真实约束选择，但没有产品接线

- `task-registry.ts:67-87` 给 Selector 只开放 `question_catalog`，不是提供任意数据库读写，也没有随机抽样作为最终决策。
- `selection-store.ts:536-658` 会解析模型决定，并在提交时检查最新意图 revision、active question slot、候选确实来自 catalog，以及硬约束仍成立；最后原子提交。
- 但基线中只有 `POST /api/learning/selection-intents`，没有 `web-next` 或 Pi 的生产调用，也没有 canonical learning message 的前端 reader。

**判定：算法不是伪实现，产品功能仍未实现。** 文档和进度汇报必须分别写“选择内核完成”和“产品链路完成”，不能用前者代替后者。

## 4. 隐藏省略与伪完成

### O-01（P0）P7 只接入了意图写入，Question 生命周期仍是后端孤岛

证据：

- 基线唯一学习 API 是 `POST /api/learning/selection-intents`：`src/services/api-next/src/index.ts:141`。
- 没有 `submit_attempt`、`skip_question`、`request_cut` 的 API；相关能力只存在于数据库函数、store 或测试。
- `selection-store.ts:730-807` 会写入 canonical `DomainUIPart` 和 `science_v3_canonical_message`，并声明 `submit_attempt`、`skip_question`、`request_cut`、`revise_intent` 四个 action slot。
- `web-next` 没有 canonical message/read model external store，也不消费 `editable`、`lock_reason` 或 `action_slots`。
- 帮助页仍明确说明下一题、后台评分、教学卡和 Dream 不在当前阶段：`src/apps/web-next/src/account-panels.tsx:381-386`。

影响：后端数据里看似已有完整交互语言，但用户不能真正操作；只看 Schema、迁移或 store 测试会错误判断 P7 已完成。

整改：先定义 P7 Query/Command API 与 capability receipt，再把 QuestionOpened → Attempt → Grade → Close → Next Selection 的真实读写链路接入 web。任何 action slot 在命令入口和 capability 判定完成前不得下发给 UI。

验收：从真实浏览器发起选题，页面读取同一 canonical message，提交一次 Attempt，刷新/换端仍读取同一状态，最终能看到评分、诊断状态和下一题；整个过程不得借用旧服务端点。

### O-02（P0）Task Registry 注册了九类任务，但多类任务没有生产可达性

`runtime-types.ts:1-14` 与 `task-registry.ts:46-150` 声明/注册九类任务。生产引用审计结果：

| Task | 基线状态 |
|---|---|
| `select_question` | 有工作流、执行器分支和提交路径 |
| `grade` | 有工作流和下游领域校验，但 Runtime 没有真正加载其声明的 output schema |
| `light` / `rem` / `deep` | 有 Dream 工作流和执行路径 |
| `diagnose` | 仅注册、类型和测试引用，没有生产触发 |
| `teach_summary` | 仅注册、类型和测试引用，没有生产触发 |
| `foreground_teaching` | 仅注册、类型和测试引用；没有独立前台 driver |
| `semantic_decomposition` | 仅注册、类型和测试引用；`allowedChildTasksWorkflow` 只在 Temporal 测试调用 |

唯一后台 Pi executor 在 `pi-task-executor.ts:116-120` 明确拒绝 `learning_action` 和 `delegate`，只支持 `question_catalog`、`read`、`grep`。因此即使把 `foreground_teaching` 或 `semantic_decomposition` 路由给它，也会因 capability 不支持而失败。

更隐蔽的问题是 Registry 引用了七个不存在的 Schema 资源：

- `grade-input`
- `diagnose-input`
- `teach-summary-input`
- `teach-summary-output`
- `foreground-teaching-input`
- `semantic-decomposition-input`
- `semantic-decomposition-output`

`contracts` 的现有测试只遍历实际存在的 Schema，因此无法发现 Registry 中的悬空 URL；`task-registry.test.ts:6-13` 也只断言 capability 数组，没有做可达性检查。

整改：把 Registry 从“配置表”升级为可执行插件目录。每个 TaskSpec 必须同时提供：trigger/workflow route、input codec、output codec、capability factory、skill、driver、领域 commit adapter 和至少一个生产形态测试。CI 启动审计应在任何一项缺失时失败。

### O-03（P0）诊断状态是声明过但永远不会收口的状态机分支

- 正常题目收口时 `question-store.ts:637` 写入 `diagnosticStatus = "unclassified"`；skip/abandon 写 `skipped`。
- 基线没有任何更新 `diagnostic_status` 的生产代码，`concluded` 与 `inconclusive` 从未产生。
- finalize workflow 在评分 child task 后直接提交 closure：`workflows.ts:244-310`，没有执行 `diagnose`。
- 确定性的 `compileAndProjectErrors` 已能生成错因证据，但它不等于已注册的诊断 Agent，也没有完成 closure 上的诊断状态语义。

影响：设计中“诊断完成或明确 inconclusive 后才能切题”的不变量没有由运行链路兑现。UI/下游若相信枚举定义，会永久等不到终态；若忽略它，则设计门禁形同虚设。

整改：二选一并明确迁移：要么将确定性错因归约定义为正式诊断并在同一事务写终态；要么真实路由 `diagnose` Task，在成功/耗尽时分别写 `concluded`/`inconclusive`。在此之前不得把诊断标为已完成。

### O-04（P0）教学 Question Card 不是 Science QuestionCard，证据字段没有消费者

- `pi-chat-runtime/extensions/learning-ui.ts:35-69` 注册模型工具 `present_question_card`。
- 对应 Skill 明确它只用于教学互动，不承担下一题、后台评分或 Dream。
- 用户作答后，前端先写 Pi `card-event`，再追加一条 JSON 文本消息；它不会创建 Science QuestionSession/Attempt。
- `evidence_policy: "eligible_if_independent"` 可以由模型发出，但基线没有任何 admission consumer；这是一个看起来像科学证据控制、实际没有效果的字段。
- 设计文档已指出 `present_question_card` 与 `present_learning_artifact` 的重叠需要收敛，正式 QuestionCard 应是 QuestionOpened 投影。

整改：将两类概念明确拆开或收敛：纯教学卡不得携带会被误认为 Science evidence 的字段；需要计入学习证据的交互只能通过 host command 创建 QuestionSession/Attempt，并由服务端决定 admission。工具名字、UI 标签和 Schema 都应反映真实语义。

### O-05（P0）Question Card 提交是两个客户端调用，不具备事务和刷新一致性

- `question-card.tsx:117-145` 顺序执行：记录 audit → `setSubmitted(true)` → 追加模型可见用户消息。
- 若第二步网络调用失败，audit 已提交且本地卡片已禁用，用户无法恢复或安全重试。
- `pi_card_events` 使用 `(thread_id, tool_call_id) on conflict do nothing`，但重复点击仍可能追加多条文本消息；审计记录保持第一条，转录却重复。
- 提交状态只是组件 `useState(false)`；没有读取 `pi_card_events` 的 GET/read model。刷新或换端后卡片重新可提交。
- Artifact publisher 生成并持久化 `interaction_token`，基线没有读取或验证它的路径；它是“安全感字段”，不是实际防重放能力。

整改：提供一个后端幂等 command：校验 interaction/capability token、写 card event、追加 canonical/user message，并返回稳定 receipt。UI 由 read model/receipt 渲染提交状态，不把组件 state 当事实源。跨存储时使用同一数据库事务或 outbox，不用两个 fetch 拼事务。

### O-06（P0）`sandboxed_html` 只有字符串黑名单，不是真正的浏览器隔离

- `artifact-publisher.ts:69-73` 用正则禁止 `fetch`、storage、cookie、form 等文本。
- HTML 由 `pi-chat-routes.ts:630-655` 在已认证应用同源直接返回，CSP 允许 inline script；前端通过 `window.open` 作为顶层同源页面打开，而非 opaque-origin sandbox iframe。
- `connect-src 'none'`、`form-action 'none'` 是有价值的防线，但动态属性访问、字符串拼接等能绕过源码正则；同源页面仍继承 origin 能力。名称 `sandboxed_html` 因此夸大了安全保证。

整改：可执行 Artifact 必须使用独立不受信任 origin，并以严格 sandbox iframe/opaque origin 展示；与主应用通信只走窄化、校验过的 `postMessage` 协议。静态 HTML 可用解析器和 sanitizer；允许任意 JavaScript 时，任何 sanitizer 都不能替代 origin 隔离。先完成隔离再开放交互 Artifact。

### O-07（P1）附件 UI 宣称支持任意文件，但若干格式只是 TODO

- `AttachmentAdapter.tsx:16` 留有 Word/Excel/PDF 读取 TODO，而 input 使用 `accept="*"`：`AttachmentAdapter.tsx:66`。
- 浏览器流程为 init → PUT → complete → register；上传 Map 在 register 前删除。register 失败后丢失可重试状态，服务端留下 ready object。
- 没有 abort/delete/过期 pending object GC 路径。
- 图片会转成完整 data URL；Pi materialization 通过 `response.arrayBuffer()` 整体载入，再写磁盘。上限 256 MiB 时存在明显内存放大。
- storage 主要比对声明 MIME 与对象元数据，没有内容 sniffing；Avatar 又走独立 base64 → DB `bytea` 路径，同样信任声明 MIME。

整改：UI 只 advertise 真正支持的类型；浏览器直传使用 Uppy Core + `@uppy/aws-s3`，服务端提供 abort/过期清理；物化使用 stream pipeline 和增量 hash；用 `file-type` 检查内容，头像用 `sharp` 解码、限像素并重编码。Avatar 最终也应进入统一 Object purpose/ref 模型，而不是继续形成第二种 blob 生命周期。

### O-08（P1）`/readyz` 是静态 200，不代表服务可接流量

`api-next`、`content-next`、`storage-next` 和 Pi 的 `lib.ts` 都把 `/healthz`、`/readyz` 实现为固定成功；没有检查 PostgreSQL、MinIO、Temporal 或必要上游。`learning-next` 没有同等健康端点，开发组合对其也没有可用性门禁。

整改：严格区分 liveness 与 readiness。统一依赖探针 registry，使用 `@fastify/under-pressure` 处理 event-loop/内存压力；ready 必须反映该进程的强依赖，弱依赖要显式降级而非伪装成功。

### O-09（P0，面向生产）开发默认认证配置没有生产拒绝机制

- `api-next/src/auth.ts:7-10` 提供开发数据库 URL、Better Auth URL、固定 secret 和单一 `DEV_TENANT` 默认值。
- 所有认证账号都会映射到这个 tenant。
- `changeEmail.updateEmailWithoutVerification` 为 true。
- 旧 contracts auth provider 仍描述 Keycloak/OIDC 和更宽角色，Next 实际使用 Better Auth 且角色更窄，存在协议漂移。

开发默认值本身可以保留，但进程必须有明确 `APP_ENV`/deployment mode；非 development 环境遇到默认 secret、默认 tenant、非 HTTPS base URL 或免验证改邮箱时应拒绝启动。认证 provider contract 也必须以 Next 实况为准收敛，不能让两套权威并存。

### O-10（P1）测试脚本和 README 给出了超过实际覆盖面的“绿色”

- `content-next` 有 `test` script，但实测 TAP 输出 `1..0`、0 个测试，退出码仍为 0。
- `deploy/dev/README.md` 将 `tests/e2e/current-state-smoke.sh` 与 `real-smoke.sh` 列作验证；前者使用旧端点/端口，后者默认旧 API 且只覆盖 KTQ/ER 内容链路。
- 它们不覆盖 Next 的教学评分、连续总结、Dream、计划或 P7 Question 生命周期，却被文字描述成更广的真实烟测。

整改：旧 smoke 可保留为旧链路退役前保护，但不能作为 Next 验收证据。新增 Next-only E2E；测试运行器必须在目标 package 发现 0 tests 时失败。README 的每项能力必须链接到具体测试用例，避免“脚本存在”等同“能力已验收”。

## 5. 跨职责重复机制与不必要手写

### R-01（P0）三套后台可靠执行引擎应收敛到 Temporal Task Runtime

| 职责 | 当前实现 | 重复的运行语义 | 主要问题 |
|---|---|---|---|
| Science/Dream | Temporal workflow/activity + outbox | claim、attempt、retry、timeout、恢复、提交 | 方向正确 |
| Content KTQ/ER/revision | 5 秒 `setInterval`、数据库 pending 查询、手写退避与两个近似 dispatcher | 同上 | 无 claim lease、`SKIP LOCKED` 或 batch limit；多副本会重复执行 |
| Pi 内容审查/研究恢复 | 进程内 Map、JSON marker 文件、transcript token 扫描 | 同上 | 重启、扩容、文件漂移时语义脆弱，状态权威分散 |

Content 的 pending SQL 返回全部 eligible rows，没有原子 claim/lease。两个 dispatcher 在 `content-next/src/index.ts:34-99` 高度同构，轮询在 `:284-297`，重试/退避又落在 `candidate-repository.ts:1086-1160`。Pi 则在 `pi-chat-routes.ts:105-230,280-460` 自建另一套恢复协议。

这不是“职责不同所以不能复用”。三者都属于非前台、可能失败/等待、需要恢复的 Agent 工作，应该成为统一 TaskSpec/Temporal Runtime 的不同 task/commit adapter：例如 `ktq_extract`、`er_research`、`content_revision`。领域数据仍由 Content activity 提交，review feedback 走 Signal/Update；不要把领域表强行合并。

允许保留的例外：Learning outbox → Temporal 的薄轮询桥是在事务提交与 workflow 启动之间传递 durable intent，职责明确；它不应扩展成第二套通用 job scheduler。

### R-02（P0/P1）前台 Pi、后台 Learning Pi、Content Pi 是三种 Agent Host，应共享执行内核

- `pi-chat-server.ts:20-193` 处理模型配置、认证文件、skills/extensions staging、workspace 和 session 生命周期。
- `learning-next/pi-task-executor.ts:20-335` 又实现 provider/default model、`models.json`、`auth.json`、workspace、工具和 session 生命周期。
- Content 后台任务则借用持久 Pi chat session 形成第三种执行形态。

建议建立 `@mathpilot/agent-execution`（名称可调整），只抽象真正相同的内核：

- `ModelRuntimeFactory`
- `TaskSpecResolver`
- `CapabilityRegistry`
- `SkillResolver`
- `WorkspaceMaterializer` / `WorkspacePolicy`
- `StructuredOutputGateway`
- attempt observer/audit
- `runAgentAttempt()`

在其上保留两个 driver：`InteractiveEpochDriver` 负责前台 token/event streaming，`TemporalActivityDriver` 负责后台 attempt/retry。不要为了“统一”把前台对话也强塞进 Temporal；应统一的是模型、能力、skill、工作区与结构化输出规则。

### R-03（P0）Task Registry 还不是唯一执行事实源

Registry 已包含 timeout、retry、capabilities 等良好基础，但 executor 仍用 if/else 手写工具工厂和输出 parser；foreground Pi 可加载更宽 extensions/all skills；Content 完全在 Registry 外；input/output schema 也没有被加载执行。

目标不是做巨型通用 service，而是让 Registry 驱动外围协议：

```text
TaskSpec = identity + workflow route + codecs + capabilities + skill/workspace policy
         + execution driver + domain commit adapter
```

领域 commit adapter 继续各自拥有 Question、Dream、Content 的事务与不变量。这样既避免复制 Runtime，又不会把不同领域的状态机抽成不可维护的万能表。

### R-04（P0）JSON Schema 被声明为唯一来源，却没有控制 HTTP 和 Agent 运行时

- 审计基线约有 57 个 Fastify route declaration：api-next 17、content-next 15、storage-next 5、Pi 20；没有发现 route-level `schema`。
- 服务端大量使用 `request.body as ...` 和手写 string/object/array 检查。
- `web-next/content-api.ts` 手写 DTO，与服务端没有生成关系。
- KTQ/ER 规则同时出现在 Python Skill 脚本和 TypeScript host validator，却没有 canonical KTQ/ER JSON Schema。
- `pi-task-executor` 的通用 respond schema 只是 `{ output: unknown }`；只有 select/light/rem/deep 有定制 parser。Grade 最终由 `question-store` 再做领域校验，这是必要防线，但 Registry 声明的 output schema 并未参与运行时。

整改分层：

1. 结构、枚举、格式、required 等由 canonical JSON Schema + Ajv/TypeBox 统一验证。
2. Fastify 采用 type provider，并从同一 Schema 生成 OpenAPI。
3. Web 使用 `openapi-typescript` + `openapi-fetch`（或 Orval，二选一）生成类型化 client。
4. Python 使用 `jsonschema` 读取同一文件；host 继续做 defense-in-depth，但不复制规则定义。
5. 跨记录、授权、RLS、版本冲突和学习证据规则继续由确定性领域校验实现。

不要再引入 Zod 作为第二套 transport truth。若 Zod 只用于局部表单，可限制在 UI；若当前未使用，应删除依赖。

### R-05（P1）Principal、内部服务认证和角色解析在三个服务重复

Content、Storage、Pi 各自定义 Principal、读取 shared secret 与 principal headers；允许角色的规则还不一致。现有共享 Principal contract 没被统一使用且本身已漂移。

建议创建 `@mathpilot/service-context` Fastify plugin：统一可信代理校验、principal/tenant/role/capability 解析、RLS context 和 outbound identity。长期用 `jose` 签发带 `iss/aud/exp/jti` 的短时内部 assertion，或使用 mTLS；原始 shared secret headers 只能作为过渡方案。

### R-06（P1）Pool 与 RLS transaction wrapper 重复，并造成隐形连接预算膨胀

- api/content/storage 的 `lib.ts` 各自重复 `createPool` 与 transaction 包装。
- Learning 的 runtime、question、selection、dream、relay store 分别创建 pool，并复制 `withTenant`；默认最大连接数相加可达 28。
- API 还有 Better Auth pool 与 app pool，各自持有连接预算。

建议由进程 composition root 注入共享 pool/repository dependencies，并提供一个 `withRlsContext`。Better Auth 若受 adapter 限制可保留独立 pool，但必须在一个显式 connection budget 中计算。可用 Kysely/Slonik 帮助普通 typed query composition，但不应为了 ORM 统一而重写复杂领域 SQL。

### R-07（P1）启动、配置、错误和健康检查应成为 service kit

四个服务有近似 `startService`；环境变量散落读取，错误 envelope、graceful shutdown、readiness 和依赖检查不统一。

建议 `@mathpilot/service-kit` 集中：

- `@fastify/env` 的启动时配置验证；业务模块不直接读 `process.env`。
- 统一 Pino context、request id、Problem Details/error mapping。
- graceful shutdown 和依赖生命周期。
- `@fastify/under-pressure` + dependency readiness registry。
- route schema/type provider 与 Swagger 注册。

这类代码看似每处只有几行，恰恰容易像此前登录 loading 一样造成不同步和视觉/运行缺陷；应由成熟插件与共享 bootstrap 解决。

### R-08（P1）Gateway proxy 和内部 HTTP client 重复手写，且默认缓冲响应

- `relayPi`、`relayContent`、`relayStorage` 基本同构。
- Gateway 除 SSE 外会把响应整体读入内存；大文件或未知非 JSON 响应不应经过这种缓冲。
- Pi/Content extensions 又重复 headers、secret、timeout 和 error decoding。

Gateway 使用 `@fastify/http-proxy`/`@fastify/reply-from` 处理 streaming、header hooks 和 upstream errors；内部调用使用生成 client 加统一 outbound middleware。Node fetch/Undici 已足够，不要仅为替换 fetch 引入 Axios。同步 HTTP 只对天然幂等或带 idempotency key 的操作做有限重试；耐久重试交给 Temporal。

### R-09（P1）前端手写路由、URL 状态和轮询，应交给 Router 与 Query

- `web-next/src/app.tsx:6-16` 用正则手写路由。
- `PiRuntimeProvider.tsx:32-64` 和 `account-menu.tsx:25-55` 分别手写 URL/history 同步。
- Content review 有两套 2 秒 polling loop：`content-review-page.tsx:81-102`。
- Better Auth `useSession` 之外又手写 `/api/me` fetch/loading，形成双 session truth。

采用 React Router Data Mode 管理路由、loader/action 和 history；采用 TanStack Query 管理 server state、缓存、失效、轮询、错误与重试。Better Auth 的自定义 session fields 或一个 Query principal endpoint 只能择一作为应用 principal 来源。复杂表单再引入 React Hook Form，简单双字段表单不需要为了统一而增加抽象。

这类替换不是为了减少几行代码，而是复用经过验证的并发、取消、stale、导航和 race-condition 语义。

### R-10（P1）对象生命周期被浏览器、Storage、Pi、Avatar 分成四套

当前同时存在浏览器自写直传状态机、storage-next object lifecycle、Pi 直接 MinIO client/归档物化、Avatar DB bytea。它们分别处理 MIME、命名、hash、过期、读取和授权，容易出现不同安全等级。

建议共享 `ObjectService/ObjectClient` port 和以下策略：purpose、owner/tenant、content length、declared/detected MIME、hash、pending/ready/expired、ref、retention。Pi thread archive 可以保留专用 adapter，但应实现同一对象 port；领域服务不应再直接拼 MinIO 细节。

### R-11（P1）路径和 sandbox policy 在多处重复，需共享安全原语而非找一个 `startsWith` 库

Learning executor、Content validation、Artifact publisher、OCR、sandbox launcher 和 Pi routes 都各自做 path containment、realpath、symlink 或 safe filename。职责不同，但共同面对 traversal、symlink 与 TOCTOU。

建议建立小而审计过的 path-policy 包：

- `resolveUnderRoot({ root, path, allowRoot, followSymlinks })`
- `openRegularFileUnderRoot(...)`
- 逻辑 POSIX ref 与 host path 的明确转换
- safe filename/relative path codec
- property-based traversal/symlink tests

不要用简单字符串 `startsWith`，也不要期望一个 `path-is-inside` 式库解决 symlink/TOCTOU。现有 `@anthropic-ai/sandbox-runtime` 应继续使用，不要重新手写 bubblewrap；两套 sandbox 配置应共享 `SandboxPolicyCompiler`/`SandboxProcessRunner`。

### R-12（P1）Artifact MIME、magic、manifest 与 renderer policy 重复

`artifact-publisher.ts` 手写 extension/MIME/magic、JSON/card 校验和浏览器文本正则；读取 route 又维护另一份 MIME 表。策略一旦新增格式，会在发布、读取、前端渲染之间漂移。

建立 `ArtifactPolicy/RendererRegistry`，统一扩展名、detected MIME、size、active/passive、renderer、download/open policy。使用 `file-type`、`mime-types`、Ajv 和 HTML parser/sanitizer 处理通用部分；交互 HTML 的可信边界仍必须由独立 origin 提供，不能用库名代替架构隔离。

### R-13（P1/P2）Command/receipt 生命周期重复，但不应抽成万能领域状态机

Science 已有较成熟的 operation/outbox/idempotency；Pi card 绕过它；Content 有独立 command/status/backoff；Storage 有 pending/ready。

可以共享 `CommandEnvelope`/`OperationReceipt` 协议：idempotency key、expected version、actor、status、retryable、resource refs、correlation ids。Question、Content、Object 的合法状态转换仍由各领域维护。不要创建一张通用 operation 表替代所有领域事务，也不要让 XState 成为服务端事实权威。

### R-14（P2）ID、canonical JSON、hash 与 cursor codec 缺乏统一政策

- 多处 `newId` 使用不同截断长度：API 约 48 bit、Content/Storage 约 80 bit。
- Learning 有四份近似 `idFrom` SHA helper。
- `jsonArtifact` 在 question/dream store 重复。
- durable hash 有的直接 `JSON.stringify`，有的手写 `sortJson`，稳定性语义不一致。

建立 ID policy/codec：外部实体优先完整 UUID；若引入 TypeID/ULID，要有真实排序/可读性需求和迁移设计。协议 hash 统一采用 RFC 8785 canonical JSON（如 `json-canonicalize`）。cursor 的业务排序语义保持领域独立，只共享编码、签名和错误处理。

### R-15（P2）CSV 和 migration runner 是已有成熟工具覆盖的手写基础设施

- `migrate-official-content.ts:24-43` 自写 CSV parser，难以完整覆盖 quoted newline、escape、BOM 等边界，改用 `csv-parse`。
- `db/migrate.sh` 没有统一 checksum/locking；Pi migrator 又以 table existence/idempotent SQL 形成第二种迁移协议。建议选择 SQL-first 的 dbmate（或等价成熟 runner）统一锁、顺序和状态表。

领域数据迁移的转换逻辑仍应自行实现并测试；替换的是 CSV 语法与 migration orchestration，不是领域规则。

### R-16（P2）可观测性有关联 ID，但没有统一 trace 传播

Pino 与领域 operation/workflow ID 已是良好基础，但基线没有发现一致的 `traceparent`、HTTP/Undici/pg/Temporal instrumentation。使用 OpenTelemetry Node SDK 和相应 instrumentation，把 request、operation、workflow、agent attempt、object operation 放到同一 trace/log context。不要替换 Pino，只补齐跨服务传播。

## 6. “用库”与“做抽象”的决策矩阵

| 问题边界 | 首选方案 | 原因 | 不应做的事 |
|---|---|---|---|
| Durable background Agent | 已有 Temporal + 扩展 Task Registry | 可靠执行语义已经存在 | 再引入 BullMQ/自写 cron/job lease 形成第四套 runtime |
| 前台/后台 Agent 共性 | 自有 `agent-execution` kernel + 两个 driver | Pi/业务 policy 是项目特有，但执行外围可复用 | 强迫前台 streaming 进入后台 workflow |
| HTTP 结构验证 | Fastify type provider + TypeBox/Ajv + Swagger | 复用协议/类型/文档生态 | body cast + 手写 primitive validator；再建第二套 Zod transport schema |
| Web API client | `openapi-typescript` + `openapi-fetch`，或 Orval | 消除手写 DTO/fetch/error 漂移 | 同时使用多个 generator |
| Router/navigation | React Router Data Mode | history、loader/action、错误和取消语义成熟 | 正则路由与分散 `pushState` |
| Server state | TanStack Query | cache、dedupe、stale、polling、retry、invalidation | 每页复制 useEffect/setInterval/loading/error |
| Gateway proxy | `@fastify/http-proxy` / reply-from | streaming/header/upstream error 已实现 | 将所有响应 buffer 后转发 |
| Config/readiness | `@fastify/env`、`@fastify/under-pressure` | 启动校验与压力探针成熟 | 散落 `process.env`、静态 ready 200 |
| Browser upload | Uppy Core + `@uppy/aws-s3` | 上传状态、取消、重试、恢复成熟 | 自写 Map + 多 fetch 状态机 |
| 文件识别/图片 | `file-type`、`mime-types`、`sharp` | magic/解码/像素限制是通用安全问题 | 只信声明 MIME 或继续扩展 magic if/else |
| HTML 静态清理 | parser + DOMPurify/sanitize-html | DOM 级处理优于 regex | 声称 sanitizer 可安全承载任意 JS |
| 交互 HTML | 独立 artifact origin + sandbox iframe | 这是架构安全边界 | 在主应用同源靠字符串黑名单 |
| Internal identity | `jose` 短时 assertion 或 mTLS | audience、expiry、rotation 有成熟协议 | 永久 raw secret + 任意 principal headers |
| Canonical JSON | `json-canonicalize` | 持久 hash 需要标准字节语义 | 多份 sortJson/JSON.stringify 约定 |
| CSV | `csv-parse` | 边界覆盖成熟 | 继续完善自写 parser |
| DB migrations | dbmate/等价 SQL-first runner | locking、checksum/order 是通用基础设施 | 每个服务一套 table-exists 协议 |
| Path containment | 项目共享、审计过的安全原语 | root/symlink/TOCTOU policy 与本项目 workspace 结合 | 只换成一个字符串路径库便宣称安全 |
| 学习 reducer/证据/选题门禁 | 保留确定性领域代码 | 属于 MathPilot 核心语义 | 用通用工作流/ORM/LLM prompt 取代 |

相关一手文档：

- [React Router Data Mode / custom framework](https://reactrouter.com/start/data/custom)
- [TanStack Query queries](https://tanstack.com/query/latest/docs/framework/react/guides/queries)
- [Fastify Type Providers](https://github.com/fastify/fastify/blob/main/docs/Reference/Type-Providers.md)
- [Fastify HTTP Proxy](https://github.com/fastify/fastify-http-proxy)
- [Fastify env](https://github.com/fastify/fastify-env)
- [Fastify under-pressure](https://github.com/fastify/under-pressure)
- [Fastify Swagger](https://github.com/fastify/fastify-swagger)
- [Uppy AWS S3](https://uppy.io/docs/aws-s3/)

## 7. 建议的抽象边界

以下是边界建议，不要求一次性创建所有 package；先随整改落地最小接口，再由第二个真实消费者证明抽取价值。

| 建议边界 | 拥有什么 | 不拥有什么 |
|---|---|---|
| `contracts` runtime schema registry | canonical Schema、Ajv validator、OpenAPI component、Task codec 查找 | 领域数据库事务 |
| `agent-execution` | model/session、skill、capability、workspace、structured output、attempt audit | Question/Dream/Content 状态转换 |
| Temporal Task Runtime | durable attempt、retry、timeout、signal/update、workflow route | 前台 token streaming；领域表通用化 |
| `service-context` | principal、tenant、role/capability、internal assertion、RLS context | Better Auth UI/账号业务 |
| `service-kit` | config、bootstrap、logging、error、shutdown、readiness、schema plugin | 各服务业务 route |
| `postgres`/DB context | 共享 pool、transaction、RLS wrapper、连接预算 | 强制所有 SQL 经过 ORM |
| `object-client` | object purpose/ref、stream、hash、MIME、lifecycle、授权调用 | Pi archive 的领域布局 |
| `path-policy` | root containment、regular-file open、logical ref、filename | sandbox 产品策略本身 |
| `artifact-policy` | manifest、format、MIME、renderer、active/passive policy | 可执行内容的同源信任 |
| generated clients | transport types、request/error/trace/idempotency middleware | React 页面状态与领域决策 |

一个重要约束：**先抽运行机制，再保留领域 adapter。** Dream 与选题职责不同，但都通过后台 Agent 完成，因此共享 Task Runtime；它们产生的状态和提交不变量仍分别属于 DreamStore 与 SelectionStore。Content 同理。

## 8. 整改顺序

### 第一批：阻止错误能力暴露与安全边界失真

1. 隐藏/禁用没有 capability 的历史编辑和未接通 action slots。
2. 将交互 HTML 移出应用同源；在完成前降级为下载或静态、不可执行预览。
3. 把 Pi card 双调用改为单一幂等 command + receipt/read model。
4. 对非开发环境增加认证配置 fail-fast。
5. 给 Task Registry 增加 schema existence + reachability 启动/CI 检查，未接通任务不得宣称完成。

### 第二批：完成真正的 P7 产品闭环

1. 建立 canonical message/read model API。
2. 接入 selection intent、QuestionOpened、Attempt、grade/diagnose/close 和 next selection。
3. 明确诊断是确定性 reducer 终态还是 Agent task 终态，并实现唯一方案。
4. 将 Dream/总结/教学能力以真实 capability 和读模型接入，而不是直接在 UI 放按钮。
5. 建立 Next-only 浏览器 E2E 和真实服务 E2E。

### 第三批：收敛可靠执行与 Agent Host

1. 先把 Content 的一个后台任务迁到现有 Temporal Task Runtime，验证 TaskSpec + domain commit adapter。
2. 将剩余 Content poller、手写 backoff、Pi marker/Map/transcript recovery 逐步移除。
3. 从 foreground Pi 与 background executor 抽取 `agent-execution` kernel；保留两个 driver。
4. 让 Task Registry 真正提供 codecs、capabilities、skill/workspace policy 与 driver route。

### 第四批：用成熟库替换横向基础设施

1. Fastify runtime schema/OpenAPI/generated clients。
2. React Router + TanStack Query，移除正则路由和手写 polling。
3. Fastify proxy/config/readiness/service context。
4. Uppy/object lifecycle/stream/file detection/avatar decode。
5. CSV/migration/canonical JSON/telemetry。

每批完成后删除被替代路径，避免“新抽象加上了，但旧实现仍在跑”的双轨状态。

## 9. 必须加入的自动化守门

### 9.1 功能可达性

- 每个 UI action：必须有 capability、transport、server command、receipt/read model；否则构建或测试失败。
- 每个 TaskSpec：必须有存在的 input/output schema、skill、生产 trigger、executor/driver、commit adapter 和测试。
- 每个状态枚举终态：必须至少有一个生产写入路径和状态机测试。
- 每个 tool 参数：必须有 host consumer；无消费者字段从 Schema 删除。

### 9.2 Schema 与 transport

- route schema 覆盖率 100%，禁止新增无 Schema Fastify route。
- 禁止业务 route 中直接 `request.body as` 绕过 validator。
- 禁止 web 页面直接手写服务 DTO；只能经 generated client 或批准的 adapter。
- canonical Schema 在 TypeScript、Python 和 OpenAPI 上跑相同 golden fixtures。

### 9.3 可靠执行与资源生命周期

- 禁止新增服务级 `setInterval` job runner；仅允许列入 allowlist 的薄 outbox relay。
- 禁止用进程内 Map、marker file 或 transcript token 作为 durable authority。
- 所有后台 Agent task 必须能在进程被 kill、activity 重试和多副本竞争下保持幂等。
- 上传必须覆盖 init 后放弃、PUT 失败、complete 失败、register 失败、重复 complete、过期清理和跨端读取。

### 9.4 架构漂移

- 用 dependency-cruiser 检查 package/service 边界。
- 用 jscpd 捕捉文字级复制，但不能把它当作全部重复检查。
- 用 Semgrep 或 ESLint custom rule 禁止：业务模块裸读 `process.env`、页面裸 fetch、route 无 schema、随意创建 `Pool`、服务 worker `setInterval`。
- 维护“运行机制清单”，人工/架构测试审查跨职责相似流程；这是发现 Dream/选题/Content 同类 Runtime 的关键，clone detector 无法替代。
- 用 fast-check 覆盖 path、canonical JSON、cursor、idempotency 和状态机性质。

### 9.5 测试真实性

- package `test` 若收集到 0 tests 必须失败。
- Next E2E 必须从 `web-next → api-next → learning/Pi/content/storage` 走正式链路。
- 至少覆盖：登录、创建线程、附件、选题、QuestionOpened、刷新恢复、提交一次 Attempt、幂等重试、评分/诊断、切题、Dream 可见结果。
- README 的每项“已完成”必须链接测试或可复现证据；局部 unit test 不能替代产品 E2E。

建议工具并非全要同时安装：边界用 dependency-cruiser，字面 clone 用 jscpd，禁止模式用 ESLint/Semgrep，性质测试用 fast-check，浏览器链路用 Playwright。它们覆盖不同失败模式，不能互相替代。

## 10. 已做对、应继续保留的部分

本次审计不建议把所有自有代码都换成库。以下方向是正确的：

- Temporal 用于 Science/Dream 的可靠后台运行，应该扩展复用而不是另换队列。
- Selector 采用 catalog 限权、候选来源验证、revision/slot/hard-constraint 二次检查和原子提交，是真实约束选题。
- Grade 结果进入领域 store 前再次进行确定性语义校验，是必要的 defense-in-depth。
- `ts-fsrs`、pyBKT golden tests、Pi SDK、assistant-ui、Better Auth、MinIO SDK、sandbox runtime、Base UI/Radix、ReactMarkdown/KaTeX 等成熟能力已经采用，应围绕它们收敛而非重写。
- 自定义领域 reducer、证据消费门禁、RLS、Question/Dream 状态转换和原子事务属于核心业务，应保持显式、确定性和可测试。

应采用的总原则是：

> 并发、协议、安全、可访问性、解析、上传、缓存、迁移和生命周期优先使用成熟库；跨职责但运行机制相同的流程抽成统一 kernel/service/runtime；MathPilot 独有的学习语义保留为领域代码。

## 11. 验证记录与限制

辅助验证结果：

- 全仓 typecheck：通过。
- `learning-next` 与 `pi-chat-runtime` 测试：27 个通过，5 个需要数据库的 integration test 跳过。
- `content-next` test script：退出 0，但收集 0 个测试，属于绿色占位而非覆盖证明。

这些结果只说明现有类型和局部 suite 状态，不证明真实 Next 产品闭环。静态审计还不能替代以下动态验证：多副本 worker 竞争、服务中途被 kill、MinIO/Temporal/PostgreSQL 故障注入、交互 Artifact 浏览器攻击测试、256 MiB 附件内存曲线和真实跨端恢复。它们应在相应整改批次加入。

复现基线证据时应直接读取固定提交，例如：

```sh
git show ad48c0ca029a800166021a357e82a03f8ad883d8:src/services/learning-next/src/task-registry.ts | nl -ba
git grep -n 'diagnostic_status' ad48c0ca029a800166021a357e82a03f8ad883d8 -- src db
nix develop path:/home/tangent/MathPilot -c pnpm typecheck
```

最后，本文不是对基线之后 P7 工作的否定。后续若某项已在新提交实现，应以本文验收条件逐项关闭，而不是直接删除问题描述；这样才能确认“声明、执行、持久化、消费和测试”五个环节都真正闭合。
