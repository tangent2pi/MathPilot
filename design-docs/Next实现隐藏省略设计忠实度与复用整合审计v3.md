# MathPilot Next 实现整合审计 v3

> 范围：隐藏省略、设计忠实度、伪能力、不必要手写基础设施与跨职责重复运行机制。
> 状态：`canonical-audit-input`；这是后续治理 Goal 唯一可直接引用的审计文档。
> 审计时点：2026-08-31；可复现代码锚点 `fcd108b449d93db4106ea55eb01a0d4870f7ca8e`。
> P7 状态：持续运行。当前脏工作树只用于标记 `p7-pending`，不用于关闭问题，也不得由本审计抢写。
> 历史材料：[专项审计 v1](./Next实现隐藏省略与复用专项审计v1.md)、[v2 补充](./Next实现隐藏省略与复用专项审计v2补充.md)、[忠实度审计 v1](./设计忠实度审计v1-实现与设计偏离.md)。三者均已 superseded，只保留证据价值。

## 1. 结论

三篇旧审计发现了大量真实线索，但都不能原样驱动实现：v1 的基线较旧；v2 与忠实度 v1 依赖不可复现的未提交工作树；后两篇还把推测、旧实现、阶段外要求和设计分歧写成了确定缺陷。v2 的错误内容已经具备误导在途 P7 修改的条件，因此从本版起实行“先裁决、后入 Goal”。

当前最重要的真实缺口分为四组：

1. **生产事实链断裂**：诊断门、DiagnosticClaim/DiagnosisOutcome、RetentionUnit 等存在 Schema、表或测试 fixture，却没有完整生产写入路径；不能再用 fixture 证明端到端完成。
2. **声明与消费断裂**：部分 DomainUIPart、TaskSpec、capability、状态或安全字段只有声明/生产一侧，没有真实消费者、终态或运行时校验。
3. **同机制重复实现**：Content 后台命令、Science/Dream 工作流、三类 Agent host、Schema validator、pool/RLS、SSE、上传、path/hash、错误映射和前端 server-state 在不同职责下重复造轮子。
4. **基础设施手写过度**：若成熟库已经拥有协议、安全、并发、恢复、可访问性和边界语义，即使手写代码只有几行，也必须优先评估库；抽象则按运行机制而不是业务名判断。

本审计不认定“旧实现仍在仓库”为 Next 缺陷。只有旧代码仍被 Next route、compose、依赖或生产写路径消费时，才进入删除范围。

## 2. 审计纪律与防误修门

### 2.1 权威顺序

冲突按以下顺序裁决：

1. 用户最新明确 steering；
2. 后续治理 Goal 的目标、边界与终态条件；
3. 科学内核与 Dream 封版 v3 README 及 01–07；
4. 未被新决策覆盖的专项设计；
5. 本整合审计作为问题与证据入口；
6. 历史审计仅作线索，不是产品设计。

用户已明确要求：只审计 Next 新实现；库可以新增；重复必须覆盖“职责不同但运行机制相同”；Dream、选题、评分、Content 等后台 Agent 应优先向统一耐久 Runtime 收敛。旧 KTQ/ER 文档中的 5 秒 poller 描述不能反向推翻该最新要求；实施前应先修订 owning 设计，再迁移而不是继续打磨 poller。

### 2.2 一个条目进入实现前必须同时回答

| 门禁 | 必需证据 |
|---|---|
| 可复现基线 | 干净 commit，而非 `HEAD + 未提交改动` |
| 当前权威要求 | 精确 owning 文档/用户决定；确认不是后续阶段或已被覆盖 |
| 生产可达性 | trigger → execution → write/receipt → reader/consumer；fixture 不算生产者 |
| 反证检查 | 搜索事务 guard、间接消费者、配置 profile、compose mount、路由和 capability |
| 影响强度 | 区分已证明影响、潜在风险、维护债和纯设计选择 |
| 修复比例 | 先核对成熟库与已有平台能力；不得为伪问题增加 retry、兼容层或第二权威 |
| 工作归属 | 是否与 P7 在途文件重叠；重叠则只记 `p7-pending` |

条目状态只允许：

- `confirmed-open`：当前 clean commit 可复现且满足权威与生产影响；
- `p7-pending`：P7 正在修改 owning surface，handoff 后重验；
- `confirmed-design-decision`：事实存在，但必须先更新 owning 设计；
- `corrected-open`：原描述/影响错误，收窄后仍有真实问题；
- `invalid`：反证成立，不得实施；
- `out-of-scope`：旧实现、阶段外或与 Next 无生产连接；
- `closed-by-p7`：只可在 handoff commit + 自动化证据齐全后使用。

禁止根据未提交工作树把条目标成 closed，也禁止看到字段、按钮、Task、表或测试 fixture 就宣称功能完成。

