# 04. Dream 三相位语义记忆

## 1. Dream 的正确角色

Dream 不是第二个科学计算器，也不是“夜间让大模型重新评价学生”。它的角色是：在不改变可重放科学事实的前提下，把跨题、跨情境、带正反证据的规律整理成有范围的长期语义附注，供后续教学和选题读取。

典型结果：

> 题型 `T_AREA_COMPOSITE` 的 BKT 基准仍为 0.80；附注指出学生在“图中已给辅助线”时表现稳定，在“需自行补线”时方法启动不稳定，并引用三道支持题和一道反例。

数值 0.80 仍由程序计算。Dream 只能写后面的附注。

## 2. 对 OpenClaw 标准实现的继承与改造

采用 OpenClaw 的核心纪律：

- 固定相位顺序 `Light → REM → Deep`；
- Light 整理短期材料，不写长期记忆；
- REM 发现主题、重复和矛盾，不写长期记忆；
- Deep 是唯一长期语义写入口；
- Deep 前有确定性来源、数量、多样性和预算门禁；
- 写前保存 preimage，写后有 diary、差异和回滚；
- 模型或重写失败保留旧记忆，不产生半更新。

MathPilot 的差异是：原始学习事实已经在 PostgreSQL 证据账本中耐久保存，Dream 不把聊天摘录当成新的事实源。因此：

- Light/REM 的产物可以为审计而持久化，但不是学生状态的规范来源；
- Deep 不重写一个自由格式 `MEMORY.md`，而是写版本化 Annotation；
- M、R、C_e、计划进度和题目内容仍由各自的权威系统维护。

## 3. 写权限矩阵

| 对象 | Light | REM | Deep | 科学 reducer |
|---|---:|---:|---:|---:|
| Attempt/Judgment/Observation/ErrorEvidence | 只读 | 只读 | 只读 | 不改事实，只消费 |
| M/BKT projection | 只读 | 只读 | **禁止写** | 唯一写入 |
| R/FSRS Card 与 due | 只读 | 只读 | **禁止写** | 唯一写入 |
| C_e ErrorPatternProjection | 只读 | 只读 | **禁止写** | 唯一写入 |
| LightEvidenceAtom | 写 | 读 | 读 | 无 |
| REMThemeCandidate | 无 | 写 | 读 | 无 |
| Dimension/Error/Student Annotation | 无 | 无 | 唯一写入 | 只读 |
| ContentInsightProposal | 无 | 可提议 | 可写待审核候选 | 内容审核后另行发布 |
| Dream Diary/运行报告 | 可写 | 可写 | 可写 | 无 |

数据库角色、API 和 schema 同时执行该矩阵，不能只依赖 Prompt 约束。

## 4. Light：逐题整理

### 4.1 触发

每个成功关闭且完整性检查通过的 QuestionSession 触发一个 Light Workflow。它是软异步；失败不影响下一题。

### 4.2 输入

宿主预编译一份最小、可授权、不可变的 `LightInputBundle`：

```text
question_session identity and frozen context
effective Attempts and Judgments
new Observations / DelayedReviewEvents / ErrorEvidence
interventions and hint levels
claim conclusions
before/after M/R/C_e projections
public conversation excerpts with stable refs
prior relevant Annotation refs
```

不输入：

- 模型隐藏推理；
- 后台 Agent 完整 transcript；
- 未授权的其他学生数据；
- 当前题之外的无限聊天历史；
- 已被 supersede 的事实，除非明确标为历史对照。

### 4.3 输出

`LearningEvidenceAtom` 是结构化题级材料：

```text
atom_id
student_id
question_session_id
dimensions[]
error_causes[]
observed_behavior[]
method_signals[]
hint_dependency
self_correction
transfer_context
supports[] / counters[] / unresolved[]
source_refs[]
model/prompt/skill version
created_at
```

Light 负责压缩、去重和归档，不得：

- 新造 Observation 或 ErrorEvidence；
- 把模型推断写成已发生事实；
- 把一次提示后成功称为掌握；
- 发布长期附注；
- 修改已有 Annotation。

### 4.4 确定性门禁

Light 输出在入库前校验：

- 所有 source ref 存在并属于该 QuestionSession；
- dimension/E revision 在冻结上下文内；
- support/counter 关系不得与 ErrorEvidence 相反；
- 不包含数值写字段；
- 文本长度和敏感信息符合政策；
- 同一 QuestionSession + compiler version 幂等。

Light 无法形成合格 Atom 时写明 `incomplete`，不伪造摘要。

## 5. REM：跨题反思

### 5.1 触发

REM 不必每题运行。触发条件包括：

- 新增达到批量阈值的 Light atoms；
- 同一 K/T/E 出现支持与反证冲突；
- 长期 unclassified 聚集；
- ErrorPattern 状态发生 confirmed/improving/resolved/recurrence；
- 定时扫描到有未消费材料；
- 教师要求重审某段窗口。

### 5.2 输入窗口

窗口按学生和主题构建，而不是简单取最近 N 条聊天：

```text
effective Light atoms
current M/R/C_e read model
current relevant Annotations
supersession/staleness events
context facets distribution
window boundaries and authorization manifest
```

