# MathPilot Next 实现收敛与复用治理 Goal

> 用途：承接 Science v3 P7 的用户明确未完成移交，统一关闭 Next 路径中的隐藏省略、伪能力、重复运行机制与不必要手写基础设施。
> 状态：`active`（2026-09-01）；G0 handoff baseline 已建立，当前执行防误修复验与基线冻结。
> P7 权威 Goal：[科学内核与 Dream 配套前端实施 Goal](./科学内核与Dream封版v3/GOAL.md)
> 唯一审计输入：[Next 实现整合审计 v3](./Next实现隐藏省略设计忠实度与复用整合审计v3.md)
> 历史审计：v1、v2 补充与忠实度 v1 已 superseded，只可沿 v3 的裁决追溯，不得直接生成任务。
> 设计权威：[科学内核与 Dream 封版设计 v3](./科学内核与Dream封版v3/README.md)

## 1. 启动条件与启动命令

### 1.1 不与 P7 抢写

当前 P7 已按用户于 2026-09-01 的明确指令停止在合理收尾边界，并作为未完成 Goal 移交。这个 Goal 的启动条件为：

1. 当前 P7 Goal 已完成，或用户明确终止/移交；
2. P7 形成一个可复现的干净 handoff commit；
3. 当前工作树中属于用户或其他开发者的未提交改动已识别并受到保护；
4. 本文件第 5 节的 P7 交接复验已创建初始 ledger。

上述条件已经满足：代码基线为 `70999cdfaff11c351fa7e9bf0771b50040518e01`；第 5 节已初始化；四份用户审计文档先被识别并保护，后按用户“把 Git 整理干净”的明确指令在 `8548c05e11ec8496c52e34c84c1f8322a01340d5` 原样纳入版本控制。以后不得回到 P7 脏工作树补写结论，只能从可复现提交继续。

### 1.2 Goal 启动命令

```text
/goal start 在当前 P7 Goal 完成或由用户明确终止/移交并记录干净 handoff commit 后，实施 design-docs/Next实现收敛与复用治理GOAL.md：只以 design-docs/Next实现隐藏省略设计忠实度与复用整合审计v3.md 为审计入口，先执行防误修门并在 handoff commit 上重放，只处理仍开放的 Next 问题；以用户最新 steering 和科学内核 v3 设计为权威，优先复用成熟库、按共同运行机制抽象重复实现、保留显式领域语义，删除被替代路径，直到生产事实链、安全、可达性、契约、可靠执行、前端一致性和真实 Next E2E 的全部终态证据成立。
```

这是一个单一治理目标，不是一份可任选的建议清单。阶段可以按依赖并行，但不得以完成某个 package、添加某个库或通过窄单测替代终态验收。

## 2. 单一目标

在 `/home/tangent/MathPilot` 正式 Next 链路中做到：

- 每个用户动作、DomainUIPart、TaskSpec、状态枚举和安全承诺都具有真实生产入口、执行路径、持久化结果、消费者和测试；
- 通用的并发、协议、安全、解析、缓存、上传、迁移、可访问性和生命周期能力使用成熟库，不再以少量手写代码复制其语义；
- 不同职责但运行机制相同的实现共享 kernel/service/runtime，例如 Dream、选题和 Content 后台 Agent 共享耐久 Task Runtime；
- MathPilot 独有的事实、证据、选题硬约束、Question/Dream reducer、RLS 和领域事务仍然显式、确定性、可重放；
- JSON Schema、Task Registry、数据库事实和 Temporal 分别成为它们声明负责范围内的真实运行时权威，不再与手写旁路双轨；
- 被新实现替代的旧 Next 路径在同阶段删除，不留下第二套权威、长期兼容层或“暂时仍可调用”的死入口；
- 最终由真实服务 E2E、故障恢复、权限和可访问性证据证明系统行为，而不是由文件、按钮、注册项或测试脚本名称证明。

## 3. 权威来源、范围与基线纪律

### 3.1 权威优先级

发生冲突时按以下顺序处理：

1. 用户在本 Goal 会话中的最新明确 steering；
2. 本 Goal 的目标、边界、设计纪律和终态条件；
3. [科学内核与 Dream 封版设计 v3](./科学内核与Dream封版v3/README.md) 及 01–07 主题文档；
4. 已经批准且仍适用的专项设计，如 KTQ/ER、Pi Runtime 和对象边界文档；
5. [Next 实现整合审计 v3](./Next实现隐藏省略设计忠实度与复用整合审计v3.md) 作为唯一问题入口；其自身也不是产品设计权威；
6. P7 handoff commit 的代码、迁移和测试用于判断当前实况，不能反向改写设计不变量；
7. 旧实现只用于迁移溯源，不作为 Next 的复用目标、兼容目标或验收证据。

若审计建议与设计冲突，先修正审计结论；若确实发现设计缺口，先更新对应主题文档，再实现代码。不得让重构代码暗中成为新设计。

### 3.2 审计基线复核

| 材料 | 可复现性 | 本 Goal 的使用方式 |
|---|---|---|
| 整合审计 v3：锚点 `fcd108b449d93db4106ea55eb01a0d4870f7ca8e` | 可复现 | 唯一审计入口；保留已确认、纠正、设计决策与 P7-pending 分类 |
| 历史 v1：`ad48c0ca029a800166021a357e82a03f8ad883d8` | 可复现但过时 | 仅沿 v3 链接追溯原始证据 |
| 历史 v2/忠实度 v1：`dc61617 + 未提交工作树` | 不可完整复现 | 禁止直接实现或关闭条目；只作误判与线索档案 |
| P7 移交前工作树 | 已冻结 | 只用于追溯 `p7-pending`，不用于关闭问题 |
| `P7_HANDOFF_COMMIT=70999cdfaff11c351fa7e9bf0771b50040518e01` | 可复现 | 本 Goal 唯一代码现状基线 |
| `G0_AUDIT_INPUT_COMMIT=8548c05e11ec8496c52e34c84c1f8322a01340d5` | 可复现 | 四份审计输入原样入库后的治理审计基线 |