## 3. 最高优先级确认项

| 统一编号 | 来源 | 状态 | 当前事实与正确处理 |
|---|---|---|---|
| C-01 | 忠实度 D-01；v1 O-03 | `confirmed-open` | `FinalizeQuestionWorkflow` 没有诊断步骤，正常关闭写 `unclassified`。按 doc03 重建 concluded/inconclusive/skipped 的硬事实门；不得只换显示文案或常量。 |
| C-02 | 忠实度 D-02 | `confirmed-open` | 生产代码没有完整 DiagnosticClaim/DiagnosisOutcome 写入链，fixture 不能证明错因闭环。补候选、探针、诊断提交、ErrorEvidence 与消费闭环，或在 owning 设计中明确删减承诺。 |
| C-03 | 忠实度 D-03 | `confirmed-open` | RetentionUnit revision/measurement rule 没有生产种子，R 投影与复习队列因而空转。官方/教师内容必须有可追溯映射生产者和迁移验收。 |
| C-04 | v2 R-21 | `confirmed-open` | sandbox 外归档可能跟随 workspace symlink。先拒绝 symlink、校验 root/object containment、限制资源，再抽 path/object policy；用恶意用例验收。 |
| C-05 | 忠实度 D-04 | `p7-pending` | `fcd108b` 上学生 canonical message 丢弃 DomainUIPart，使 AnswerReceipt 不显示。P7 正改 presentation，handoff 后以真实提交/刷新回放复验。 |
| C-06 | 忠实度 D-05 | `p7-pending` | `fcd108b` 上上下文透明清单是硬编码标签，不等于本轮 WorkspaceProjection/input artifact 实际注入 manifest。P7 正改 read service，handoff 后核对 item/ref/freshness。 |
| C-07 | v1/v2 O-02、R-03/R-04/R-19/R-20/R-31；忠实度 D-23/D-36/D-54 | `confirmed-open` | Schema URI、Task Registry、host validator、TS/Python/Web 类型仍多源或不可达。canonical JSON Schema 必须成为运行时事实源，生成 types/client 并用 golden fixtures 守门。 |
| C-08 | v1 R-01/R-02；v2 R-37；忠实度 Runtime/Dream 相关项 | `confirmed-design-decision` | Content poller/backoff 与 Temporal Task Runtime 是同一耐久后台机制的两套实现。按用户最新决策先修订 KTQ/ER owning 设计，再把 durable Agent work 迁 Temporal；前台 streaming driver 保留独立。 |

## 4. 经整合仍开放的问题族

以下是 handoff 后必须复验的“问题族”，不是要求一次造出巨型通用框架。

### 4.1 功能真实性与设计忠实度

| 问题族 | 合并来源 | 裁决与验收方向 |
|---|---|---|
| 切题后下一题 | 忠实度 D-06 | 核对 `next_intent_ref` 是否有生产 reader，Closure 后能否启动真实 Selector；P7 若已接通则以跨刷新 E2E 关闭。 |
| 干预与学习机会 | D-07/D-11 | 提示必须写 InterventionEvent/hint level，提示后成功不能冒充独立证据；LO 必须有生产可达消费者。 |
| Intent 来源与外部题 | D-08/D-09 | 先确认当前阶段是否承诺 program/teacher/external/provisional；只实现被当前 Goal 纳入的来源，不因枚举存在自动补全。 |
| transfer/evidence policy | D-10/D-12 | 消除恒 false 与装饰性 policy；资格门必须消费真实先前解法/纠正事实，科学状态仍保持显式领域代码。 |
| 错因规划与状态机 | D-13–D-17 | 生产接通 consumer action、QuestionErrorRole、弱证据可见性、反证转移和教师 supersession；先以 doc02 精确重放 reducer。 |
| Dream 审核、纠正、重试 | D-18–D-22 | 审核队列/批准/拒绝/rollback/mute 必须端到端。不要简单放开 StudentTrait validator；先保留安全 gate，再补教师审批。教师 owner 与 retry window 需明确租户语义。 |
| Selector 个性化权限 | D-21 | mute 与相关性必须在实际 Selector bundle 生效，而不只在另一个 WorkspaceProjection helper 中存在。 |
| 盲重试 | D-24 | invalid candidate 原因进入下一 attempt，或用确定性重选避免重复模型调用；重试由 Runtime policy 管理。 |
| 学习记录与权威卡 | D-25–D-28、D-30–D-32、D-57 | Judgment/Memory/ScientificState/History/Probe/Update card 必须消费服务端事实，支持 empty/error/stale/supersession/pagination/feedback；P7 handoff 后逐卡复验。 |
| 公式与有界教学 UI | D-40/D-41 | Markdown 数学使用项目既定 KaTeX 成品；Generative UI 只在设计白名单与 canonical validation 下接通，不以 props 数量假装有界。 |
| 附件归属与内容复核 | D-39/D-50–D-53 | 核对入口、thread binding、子项批注、source lineage 与 dedup host semantics；字段存在但 host 丢弃不得称已实现。 |
| 可访问性与导出 | D-56/D-58 | 44×44、busy/live/focus/reduced-motion 与 DomainUIPart serializer 进入组件验收；优先用现有 accessible primitives。 |