REM 可按 K、T、E、方法、表示方式、提示依赖和时间阶段分组。它不直接读整个账号所有会话；宿主只给当前任务授权的稳定引用和必要摘要。

### 5.3 反思目标

REM 寻找：

- 多题重复的行为；
- 只在某种表示/难度/步骤出现的情境边界；
- 支持和反证同时存在的冲突；
- 提示依赖是否下降；
- near/far transfer 是否不同；
- resolved 后是否复发；
- 多个 unclassified 是否可能指向新错因；
- 某一道题/某条规则是否导致跨学生异常。

### 5.4 输出

```text
REMThemeCandidate
  candidate_id
  target_kind             dimension | error_cause | student_trait | content_insight
  target_ref
  proposed_claim
  proposed_scope
  support_refs[]
  counter_refs[]
  contradictions[]
  actionability
  distinct_session_count
  context_diversity
  recency
  source_trust
  recommended_action      hold | deep_review | collect_more | content_review
```

REM 只提出候选。即使模型说“高度确定”，也不能跳过 Deep 门禁。

## 6. Deep：有界长期写入

### 6.1 Deep 前的确定性门禁

候选进入 Deep 至少验证：

1. 所有来源仍存在、有效、未 supersede；
2. 来源不是工具输出、外部网页或后台自我生成内容冒充学生事实；
3. 达到该 target kind 的最小独立 QuestionSession 数；
4. 有必要的情境多样性或明确的局部 scope；
5. 显式携带 counterevidence，不能只报支持；
6. claim 可行动且不与 ErrorCause/科学术语混淆；
7. 不包含 M/R/C_e/计划的写操作；
8. 未超过每次 sweep 的写入、删除和 token 预算；
9. 若替代旧 Annotation，已生成 preimage 和 supersession plan；
10. 高风险学生特质或内容本体建议需要人工审核。

不同 Annotation 类型使用不同门槛，不照抄 OpenClaw 的六个固定权重。政策版本化、可解释，并由离线评估调整。

### 6.2 唯一允许的长期产物

#### DimensionAnnotation

附着到学生×知识点/题型 revision：

```text
annotation_id
student_id
dimension_revision_id
claim
scope                     representation, difficulty, method, step, answer form...
support_refs[]
counter_refs[]
confidence                low | medium | high
action_hint?
valid_from
review_due_at?
supersedes_annotation_id?
dream_run_id
```

#### ErrorAnnotation

附着到学生×错因 revision，描述情境和趋势，不写 state：

```text
claim / scope / trend / support / counter / action_hint
```

#### StudentTraitClaim

只保存与教学方式直接相关、跨情境稳定且可撤销的软偏好，例如“在先看结构图再列式时提示依赖较低”。不得写“聪明、懒惰、焦虑型”等人格化结论；默认需要更高证据门槛和更短有效期。

#### ContentInsightProposal

跨学生或跨题的内容候选，例如：

- 新 ErrorCause 候选；
- 现有 DiagnosisRule 区分力不足；
- 某题 rubric 可能诱发系统性误判；
- 某 remediation 在 far transfer 上效果差。

它进入内容审核，不自动改变内容 revision 或学生状态。

### 6.3 Annotation 不做什么

- 不给 BKT `p_final`；
- 不改 FSRS stability/difficulty/due；
- 不改 ErrorPattern state；
- 不增加独立 Observation 数；
- 不完成计划项；
- 不把“可能”去掉后写成事实；
- 不将旧附注原地覆盖。

## 7. Deep 提交协议

```text
1. Deep Agent 读取 gated bundle 和当前 Annotation 快照
2. 输出 AnnotationChangeSet（add / supersede / keep / propose_review）
3. Validator 校验 schema、来源、授权、范围、预算和禁止字段
4. 保存受影响 Annotation 的 preimage
5. 以 expected annotation-set version 原子提交
6. 写 DreamRun、diff、来源清单和 diary
7. 若版本冲突，重新编译窗口；不强行覆盖
```

Validator 不“修正”模型结果；不合格 ChangeSet 整体或按明确原子单元拒绝，并留下原因。模型不可用时保留旧 Annotation，允许未来重试。

## 8. 调度与 Runtime

采用 Temporal：

- `LightWorkflow` 由 `QuestionClosed` outbox 事件启动，workflow ID 基于 QuestionSession + compiler version 幂等；
- `REMSweepWorkflow` 由阈值事件或 Temporal Schedule 启动；
- `DeepConsolidationWorkflow` 只消费通过门禁的 REM candidates；
- sweep overlap policy 默认同一学生/主题串行，避免并发覆盖；
- 长窗口通过 Continue-As-New 或分批 Child Workflow 控制 history；
- 失败由 Activity retry 处理，非重试错误显式进入 review queue；
- 学生删除/教师纠正通过 Signal 标记当前窗口 stale，最终提交仍重验版本。

不在 Node 进程内用 `setInterval`、Map 锁或自制 Cron 管理 Dream。

## 9. Dream Diary、解释与回滚

每次相位运行保存机器记录和人类可读摘要：

