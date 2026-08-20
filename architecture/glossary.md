# MathPilot 统一术语表

> 全项目必须使用本表术语；禁止同一概念使用多个同义词。引用本表时用 `glossary#term`。

## 边界与角色

| 术语 | 定义 |
|---|---|
| Content Studio | 内容边界：上传 → OCR → KTQ/ER → 复核 → 发布不可变章节包 |
| Learning Runtime | 学习边界：选题 → 单题 Session → 判答/教学 → 双产物 |
| Learner State | 状态边界：Dream 更新 → 校验 → 快照 → 计划 |
| Governance | 治理边界：教师复核、重放、评测、审计 |
| Teaching Agent | 负责判答、追问、讲解、单题观察的教学模型角色；无画像写权限 |
| Dream / Profile Update Agent | 负责最终画像更新的独立大模型角色；无教学对话权限 |
| Deterministic Services | 传统程序：BKT 评价、保持率、统计、校验、选题、重放 |
| KTQ Extraction Agent | 从来源片段抽取 K/T/Q 的隔离内容 Agent |
| ER Research Agent | 调研归纳 E/R 的隔离内容 Agent |

## 内容对象

| 术语 | 定义 |
|---|---|
| SourceDocument | 教师上传原件（PDF/讲义/习题/页面），哈希固定 |
| SourceFragment | 页码、段落、题目框等可引用最小片段 |
| CandidateClaim | AI 从片段提取的候选字段及置信度 |
| ReviewTask | 教师确认/修改/拒绝内容项的任务 |
| ChapterPackage | 一次发布的不可变章节包（version + manifest_hash） |
| K / T / E / Q / R | KnowledgeComponent / QuestionType / ErrorCause / Question / DiagnosisRule |
| MeasurementTarget | 每题的测量维度、角色（primary/secondary/prerequisite）与 evidence_rule |

## 学习对象

| 术语 | 定义 |
|---|---|
| AssessmentRun | 有目标、预算、覆盖与终止条件的一轮诊断 |
| QuestionSession | 一题一会话；状态机由程序控制 |
| Attempt | 一次独立提交 |
| AnswerJudgment | Teaching Agent 的最终判答（模型主判） |
| DiagnosticClaim | 带候选错因、替代解释与证据的候选诊断 |
| StateObservation | 算法内核可接受的 success/failure/unresolved 观测 |
| InterventionEvent | 提示、讲解、变式或反馈事件 |
| LearningArtifact | 受控文件产物（HTML/卡片/图片/视频），经 ArtifactPublisher 发布 |
| ArtifactResponse | 学生对卡片的作答/跳过/直接回复交互 |
| TeachingMessage | 文字+图片+视频+卡片组成的多段回复 |

## 状态对象（四层）

| 术语 | 定义 |
|---|---|
| 事实层 | 不可变 Session、Attempt、笔迹、聊天、观测、教师纠正 |
| ScientificEvaluationReport (SER) | 确定性程序按已确认事件算出的科学基准（BKT 等） |
| TeachingSessionSummary (TSS) | Teaching Agent 关闭 Session 时输出的简短语义总结 |
| SessionLearningRecord (SLR) | SER+TSS 成对封装；缺失任一项不进 Dream |
| ProfileEvidenceBundle | Dream 的多 Session 投影 + 按需展开的证据索引 |
| ProfileUpdateDecision (PUD) | 画像大模型的最终更新决策（含证据账本） |
| ProfileDecisionValidationResult | 确定性校验器对 PUD 的结果（只校验不修改） |
| StudentSnapshot | 通过校验的 PUD 幂等物化得到的画像状态 |
| profile_lag | Dream 尚未完成的当前画像滞后状态 |

## 量化概念

| 术语 | 定义 |
|---|---|
| M_k | 知识/题型习得概率（BKT P(L)） |
| R_k(Δt) | 当前可提取性（艾宾浩斯式保持率），不改写 M |
| I90 | 预测保持率降到 0.9 所需天数 |
| C_e | 错因证据状态（suspected/confirmed/improving/resolved/superseded） |
| evidence_code | 纵向证据码（如 TRANSFER_SUCCESS_DISTINCT_CONTEXT） |
| LR | 证据码允许的似然比区间，施加于 logit(P_bkt) 之上 |
| 双产物 | 每次 Session 的 SER 与 TSS 两者合称 |
| 测量规则 | MeasurementTarget 的 evidence_rule；只有规则证据出现才对相应维度更新 |

## 治理与安全

| 术语 | 定义 |
|---|---|
| TeacherCorrection | supersede/撤销事件；触发状态重放，旧结论保留不生效 |
| field_lineage | 字段血缘：来源片段、Agent Run、模型/Prompt 版本、审核决定 |
| provenance_status | direct/derived/model_generated/human_authored |
| 章节包 | 见 ChapterPackage |
| handoff | Session 间短期连续性包（仅教学用，不改长期画像） |

## ID 与版本

| 术语 | 定义 |
|---|---|
| TenantId / UserId / StudentId / TeacherId | 身份标识 |
| SessionId / AttemptId / EventId / SnapshotId | 事件与状态标识 |
| correlation / causation ID | 全链路追踪 |
| snapshot_id | 唯一快照标识（时间戳+哈希，禁止只用日期） |