### 4.2 不必要手写与跨职责重复

| 共同运行机制 | 当前重复/手写表现 | 目标边界 |
|---|---|---|
| durable Agent task | Content SQL poller/backoff、Temporal Science/Dream、marker/Map/transcript 恢复 | 一个 Temporal Task Runtime；领域 workflow/commit adapter 保持独立 |
| Agent execution | foreground/background/content 各自 model/session/skill/workspace/output/audit | 一个 execution kernel + InteractiveEpochDriver/TemporalActivityDriver |
| Schema/validation | route primitive、Task output、KTQ/ER TS/Python、Web DTO 多份 | canonical JSON Schema + Ajv/runtime registry + 生成 types/client + golden fixtures |
| PostgreSQL/RLS | 多 pool、多份 `withTenant`、各自连接预算 | composition-root pool/context；复杂领域 SQL 不强塞 ORM |
| HTTP service | env、bootstrap、readiness、Problem Details、principal、proxy 重复 | 薄 service-kit/service-context；领域错误类型保留 |
| SSE/事件通知 | 多套手写帧、心跳、轮询与重连 | 成熟 SSE 库负责协议；durable sequence catch-up/DB notification 单独适配 |
| object/upload | init→PUT→complete、全量 buffer、MIME 信任、abort/GC 各写 | Uppy/S3 adapter + stream/hash/file-type/sharp + 原子 lifecycle policy |
| path/archive/artifact | shell quoting、magic、symlink、index 发布各写 | path/object/artifact policy；已发布索引原子且 GET 无副作用 |
| Web server-state | 页面裸 fetch、polling、loading/error/retry、principal 多源 | React Router + TanStack Query + generated client + 单一 auth principal |
| ID/cursor/hash/CSV/migration | 少量 helper 在多目录复制且边界不同 | 成熟库或窄 codec；排序与领域事务不强行通用化 |
| UI 状态与交互 | 每卡 spinner/error/focus/弹层/选择控件 | 复用 assistant-ui、Base UI/Radix 与统一 surface/status primitives |

采用库不是“把依赖加进 package.json”。必须删除被替代手写主路径，以故障、安全、刷新、取消、并发或 a11y 测试证明库真正承担了边界语义。抽象也不是看到相似文件就合并：需要两个真实消费者、共同机制 owner 和明确不纳入的领域职责。

## 5. 对历史审计的关键纠错

| 历史条目 | 最终裁决 | 反误修要求 |
|---|---|---|
| v2 O-12 “取消后 foreground 结果仍落盘” | `corrected-open` | API 未传播 Temporal cancel 是真实缺口，但 DB commit 函数拒绝 terminal request，取消后 foreground 结果不能落盘。治理算力浪费、响应延迟和跨 operation 一致取消，不重写已存在的事实 guard。 |
| v2 O-15 “Workflow 默认无限重启” | `invalid` | Temporal TypeScript SDK 未显式设置 workflow retry 时不创建默认 Workflow retry policy；未捕获 TemporalFailure 使 execution 失败。不得为伪问题添加 Workflow retry。普通编程错误导致 Workflow Task 反复失败应另做 failure/alert 测试。 |
| v2 O-18 “无 reader provenance 应删除” | `invalid/拆分` | `model_id`、`prompt_version`、`content_source` 是 KTQ/ER 审计溯源；无普通 UI reader 不等于无职责。只删除无权威用途的对象。 |
| v2 O-21 “seed.sql 非幂等阻塞 compose” | `invalid` | 默认 compose 挂载的是带 guard/ON CONFLICT 的 `bootstrap.sql`，fixture `seed.sql` 也不是所称启动路径。只保留真实 down/up 回归。 |
| v2 R-27 “缺 CORS 插件” | `invalid/拆分` | rate limit 与安全头按 threat model 补；同源应用无需为清单完整而开启 CORS。 |
| v2 R-18 “已证明存储型 XSS” | `corrected-open` | MIME/解码验证缺口成立，但 exploit 强度需浏览器测试；整改仍采用内容识别、像素限制、重编码和 `nosniff`。 |
| 忠实度 D-29 “Copy/Export 也必须 capability gating” | `corrected-open` | 本地 Copy/Export 不天然需要服务端领域 capability。历史编辑在服务端版本/证据锁语义存在前不应恢复；真正需要 gating 的是可改变领域事实或受授权限制的动作。 |
| 忠实度 D-33 “前端遇 304 必然失败” | `corrected-open` | 只有客户端发送条件请求时 304 才可达。保留 projection degradation/stale envelope 缺口，ETag 行为按真实 client 协议测试。 |
| 忠实度 D-38 “旧 apps/web 存在即缺陷” | `out-of-scope` | 旧实现将逐步删除，不审其内部；仅删除 Next/compose/route 仍指向旧栈的生产连接。 |
| 忠实度 D-49 dormant Pi Bash/Write/Edit | `corrected-open` | 未路由能力不是当前可利用漏洞；若 Next 正式不再需要则作为 dead capability 清理，并用 Task capability reachability 证明生产不可授予。 |
| 忠实度 D-55 旧 student profile 无 Next consumer | `out-of-scope/设计核对` | 不恢复旧事实源。只有 v3 当前产品仍承诺等价学习设置时，才在新事实模型上实现。 |
| 忠实度 D-59 发布索引 | `out-of-scope-now` | 原设计已列为后续阶段，除非新 Goal 明确纳入，不得把阶段外事项冒充当前 P7 缺陷。 |
| 忠实度 D-61 未跟踪 P7 文件 | `invalid-transient` | 这是脏工作树瞬时状态，不能成为持久缺陷；以 handoff commit 重新核对文件保护和文档计数。 |
| 忠实度关于 Content poller 符合旧设计即可保留 | `invalid-authority` | 用户最新 steering 与 v3 统一 Runtime 原则优先；先更新 KTQ/ER 设计冲突，再实施迁移。 |