```text
DreamRun
  run_id / phase / window / status
  inputs and compiler version
  candidate counts
  accepted/rejected reasons
  added/superseded/kept counts
  preimage_ref
  model/prompt/skill version
  started_at / finished_at
```

Diary 用于教师/运营理解发生了什么，不能被下一次 Dream 当作晋升证据。否则模型会学习自己的总结，形成自我强化回路。

回滚：

- 恢复 preimage 或新增反向 supersession；
- 不删除原始证据；
- 将依赖被纠正事实的 Annotation 标 stale；
- 回滚操作本身有 actor、reason 和时间。

## 10. 前台如何消费 Dream

### 10.1 上下文编译

每个前台 turn 只加载与当前题/Intent 相关的少量 Annotation：

- 当前 K/T 的有效附注；
- 当前 suspected/confirmed E 的有效附注；
- 与教学方式直接相关且未过期的 StudentTraitClaim；
- 明确的 counterevidence 和数据新鲜度。

不把全量 Dream 历史塞进 system prompt。Agent 可以通过只读工作区查看详细来源。

### 10.2 教学约束

前台把 Annotation 当成可质疑的上下文：

- 可以据此改变提示表征和选题偏好；
- 不应对学生宣称“系统已经认定你……”；
- 当前新证据冲突时优先尊重当前事实，并让 REM 复核旧附注；
- 不用附注绕过证据资格更新科学状态。

学生查看 Annotation、核对正反证据、报告不准确、暂停用于个性化，以及查看“本轮 Agent 实际参考了什么”的界面契约见 [07-前端设施后端读模型与统一交互语言.md](./07-前端设施后端读模型与统一交互语言.md)。这些操作创建反馈或使用偏好，不原地编辑 Annotation。

## 11. 典型案例

### 11.1 题型附注

三道不同 Session 显示：学生在给定辅助线时稳定，两道需要自行构图时停滞；另有一道自行构图成功。

- M：BKT 仍按五道合格 Observation 更新，例如 p=0.80；
- REM：识别表示方式边界和一条反证；
- Deep：写 medium-confidence DimensionAnnotation，scope=`implicit_auxiliary_line`；
- Selector：后续可偏向该 scope 的验证题；
- Dream 不降低 p。

### 11.2 错因复发

ErrorPattern reducer 已因 delayed verification 进入 resolved，后来新题出现 decisive support：

- reducer 立即回到 confirmed，recurrence_count+1；
- Light 保存本题复发事实；
- REM 比较复发情境；
- Deep 可把 ErrorAnnotation 改为“在时间压力/复杂图形下复发”，但不是它触发状态变化。

### 11.3 规则可能有问题

同一道题在多个学生上产生同一 E 支持，但其他题没有：

- 不批量给学生 confirmed；
- REM 生成 ContentInsightProposal；
- Deep/人工审核检查题干、图形、rubric 和 DiagnosisRule；
- 修正后 supersede 错误事实并重放。

## 12. 当前实现迁移

需要废止：

- `ProfileUpdateDecision.dimension_updates.p_final` 由 Dream 计算；
- Dream evidence LR 直接修正 BKT；
- `misconception_updates` 直接覆盖状态；
- Dream 成为 StudentSnapshot 的数值唯一写入口；
- TSS/SER 必须成对完成后才允许关闭 QuestionSession。

保留并重构：

- 证据 bundle 编译思想；
- 来源授权、引用存在、窗口覆盖等 Validator 能力；
- supersession、preimage、review_required 和审计记录；
- Pi 独立 AgentAttempt；
- 现有 outbox 作为领域事务到 Temporal 的桥；
- OpenClaw 三相位、单深层写入口、Diary 和回滚纪律。

新的 `StudentScientificState` 由 M/R/C_e reducer 发布，Dream Annotation 由独立的 `SemanticMemoryView` 叠加；不再用一个模型生成的 Snapshot 同时统治数值和语义。

## 13. 质量指标

- Annotation 引用有效率、正反证据覆盖率；
- 不同 Deep 重跑的一致性；
- 教师接受/修改/驳回率；
- Annotation 对后续教学选择和学习结果的增益；
- stale Annotation 检出和处理延迟；
- 错误数值写尝试拦截率必须为 100%；
- 同一事实经 Light/REM/Deep 再次进入科学内核的双计数率必须为 0；
- Deep 写入预算、prior loss 和 supersession 可解释性；
- 隐私删除后来源与附注处理符合政策。

## 14. 验收标准

1. 每个 closed QuestionSession 至多生成一个生效 Light atom/version；
2. Light/REM 无法写长期 Annotation；
3. Deep schema 中不存在 M/R/C_e 数值或状态写字段；
4. 一条附注必须带 scope、support refs，并显式允许 counter refs；
5. 来源被 supersede 后，相关 candidate 在提交前失效，已有 Annotation 标 stale；
6. 并发 Deep 用版本校验避免最后写覆盖；
7. 失败重试不重复新增 Annotation；
8. preimage、diff、Diary 和 rollback 都可查询；
9. Diary/REM 文本不能成为下一轮的原始证据；
10. 题型 p 值保持程序权威，Dream 能稳定附加情境说明而不修改它。