以后所有问题关闭记录必须包含 commit、路径、测试或运行证据。禁止再次使用“HEAD + 未提交改动”作为审计基线。

### 3.3 范围

必须覆盖正式 Next 链路：

- `src/apps/web-next`
- `src/services/api-next`
- `src/services/pi-chat-runtime`
- `src/services/content-next`
- `src/services/storage-next`
- `src/services/learning-next`
- 它们直接消费的 `src/packages/*`、`db/` 与 `deploy/dev/`

旧 `learning/profile/agent-runtime` 等退役路径不做内部质量重构；只在依赖图、compose 或验收仍错误引用它们时删除连接。

不扩张到新产品功能、外部生产发布、真实数据迁移或无关页面重做。Content 纳入范围是因为它属于正式 Next 链路且重复了可靠 Agent Runtime，不是要在本 Goal 重做全部内容产品。

## 4. 整合审计裁决摘要

本节是 [整合审计 v3](./Next实现隐藏省略设计忠实度与复用整合审计v3.md) 的 Goal 摘要。历史 v2 的主要价值是发现 P7 新代码继续复制了 Schema 校验、pool、SSE、ID/hash 和前端 server-state 等机制，并补充了对象归档、KTQ/ER 校验、Artifact index 等风险；忠实度 v1 又发现了生产事实链断裂。但三篇历史文档都不是可以原样执行的任务单。

### 4.1 隐藏省略条目裁决

| v2 条目 | 复核裁决 | 新 Goal 处理 |
|---|---|---|
| O-11 发送失败静默丢消息 | `7843ab8` 确认 | 属于 P7 退出条件；失败时保留草稿/乐观消息并进入 assistant-ui 原生 incomplete/error 状态 |
| O-12 取消后结果仍落盘 | **原影响判断不成立，范围收窄** | API 确实未向 Temporal 传播取消，但 `mathpilot_science_v3_commit_foreground_response` 会拒绝 terminal request，foreground 结果不能在取消后提交。治理取消传播、算力浪费、完成延迟和其他 operation 的一致取消协议 |
| O-13 evidence HMAC 默认密钥 | 确认，且下游 ACL 二次鉴权降低了直接危害 | 与生产配置 fail-fast 合并；非 development 必须提供独立 secret，默认 secret 只能存在于显式 dev profile |
| O-14 `present_validated_artifact` 名不副实 | 确认 | 接入真实 canonical artifact schema 校验，或去掉 `validated` 承诺；不能只验字段形状和 schema 名字正则 |
| O-15 Workflow 失败后无限重启 | **撤销** | `@temporalio/client` 1.23.0 在未提供 `options.retry` 时发送 `retryPolicy: undefined`；未捕获的 `TemporalFailure` 会令 Workflow Execution 失败，不会自动创建无限新 run。不得为修复此伪问题反而添加 Workflow retry。补终态行为测试，并单独防范普通编程错误造成 Workflow Task 反复失败 |
| O-16 action slots/capability 双轨 | `7843ab8` 确认，P7 正在修改相关面 | 属于 P7 交接复验；capability 必须从同一领域状态生成，静态 slot 不得与命令受理条件矛盾 |
| O-17 `content_package.withdrawn` 无生产者 | 事实存在，语义结论不足 | 先由 KTQ/ER 设计裁决 `withdrawn` 是包级撤回还是 release 派生状态；不能擅自把“最后一个班级撤销”等同全局撤包 |
| O-18 无 reader 的 provenance 字段/对象 | **部分撤销** | `model_id`、`prompt_version`、`content_source` 是设计明确要求的审计溯源，不能删除。只审理确无设计职责的未使用 view/index；审计字段可通过教师/技术审计面消费，但不因没有普通 UI reader 判死 |
| O-19 `interaction_token` 生成即弃 | 确认 | 接入真实 capability/幂等校验，或从 Schema/manifest 删除，不保留安全感字段 |
| O-20 `dedup_action/duplicate_of` 无 host consumer | 确认 | 由 canonical KTQ/ER Schema 驱动 host 分支与测试；未实现前不得让模型字段冒充已去重 |
| O-21 `seed.sql` 非幂等阻塞 compose | **撤销** | v2 混淆了 fixture `seed.sql` 与 compose 默认挂载的 `bootstrap.sql`。`bootstrap.sql` 使用 existence guard/`ON CONFLICT`，fixture 也有 `ON CONFLICT`，不能据此实施重写；保留一次真实 down/up 回归即可 |