Temporal 裁决已按当前官方 TypeScript SDK 文档与仓库锁定的 1.23.0 行为复核：Workflow start 仅在显式提供 retry 时编译 retry policy；Workflow failure 与 Activity retry 是不同语义。该结论只用于撤销 O-15，不代表无需测试 Workflow Task bug、Activity retry 或终态告警。

## 6. 必须在 handoff 后重新裁决的项目

以下条目有价值，但当前证据不足以直接实施：

- `content_package.withdrawn` 的生产者与语义；
- content cutover 对账、官方 owner 和迁移报告（当前 P7 正修改相关 migration/CLI）；
- 字体自托管与具体 font token 的实际资源链；
- `/api/pi/*` 是否仍是当前 canonical 浏览器边界，还是已被 app-owned flow 覆盖；
- `Skill` 整文件载入与 progressive disclosure 的精确 TaskSpec 规则；
- 多教师/无教师租户下 Dream owner 与审批策略；
- program/teacher intent、外部题、streaming lifecycle、发布描述符是否属于紧随 P7 的范围；
- `surfaces.tsx` 和旧 generative UI 导出的逐导出可达性。`surfaces.tsx` 是 doc07 指定的视觉基础，不能因零引用整包删除。

这些事项先写设计决策或以 clean handoff 证据升级为 `confirmed-open`，不得由“看起来应该有”直接生成代码任务。

## 7. P7 handoff 复验表

Goal 启动时为每项填写 handoff commit、证据命令、生产链和状态：

| 复验面 | 至少证明 |
|---|---|
| C-01～C-03 | 真实服务生产事实，不靠 fixture；close/diagnose/retention/review 可重放 |
| C-05/C-06 | AnswerReceipt 可见且刷新不丢；context manifest 等于实际注入 items |
| Next selection/capability | closure 后下一题、stale command、取消与失败均有终态 |
| P7 cards/records | 每卡 read model、命令、empty/error/stale/supersession、a11y 与响应式 |
| contracts/tasks | 每个保留 Task 有 trigger/schema/skill/driver/commit/test；悬空项删除或接通 |
| P7 测试 | route、External Store replay、browser happy/failure path 非零且命令收集 0 test 时失败 |
| P7 工作树 | clean commit；未提交 owner 清楚；不得把在途 patch 作为关闭证据 |

## 8. 进入治理 Goal 的执行顺序

1. 冻结 P7 handoff commit，按第 2 节门禁重放本审计；
2. 先处理 C-04 等安全边界与错误承诺；
3. 恢复 C-01～C-03 的生产事实链，并关闭 P7 遗留真实性断链；
4. 让 canonical Schema/Task Registry 成为运行时权威；
5. 先改 owning 设计，再将 durable Agent work 与 execution kernel 收敛；
6. 收敛 pool/service/SSE/object/path/frontend server-state 等横向机制；
7. 用真实 Next E2E、故障恢复、权限、a11y、依赖与删除证明收尾。

任何阶段都不得用“新增了库”“建立了 shared package”“测试文件存在”或“旧审计写着已完成”替代生产行为证据。