O-15 的修正依据是当前官方 TypeScript SDK 实现：[Workflow start 仅在显式提供 retry 时编译 RetryPolicy](https://github.com/temporalio/sdk-typescript/blob/main/packages/client/src/workflow-client.ts) 和 [Workflow failure handling](https://github.com/temporalio/sdk-typescript/blob/main/packages/workflow/src/internals.ts)。本仓库锁定的 1.23.0 安装代码也使用 `options.retry ? compileRetryPolicy(...) : undefined`。

### 4.2 手写与重复条目裁决

| v2 条目 | 复核裁决 | 新 Goal 处理 |
|---|---|---|
| R-17 两套手写 SSE | 确认 | 采用已核验的 [`@fastify/sse`](https://github.com/fastify/sse) 负责帧、心跳、断开、backpressure、Last-Event-ID/replay；数据库 fan-out 另用 sequence catch-up + LISTEN/NOTIFY 等通知适配，插件不能替代事件源 |
| R-18 Avatar 信任 MIME | 内容校验问题确认；“已证明存储型 XSS”表述过强 | `file-type` + `sharp` 解码/限像素/重编码、前端 size guard、`nosniff`；用浏览器安全测试确定真实 exploit，不以推测替代证据 |
| R-19 KTQ/ER 校验四份并漂移 | 确认，高优先级 | canonical JSON Schema + Ajv host validator + Python `jsonschema` + 同一 golden fixtures；禁止默认值吞非法枚举/范围 |
| R-20 foreground 三套校验与 reason 漂移 | 确认，P7 相关 | canonical schema 进入工具输入、Agent 输出和 commit 前运行时；仅跨记录/权限绑定保留领域校验 |
| R-21 归档跟随 symlink | 确认，严重性提升为 P0 | 模型可在 sandbox workspace 造 symlink，archive 在 sandbox 外跟随；先拒绝 symlink、校验 object key containment、限并发，再做共享 path/object abstraction |
| R-22 附件物化全量入内存 | 确认 | stream pipeline、增量 hash、读取中限幅、临时文件原子 rename、取消和超时测试 |
| R-23 UUID/Math.random 回退 | 低优先级确认 | 明确浏览器/Node platform contract；支持 `crypto.randomUUID` 时删回退，否则使用经审计 UUID 库，不维护自写 v4 |
| R-24 offset cursor 双轨 | 确认，但排序语义不得通用化 | 共享签名/编码/error codec，各领域使用稳定 keyset；多 kind 分页必须明确支持或拒绝，不静默回第一页 |
| R-25 三套错误类与默认 500 | 重复与泄漏风险确认；“一个 AppError 类”方案过度 | 共享 Problem Details/error mapping 协议和 Fastify handler；领域错误类型可保留，不能做万能错误类 |
| R-26 shared secret 普通比较 | 确认，低成本 | 统一 internal assertion/service-context；过渡 secret 使用恒定时间比较 |
| R-27 rate limit/安全头/CORS | **拆分** | 按 threat model 配置 rate limit 与安全头；同源应用缺少 CORS 插件不是缺陷，除非确有跨域需求，不为“插件齐全”放宽同源边界 |
| R-28 compose 健康门禁 | 确认 | 真实 readiness + MinIO/服务 healthcheck；强依赖使用 `service_healthy`，弱依赖显式降级 |
| R-29 Dockerfile 缓存双模板 | 确认，维护项 | 共享构建约定/模板，先复制 manifest 安装再复制源码；不把缓存优化冒充功能修复 |
| R-30 无 CI | `7843ab8` 确认 | 最小 CI 必须先承载 schema/reachability/0-test/typecheck/test；再加 clone/boundary/property/E2E 守门 |
| R-31 contracts TS/Schema 双源 | 确认 | JSON Schema 保持唯一来源，选择并钉住 schema→TS 生成器，CI 验证生成结果无 diff；不反转为第二套 Zod 权威 |
| R-32 shell 转义/魔数进程 | 魔数重复确认；argv 方案需适配器验证 | `file-type` 进程内识别；优先使用不经 shell 的 argv API，若 sandbox SDK 只接受字符串则封装并性质测试，不凭口号替换 |
| R-33 Artifact index 竞态/非原子 | 确认 | 单 writer/锁或数据库索引、tmp+fsync/rename 原子发布；GET 只读已发布索引，不触发全目录重发布 |
| R-34 前端残留手写/死代码 | 混合结论，且与 P7 工作树重叠 | Query、navigate、principal 单一来源、generated client 属实；`surfaces.tsx` 是 07 指定的视觉语言基础，不能仅按零引用整包删除。P7 交接后按导出粒度复验 |
| R-35 Attachment turn 崩溃窗口 | 确认 | 以 turn ID 和原子状态转换绑定，不能以 prompt 全等作为身份 |
| R-36 frozen KTQ N+1 | 确认，性能项 | 批量 SQL/LATERAL 或 repository batch；用 query-count 与数据量基准验收 |
| R-37 Content 命令无终态/DLQ | 确认，归入统一 Runtime | 不继续完善自写 job 表；迁 Temporal 后由 task outcome、retry policy、history 与告警承担 |
| R-38 P7 零自动化测试 | `7843ab8` 确认，但 P7 正持续补实现 | P7 handoff 必须重计；仍缺的 route、browser、refresh/idempotency/a11y 测试由本 Goal 补齐 |

### 4.3 v1 继续承接的主问题

除已由 P7 明确关闭的历史编辑、旧 QuestionCard 双调用、正则主路由和“大部分 P7 后端孤岛”外，下列 v1 结论仍作为候选进入 handoff 复验：

- Task Registry 的悬空 Schema、不可达任务和 executor/codec 双轨；
- 诊断状态终态与 `diagnose/teach_summary/semantic_decomposition` 的真实产品职责；
- Pi 教学卡、`evidence_policy` 和 canonical Science card 的边界；
- 同源 `sandboxed_html`、附件/对象生命周期、生产认证默认值和静态 readiness；
- 三套后台 Agent 可靠执行、三种 Agent Host、六个 Learning pool；
- HTTP route 无运行时 Schema、Principal/config/proxy/path/MIME/ID/hash/migration/telemetry 重复；
- Content 0-test 绿色、旧 smoke 冒充 Next E2E 和缺少质量守门。

任何“P7 已经修了”都必须在 handoff ledger 中给出当前证据，不因历史审计或当前脏工作树自动关闭。

### 4.4 忠实度审计复核裁决

必须优先恢复以下生产事实链：

- `C-01`：FinalizeQuestion 的诊断硬门；正常关闭不能永久以 `unclassified` 占位；
- `C-02`：DiagnosticClaim/DiagnosisOutcome → ErrorEvidence → 错因消费的生产链，fixture 不算生产者；
- `C-03`：RetentionUnit revision/measurement rule 的可追溯种子与 R/复习队列生产链；
- `C-05/C-06`：AnswerReceipt 与真实 Agent context manifest 属于 P7 handoff 必验面，不抢写在途文件。

忠实度 v1 的其余发现按整合审计 v3 处理：

- D-06～D-33 是有条件的功能/设计线索，须核对当前阶段、生产可达性和 P7 handoff；
- D-34～D-62 中的契约、数学渲染、内容 host semantics、a11y、导出、CI 等保留为问题族；
- 旧 `apps/web`、旧 student profile、阶段外发布索引和脏工作树未跟踪状态不构成当前 Next 缺陷；
- dormant capability、304、Copy/Export、StudentTrait、`/api/pi/*` 等必须先核对可达性或 owning 设计，禁止按历史措辞盲修。

### 4.5 防误修门

任何条目进入 implementation 前必须记录：干净 commit、当前权威要求、production trigger→write→consumer 链、反证、影响强度、成熟库/已有平台评估、P7 文件归属和可验证验收。缺一项只能保持候选，不能修改代码。

特别禁止：

- 为撤销的 O-15 添加 Workflow retry；
- 删除设计要求的 provenance；
- 为同源应用机械添加 CORS；
- 因零引用删除 `surfaces.tsx` 整体或恢复旧前端事实源；
- 把 Content poller 因“旧文档写过”视为不可替换。用户最新的统一 Runtime 要求优先，须先修订 KTQ/ER owning 设计再迁移。

## 5. P7 交接复验 ledger

### 5.1 P7 handoff baseline

- `P7_HANDOFF_COMMIT`：`70999cdfaff11c351fa7e9bf0771b50040518e01`。
- 移交原因：用户于 2026-09-01 明确要求在合理完成当前在途 P7 tranche 后转入本 Goal。
- 旧 Goal 状态：`transferred-by-user, incomplete`；这不是 P7 或旧 Goal 的完成声明。
- 已验证边界：四包定向 typecheck 退出 0；contracts examples/权限守门通过；learning-next 28 项中 23 项通过、5 项数据库环境测试跳过；api-next teaching-artifact 2 项通过；web-next production build 通过（3193 modules）；真实 PostgreSQL hydration SQL 解析成功；隔离 Next 栈五个健康入口返回 200，learning worker 为 `RUNNING`。
- 工作树归属：本 Goal 文件经用户明确授权纳入交接；四份用户审计材料在 handoff 时保持未修改、未暂存，随后按用户明确指令以 `8548c05e11ec8496c52e34c84c1f8322a01340d5` 原样提交。当前工作树无未提交归属歧义。
- 基线规则：只有 handoff commit 中已提交且有当前证据的窄子项可关闭；mock-only、跳过测试、静态代码存在或移交前脏工作树不算完整证据。

| 候选 | 状态 | handoff 当前事实 | 本 Goal 剩余验收 |
|---|---|---|---|
| C-01 诊断硬门 | `open` | 正常关闭仍由 `question-store.ts` 写 `diagnostic_status='unclassified'` | G2 建立 `concluded/inconclusive/skipped` 生产终态并拒绝永久 unclassified |
| C-02 错因事实链 | `open` | reducer/compiler 存在，但 DiagnosticClaim/DiagnosisOutcome 的生产 insert 仍仅见测试 fixture | G2 接通 diagnose/probe → claim/outcome/evidence → reducer/read model/next action |
| C-03 RetentionUnit 事实链 | `open` | RetentionUnit/rule 的 insert 仅见 scientific-core fixture；官方内容导入没有 writer | G2 为官方/教师内容建立可追溯 unit/rule，并证明真实 Attempt 进入 R/复习队列 |
| C-05 AnswerReceipt | `open` | 服务端创建 canonical receipt，Web 有 renderer | 补 route、丢回包幂等、refresh/cross-device replay 证据 |
| C-06 context manifest | `open` | 实际 WorkspaceProjection manifest 已持久化，read model/UI 已读取 | 补“实际注入 items = 显示 items”、ACL、刷新和失败降级集成证据 |
| O-11 发送失败状态 | `open` | send catch 仍清空 pending，失败消息/附件消失 | G2/G5 保留 draft/attachment/failed message，支持同 key 安全重试 |
| O-12 取消传播（修正版） | `open` | DB terminal guard 存在；API 取消仅改 DB，没有传播到对应 Workflow/Activity | G4 补传播、竞态与幂等测试 |
| O-14 validated teaching artifact | `closed-by-p7` | exact math-derivation Schema、host action/output validation、授权 artifact hydration、官方 assistant-ui MathBlock renderer 已提交；任意 schema/HTML/科学状态注入有拒绝测试 | 只做反回归；若后续 Schema/authority 改动使证据失效则重新打开 |
| O-16 capability/action slot | `open` | QuestionCard 读取当前 interaction capability；message capabilities 仍为空且静态 slot 未收敛 | G2 建立同一领域状态来源与 409/刷新行为 |
| v1 O-02 / R-20 Task/output Schema | `changed` | math-derivation 已收窄为单一 artifact Schema/host validation；更宽 Task Registry 与重复 validator 仍存在 | G3 在 handoff commit 上复验，统一 canonical Schema，删除悬空/双轨部分 |
| R-34 前端 server state | `changed` | Router/TanStack Query 已接入；仍有手写 DTO、裸 fetch、每卡 query 与全局 invalidation | G5 收敛 generated client、Query/principal/error/loading |
| R-38 P7 测试 | `open` | 仅有 teaching-artifact 窄单测；Web 无足够 route/External Store/browser 测试 | G6 补 route、External Store replay、happy/failure Playwright 与 a11y |
| 07 全部组件与风格 | `open` | 多数记录组件已实现；Probe/update producer、正式降级态与响应式/a11y 证据缺失 | G2 补真实性与可达性，G6 补完整验收 |

### 5.2 已证实但不关闭整项的 P7 子不变量

- 模型不能伪造权威 `DomainUIPart`：前台输出 parser 拒绝 `domain_ui`，executor 与 commit 前均执行 parser，并有拒绝测试。
- Question、AnswerReceipt、Judgment、QuestionClosure 由领域/API 投影生成，而不是模型工具直接生成。
- Next 对话已接 assistant-ui External Store；旧 Pi 前端题卡/Runtime 入口不在正式 Web 路径中。
- 个人记录、教师同源读模型、记忆反馈与 mute/unmute 已有实现代码，但因为缺 route/browser/权限回归证据，相关整项仍保持 `open`。

复验结果只允许：

- `closed-by-p7`：证据完整，本 Goal 不再实现；
- `open`：P7 未覆盖，本 Goal 接手；
- `changed`：原问题形态改变，先重写问题与验收；
- `invalid`：审计论断错误，记录反证后撤销；
- `deferred-by-user`：只有用户明确决定才可使用，不等于完成。

## 6. 不可破坏的设计准则

### 6.1 真实性与禁止伪完成

1. 一个能力只有同时具备**声明、生产可达、执行、持久化、消费、测试**才可称为实现；文件、枚举、按钮、Schema 或 Task 注册本身不构成完成。
2. UI 动作必须由服务端 capability 驱动，并有真实 transport、command、receipt/read model；没有能力时隐藏或带原因禁用，不保留无效按钮。
3. 名字必须与保证一致：`ready`、`sandboxed`、`validated`、`deduplicated`、`idempotent` 等词必须由运行时性质证明。
4. 不用随机、固定样例、默认值吞错、JSON 文本追加或本地 state 模拟智能选择、领域事务、证据 admission 或服务端提交。
5. 状态枚举的每个终态必须有生产写入路径；无消费者字段要么接通，要么删除，但审计/溯源字段按设计保留。
6. 测试脚本收集 0 tests 必须失败；旧链路 smoke、mock-only、一次演示和静态截图不能证明 Next 完成。

### 6.2 库优先，不受现有依赖限制

1. 并发、协议、安全、可访问性、解析、路由、server-state、SSE、上传、图片解码、迁移、缓存、代理、健康检查和 telemetry 优先采用成熟库。
2. “只有几行”不是手写理由；少量 loading、retry、polling、MIME 或 history 代码同样可能遗漏大量边界语义。
3. 可引入仓库尚未使用的库，但实施前必须按根 `AGENTS.md` 用 Context7 核对当前官方文档、版本兼容、维护状态与许可证，并经 `nix develop` 验证。
4. 第三方只通过依赖和薄 adapter 使用，不把库源码大段复制进产品；持续依赖进入 workspace/flake lock，不全局安装。
5. 不为了“统一”引入 Axios、第二个 transport Schema、另一套 job queue、万能 ORM、通用规则引擎或客户端状态机权威。

### 6.3 按运行机制抽象，不按职责名称判断重复

1. Dream、选题、评分和 Content 研究职责不同，但都具有 durable Agent task 机制，应共享 Temporal Task Runtime。
2. 前台 Pi 与后台 Pi 的 streaming driver 不同，但 model/session/skill/capability/workspace/structured output/attempt audit 应共享 execution kernel。
3. Question、Content、Object 的领域状态不同，但 command envelope、idempotency、actor、expected version、receipt 和 correlation 可共享协议。
4. 抽象只拥有共同机制，领域 adapter 保留各自事务和不变量；禁止巨型 `GenericService`、万能 operation 表或跨领域状态机。
5. 文字 clone 不是唯一证据。维护“运行机制清单”，检查不同目录中同样的 claim/retry/recover/hash/path/validate/cache 流程。

### 6.4 单一权威与替换纪律

1. JSON Schema 是跨服务结构契约唯一来源；TypeScript、Python validator、OpenAPI 和 Web client 从它生成或读取。
2. 数据库事务/事实是领域写权威；浏览器不重算 M/R/C_e，不以本地提交态冒充事实。
3. Temporal 是非前台耐久执行权威；不保留 Content poller/backoff、marker file、process Map 或 transcript token 作为并行恢复系统。
4. Task Registry 是 Agent task policy 权威；executor 不另写一套 capability/schema/skill 路由。
5. 新路径验证通过后，同阶段删除旧路径、依赖、配置和文档；禁止长期双写、兼容开关和“暂时备用实现”。

### 6.5 科学领域语义继续显式

以下内容不能因治理而被通用库或 LLM prompt 替代：

- 事实先于状态及 M/R/C_e/Annotation 可重放；
- Judgment/Evidence admission、提示后成功和 rubric 资格规则；
- Selection catalog 限权、intent revision、active slot 和硬约束重验；
- QuestionSession/Cut/Closure 幂等边界；
- ErrorEvidence reducer 与 Dream gate/preimage/rollback；
- tenant/actor/teacher ACL、RLS 和领域原子事务。

库负责外围正确性，领域代码负责 MathPilot 独有语义，两者都必须有测试。

## 7. 代码、文档与 UI 风格要求

### 7.1 代码与架构风格

- composition root 创建并注入 pool、config、client 和 runtime；业务 class 不各自读取 `process.env` 或创建连接池；
- 小型、按职责命名的 port + adapter，避免 `utils.ts`/`service.ts` 不断膨胀；第二个真实消费者出现时抽共同机制，不做猜测性框架；
- Fastify route 保持 transport-thin：schema、principal、command/query 调用与 Problem Details 映射，不堆领域 SQL；
- 复杂领域 SQL 可以保持 SQL-first，不为 ORM 一致性拆散原子事务；
- 错误信息面向用户稳定、面向日志可追踪，不把 SQL/stack/secret 放入默认 500；
- ID、resource ref、Schema URI、环境变量和浏览器 key 保持 `mathpilot` 命名空间；
- 只使用 `nix develop` 运行开发、构建和测试；保护用户工作树，禁止 destructive git 覆盖无关改动。

### 7.2 文档与完成报告风格

- 先写结果和当前事实，再写实现步骤；明确区分 current、target、assumption 和 evidence；
- 所有审计引用绑定 commit，不引用漂移的“当前行号”；
- 不用完成百分比、文件数量或测试名称制造进度感；用 requirement → evidence 表；
- 设计决策写入 owning 主题文档，本 Goal 只保存目标、阶段、状态和验收引用，不扩成第二套系统设计；
- 用户可见术语使用“数学智元 / MathPilot”，代码协议采用 MathPilot namespace；
- 关闭问题时保留原问题、反证/修复证据和关闭 commit，不直接删掉历史记录。

### 7.3 视觉与交互风格重申

前端必须继续遵守 [07 文档的统一视觉与交互语言](./科学内核与Dream封版v3/07-前端设施后端读模型与统一交互语言.md)：

- 沿用 web-next **中性、低 chrome** 对话界面，不做紫色渐变“AI 仪表盘”、营销字体或高饱和科学状态彩虹；
- 只使用现有 `background/foreground/card/muted/accent/border/ring/destructive` 等 token，sidebar 蓝色只作品牌/当前位置提示；
- 复用 `surfaces.tsx` 与现有 Base UI/Radix primitives；层级保持“页面背景 → 一个主 surface → field/list”，禁止 `Card > Card > Card`；
- 普通记录用 border/divider，阴影只表示浮层或需与消息流区分的权威卡；
- Lucide 是唯一功能图标语言，不用 emoji 冒充图标；正文 `font-sans`，ID/版本 `font-mono`，公式走本地 KaTeX；
- 学生文案不暴露 M/R/C_e、Temporal/Pi ID 等内部术语，不做“你总是”“能力低”“系统完全了解你”等人格化确定判断；
- hover/press 约 150ms，disclosure/Sheet 与新卡淡入不超过约 200ms；不动画掌握概率和滚动数字；reduced-motion 关闭位移、脉冲和 shimmer；
- radio、checkbox、dialog、sheet、collapsible 使用真实语义 primitive，不用 `aria-pressed` 按钮模拟；点击目标至少 `44×44px`，图标按钮有 accessible name/Tooltip；
- 新卡不抢 Composer 焦点，提交后焦点进入 receipt/status；streaming 不逐 token 播报；测试优先按 role/label/可见文本查询；
- loading、disabled、empty、error、stale、permission-denied 和 offline 都是正式状态；不在每张卡手写一套 spinner/error/retry；
- 每个组件必须有读模型、权限、命令与空/错状态，每个用户可见投影必须有入口；卡片不能猜后端状态。

## 8. 目标抽象与成品复用边界

名称可在实施时调整，但职责不可重新混合：

| 边界 | 应拥有 | 不应拥有 |
|---|---|---|
| contracts runtime registry | canonical JSON Schema、编译 validator、OpenAPI component、Task codec、生成类型 | 领域事务、UI 本地状态 |
| agent-execution kernel | model/session、skill、capability、workspace、structured output、attempt audit | Question/Dream/Content 状态转换 |
| Temporal Task Runtime | durable attempt、cancel、retry、timeout、child、signal/update、outcome | 前台 token streaming、通用领域表 |
| service-context | principal、tenant、role/capability、internal assertion、RLS/outbound context | Better Auth 产品 UI |
| service-kit | config、bootstrap、logging、Problem Details、shutdown、readiness、route schema | 服务业务 route 与领域 SQL |
| postgres context | 共享 pool、连接预算、transaction/RLS helper | 强迫复杂 SQL 进入 ORM |
| object-client/policy | purpose/ref、stream、hash、MIME、size、pending/ready/expiry、授权 | Pi archive 领域布局 |
| path-policy | root containment、regular file、symlink policy、logical ref、safe filename | sandbox 产品权限策略 |
| artifact-policy | manifest、format、MIME、active/passive、renderer/open/download policy | 对可执行 HTML 的同源信任 |
| generated clients | transport types、request/error/trace/idempotency middleware | React 页面状态和领域判断 |

优先复用或评估的成熟设施：

- 已有 Temporal、Pi SDK、assistant-ui、Better Auth、MinIO SDK、sandbox runtime、Base UI/Radix、React Router、TanStack Query、KaTeX、ReactMarkdown、Lucide；
- Fastify Type Provider + TypeBox/Ajv、Swagger/OpenAPI、`@fastify/http-proxy`、`@fastify/env`、`@fastify/under-pressure`、`@fastify/sse`；
- OpenAPI 生成 client、Schema→TypeScript 生成器；具体工具二选一并锁版本；
- Uppy Core + S3 adapter、`file-type`、`sharp`、`mime-types`；
- `csv-parse`、SQL-first migration runner、RFC 8785 canonical JSON；
- OpenTelemetry、dependency-cruiser、jscpd、ESLint/Semgrep、fast-check、Playwright。

采用库前必须核对当前文档和 Fastify/React/Node 版本兼容；“候选在表中”不等于可以不做 spike。`@fastify/sse` 已核实可处理帧、心跳、连接状态、backpressure、async iterable 与 replay，但它不替代数据库事件通知和领域 sequence catch-up。

明确不采用：第二套 durable queue、Axios 仅为替换 fetch、Zod 作为第二 transport truth、全库 ORM 重写、XState 作为服务端权威、CORS 插件仅为凑安全清单、复制第三方源码。

## 9. 实施阶段

### G0：P7 handoff、防误修复验和基线冻结

当前状态：`in_progress`。P7 代码基线、验证边界、工作树归属和初始 ledger 已记录；整合审计 v3 的逐项基线重放与当前计数尚未完成，不得把 G0 标为完成。

交付：

- 记录 `P7_HANDOFF_COMMIT`、P7 最终测试和工作树归属；
- 只从整合审计 v3 建立 `closed-by-p7/open/changed/invalid/deferred-by-user` ledger；历史审计不得直接入表；
- 每项补齐 clean baseline、权威要求、production reachability、反证、影响强度、库/抽象评估和 owner；
- 重算 route schema、Task reachability、pool、raw fetch/process.env/setInterval/Map、测试数量和依赖图；
- 将 O-12/O-15/O-18/O-21/R-27 与忠实度审计中过宽/阶段外结论固化为反回归说明。

门槛：所有后续工作都指向 handoff commit 的开放项；没有依赖脏工作树行号或过时计数。

### G1：安全边界与错误承诺

交付：

- P0 修复 Pi archive symlink/containment；加入恶意 symlink、绝对/穿越 object key 测试；
- 可执行 Artifact 使用独立 untrusted origin + sandbox iframe/窄 `postMessage`；完成前保持不可执行或移除入口；
- production config fail-fast、独立 evidence secret、内部身份过渡加固；
- Avatar/附件/Artifact 内容识别、图片解码重编码、stream/size/hash/expiry；
- `validated`、`sandboxed`、interaction token、dedup 等承诺与真实运行时一致；
- 全局 Problem Details、默认 500 脱敏、安全头和按 threat model 的 rate limit。

门槛：安全测试证明 sandbox 外归档不能读取授权 root 外字节；非 dev 默认 secret 拒绝启动；主动内容不能继承应用 origin；文件声明与实际内容不一致被拒绝。

### G2：P7 剩余真实性、状态终态与可达性

交付：

- 关闭第 5 节所有仍 open 的 P7 项；
- 恢复 C-01～C-03 的真实生产事实链：诊断硬门、错因 claim/outcome/evidence、RetentionUnit/R/复习；不得以 fixture 或 UI 占位验收；
- 诊断状态、package status 等枚举完成生产者/消费者审计；先做语义裁决再改枚举；
- Task Registry 每个保留 Task 都具备 trigger、Schema、skill、driver、capability、commit 和测试；不可达任务删除；
- 教学卡与 Science QuestionCard/evidence admission 边界收敛；
- capability/action/command/read model 单一来源，取消真实传播到 Workflow/Activity 且提交事务保留终态守卫；
- provenance 字段保留并进入合适审计面，真正无职责对象才删除。

门槛：reachability audit 100%；没有 permanent `unclassified`、静态无效 action、无消费者安全字段或 declaration-only Task。

### G3：契约成为运行时权威

交付：

- 补齐 Task Registry 悬空 Schema 和 KTQ/ER/teaching artifact canonical Schema；
- Fastify route 结构校验覆盖 100%，使用 type provider/Ajv；
- Agent tool input、structured output、artifact 和 Python validator 读取同一 Schema/golden fixtures；
- 从 Schema/OpenAPI 生成 TypeScript types 和 Web/internal clients；删除手写 DTO、blind cast 和重复 primitive validator；
- 语义、授权、版本、跨记录和领域事务校验继续显式保留。

门槛：新增无 route schema、悬空 Schema URI、生成结果漂移、Python/TS fixture 不一致都会令 CI 失败；没有第二套 Zod transport Schema。

### G4：可靠 Agent Runtime 与执行内核收敛

交付：

- 先按用户最新 steering 修订 KTQ/ER owning 设计，明确旧 5 秒 poller 不再是目标架构；
- 再迁一个 Content task 到现有 Temporal Task Runtime，证明 TaskSpec + domain commit adapter；
- 迁移其余 KTQ/ER/revision/review durable jobs，删除 Content `setInterval` dispatcher、手写 backoff/无限 pending 和 Pi marker/Map/transcript recovery；
- 抽取 foreground/background 共享 agent-execution kernel，保留 InteractiveEpochDriver 与 TemporalActivityDriver；
- 统一取消、终态、attempt audit、workspace/capability/output policy；
- 用 Temporal test environment 验证 Activity retry、Workflow failure、cancel、duplicate start、crash/recovery；明确普通 workflow bug 的 failure policy，不添加未经设计的 Workflow retry。

门槛：非前台 Agent 工作只有一个 durable runtime；多副本、kill、回包丢失和重投不双写；前台 streaming 未被错误塞入后台工作流。

### G5：横向平台与前端设施收敛

交付：

- 一个 learning process 共享 pool/连接预算和 RLS context；服务统一 config/bootstrap/readiness/error/logging；
- Gateway proxy streaming、generated internal client、service-context/internal assertion；
- `@fastify/sse` + durable sequence catch-up/通知 bridge，删除手写帧和每客户端恒定全表轮询；
- Router/Query/principal 单一来源，删除裸 fetch、`window.location.assign`、每页 polling/loading/error；
- Uppy/object client、stream materialization、pending GC/abort；
- path、Artifact、ID、canonical JSON、cursor codec、CSV/migration runner 按第 8 节边界收敛；
- Artifact published index 原子、并发安全，GET 不再重发布。

门槛：无未批准的业务 `process.env`、裸 route fetch、独立 pool、手写 SSE、服务 job `setInterval`、durable process Map；对象失败路径和前端 refresh/cross-device 状态测试通过。

### G6：CI、观测、E2E 与删除证明

交付：

- CI 承载 typecheck、非零 tests、Schema/reachability、生成物、边界与禁止模式；
- Fastify inject/API、Temporal、PostgreSQL integration、Playwright、a11y/responsive/reduced-motion 测试；
- OpenTelemetry trace 贯穿 HTTP、operation、workflow、activity、agent attempt、pg 和 object；Pino 保留；
- 真实 Next E2E 走登录 → Thread → 附件 → 选题 → QuestionOpened → Attempt → grade/diagnose/close → 下一题 → Dream/记录/证据；
- 删除被替代实现、依赖、配置、dead exports 和旧文档引用；输出 dependency/write-path 证明。

门槛：第 12 节完成矩阵全部有当前可复现证据；旧 smoke 不再冒充 Next E2E；没有 0-test 绿色 package。

## 10. 自动化守门

### 10.1 真实性与可达性

- UI action → capability → transport → command → receipt/read model 全链静态/集成检查；
- TaskSpec → Schema → skill → driver → trigger → commit → test 全链检查；
- 状态枚举终态 production writer 检查；
- tool/Schema 字段 host consumer 清单；
- 名含 `validated/sandboxed/ready/dedup/idempotent` 的接口有对应性质测试。

### 10.2 禁止模式

用 ESLint/Semgrep 或小型 AST check 禁止新增：

- 无 `schema` 的 Fastify route；
- route 中 blind `request.body as` 绕过 validator；
- Web 页面裸 fetch/手写 DTO/手写 server-state polling；
- composition root 外 `new Pool` 和业务模块裸读 `process.env`；
- 服务级 job `setInterval`，除批准的薄 outbox/notification bridge；
- process Map、marker file、transcript token 作为 durable authority；
- MIME/magic、SSE frame、UUID、CSV、router/cache/focus trap 的新手写实现。

### 10.3 重复机制

- dependency-cruiser 检查边界；
- jscpd 捕捉文字 clone；
- 运行机制 inventory 捕捉跨职责相同流程；
- fast-check 覆盖 path/symlink、ID/cursor/hash、idempotency、状态机和 object lifecycle。

clone 分数不能自动驱动抽象。任何共享包必须写清 policy owner、两个真实消费者和不能纳入的领域职责。

### 10.4 UI 质量

- 390×844、834×1112、1440×900、200% zoom 无横向溢出；
- light/dark/reduced-motion；
- keyboard 完成答题、提交、证据、Sheet 与导航；
- screen reader 获得标题、错误和完成通知，streaming 不逐 token 噪声；
- radio/checkbox 等按 role/label 测试；
- 视觉 token、surface 层级、Lucide 和文案术语 lint/review checklist。

## 11. 验证纪律

所有开发、构建和测试通过根目录 Nix 环境：

```sh
nix develop path:/home/tangent/MathPilot -c pnpm typecheck
nix develop path:/home/tangent/MathPilot -c pnpm test
```

具体 package 命令按其 manifest 执行，但以下规则不变：

- 0 tests 是失败，不是通过；
- skipped integration test 不能计入对应数据库/服务证据；
- 新库必须有真实 adapter test，不以安装成功为验收；
- 安全、并发和恢复主张必须有恶意/故障用例；
- 性能问题用 query count、内存、连接和延迟基准证明，不只看代码行数；
- 工作树持续变化时停止形成结论，先冻结 commit；
- 验证命令、退出码、测试数量、跳过原因和环境依赖进入 evidence ledger。

## 12. 终态完成矩阵

| 范围 | 最低完成证据 |
|---|---|
| P7 交接 | 整合审计 v3 全项 ledger；历史误判被隔离；P7 修复项有 handoff commit 与测试，未重复实现 |
| 安全 | symlink/containment、untrusted origin、secret fail-fast、文件解码、500 脱敏攻击测试 |
| 功能真实性 | action/Task/status/tool 字段 reachability 100%，无 placeholder/no-op/静态矛盾能力 |
| Contracts | route/Agent/Python/Web 共用 canonical Schema，生成物一致，悬空 URI 为零 |
| Runtime | Content/Science/Dream 非前台任务统一 Temporal；cancel/retry/crash/duplicate 多副本测试 |
| Agent host | execution kernel 两个 driver 复用证明，capability/workspace/output policy 单一来源 |
| DB/service | pool 与连接预算、RLS context、config/readiness/error/proxy/internal identity 收敛 |
| Object/Artifact | stream、hash、MIME、size、abort/GC、原子 index、跨租户/路径拒绝测试 |
| Frontend | Router/Query/principal/client 单一来源；服务端状态刷新/跨端一致；07 风格与 a11y 验收 |
| Content | KTQ/ER canonical validation；后台命令有终态且迁统一 Runtime；N+1 有基准改善 |
| CI/Observability | 非零测试、禁止模式、边界/生成/reachability、trace/log correlation 持续执行 |
| Full system | 正式 Next 真实服务 E2E 覆盖多题、错因、Dream、记录、证据、故障和权限 |
| Removal | 搜索、依赖图、compose、route/write-path 证明被替代实现和旧权威已删除 |

只有所有必需行均有当前、可重放且未被后续变更失效的证据，Goal 才能标记 complete。

## 13. 不构成完成

- 只把历史审计合并成 issue 列表，却未经过防误修门和生产可达性复验；
- P7 修了一部分便跳过 handoff 复验；
- 添加库但旧手写路径仍在运行；
- 建了共享 package，但各服务仍维护自己的 policy；
- 只消除文字重复，没有收敛同机制不同职责的 Runtime；
- 只通过 typecheck、mock 单测、旧 smoke、0-test package 或一次演示；
- 因治理范围大而删除领域审计字段、降低安全门禁或恢复旧实现；
- 用代码量、阶段名称、测试文件数或时间投入代替 requirement → evidence。

## 14. 失败、Blocked 与完成报告

- 普通编译失败、测试不绿、重构困难、库 spike 失败或 P7 遗留较多都不构成 blocked；继续定位 owning surface。
- 只有同一外部阻塞连续三个 Goal turn 存在，且没有其他安全范围内工作可推进时，才可标记 blocked，并记录解除动作。
- 第三方不适合时先换成熟候选或缩薄 adapter，不回退手写整套基础设施。
- 抽象不合适时回到共同机制和领域 adapter 边界，不以“已经建包”强迫复用。

完成报告至少包含：

1. P7 handoff commit 与整合审计 v3 裁决 ledger；
2. 用户可见修复和被撤销的错误审计结论；
3. 采用的库、版本、官方依据和薄 adapter 边界；
4. 跨职责 Runtime/服务抽象及未被抽象的领域职责；
5. Schema、迁移、主要代码和文档链接；
6. 实际验证命令、结果、测试数量和故障/安全证据；
7. 旧路径、重复实现、无效依赖和配置的删除证明；
8. 明确声明必需项没有剩余工作。

在这些证据形成前保持 Goal active，不以阶段性总结替代真实终态。
