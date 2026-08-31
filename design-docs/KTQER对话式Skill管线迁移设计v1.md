# KTQ/ER 对话式 Skill 管线迁移设计 v1

> **2026-08-31 实施收敛说明**：本设计已经在 `web-next`、`api-next`、
> `pi-chat-runtime`、`content-next`、`storage-next` 和单次正式迁移
> `0031_content_pipeline_cutover.sql` 中落地。以下“当前实现/建议/本轮不实施”文字保留为
> 设计过程记录；若与本说明冲突，以本说明及 `architecture/review/002-...audit.md` 的最终状态为准。
> 旧 `web/api/content/agent-runtime` 实现没有作为新架构继续修改或兼容。

## 1. 本轮结论

目标架构与逐文件边界已经完成实现，并按一次切换而非长期双写收敛。

目标形态如下：

- 用户只有一套统一身份，产品角色关系只允许 `teacher` 与 `student`；当前部署每个租户
  恰好一个 `teacher`。
- `pi_threads` 只归属于统一用户，不再保存学生身份字段。
- KTQ 和 ER 都是普通对话，不增加特殊会话类型，也不建立两个对话之间的父子关系。
- 教师在普通对话中明确提出内容生产请求后，模型读取 KTQ Skill，并按 Skill 调用 OCR、Core、Search 和受控内容库查询工具。
- KTQ 的 `respond` 结果在对话里呈现为 assistant-ui 复核卡片。教师进入独立复核页，对单条内容或具体字段批注。
- 有批注时回到原 KTQ 对话修改；当前轮无批注并确认后，宿主创建一个新的普通 ER 会话，注入已批准的 KTQ 结果引用并启动 ER。
- ER 使用相同的“生成—复核—返回修改”闭环。最终无批注通过后生成归属于教师的可发布包，但不自动发布到任何班级。
- 内容库分为官方内容与教师内容。教师内容始终归创建教师所有；发布到班级只是新增可见关系，不复制内容、不改变归属。
- 文件实体保存在私有 MinIO 中。数据库保存稳定对象定位信息和校验信息，下载时按权限签发短时效 MinIO 预签名地址，不再为了下载而恢复会话工作区。
- 不新增组织实体、组织成员关系或组织维度授权。授权由用户角色、班级成员、内容归属和班级发布关系计算。

### 1.1 迁移前实现核对（历史）

下表记录实施前差距，不代表最终代码状态：

| 范围 | 迁移前实现 | 已落地目标 |
| --- | --- | --- |
| KTQ/ER | `src/services/agent-runtime/skills/ktq-extraction/`、`er-research/` 保存 Skill、模板和校验器；`src/services/agent-runtime/src/runtime.ts` 集中注册 OCR/Core/Search | Skill 与能力迁入 `pi-chat-runtime`，由普通对话按需发现和调用 |
| 新 Pi 运行时 | `src/services/pi-chat-runtime/skills/` 目前只有 `learning-ui`；`extensions/respond.ts` 只有通用终止结果 | 增加 KTQ/ER Skill、旧管线等价工具和宿主管控的 `respond` 落库处理 |
| Pi 身份 | `src/apps/web-next/db/migrations/0001_pi_threads.sql` 同时保存 `owner_user_id`、`student_id`；`pi-thread-store.ts` 注入学生可见范围 | 线程只保留统一所有者，卡片事件记录统一 actor |
| 班级关系 | `db/migrations/0001_identity.sql` 的班级保存教师列；`0018_content_library_scope.sql` 另建教师—学生绑定 | 每租户唯一教师可管理多个班级；学生关系只通过班级成员表表达 |
| 内容数据 | `db/migrations/0002_content.sql` 的主要实体依赖 `payload jsonb`；`src/services/content/src/index.ts` 集中处理管线、内容和发布 | K/T/Q/E/R、来源、关系、复核和包拆成可检索的表与不可变修订 |
| 内容复核 | `db/migrations/0005_review.sql` 与 `src/services/review/src/index.ts` 保存整块候选/修改 payload | 教师内容复核由 content 服务按候选集、实体、字段保存批注 |
| 文件 | `pi-object-store.ts` 面向工作区归档；`pi-chat-routes.ts` 上传 base64，下载前恢复线程工作区再由 API 返回字节 | 私有 MinIO 对象登记、浏览器直传、授权后预签名直下；工作区只按需物化 |
| 前端 | `PiRuntimeProvider.tsx` 和 `learning-toolkit.tsx` 已有 assistant-ui 工具 UI 基础，但没有独立复核页面 | 用 toolkit entry 注册 `respond` 复核卡片，并增加字段化复核页 |

迁移以新 Pi 普通对话为唯一目标运行时，不在旧 `agent-runtime` 上继续扩展业务状态。

## 2. 明确不做的事情

- 不让模型持有 PostgreSQL 或 MinIO 凭据。
- 不允许模型提交用户 ID、教师 ID、角色或可见范围来决定查询权限。
- 不把 Skill 文本当成安全边界；Skill 只描述工作方法，权限必须由宿主和服务端执行。
- 不继续把 K/T/Q/E/R、复核内容或发布包整体塞入 `payload jsonb`。
- 不保留新旧内容管线双读、双写或旧入口转发。正式迁移采用一次性数据转换、校验、切换和旧入口删除。
- 不把预签名 URL 当作持久文件引用，也不把它写入内容溯源。
- 不在本轮引入 KTQ 对话与 ER 对话的会话级关联表。

## 3. 身份、班级与内容可见性

### 3.1 统一用户与两种角色

`identity_user` 是唯一用户主体。角色拆为关系表，避免 Better Auth 单字符串角色、领域库 `roles[]` 和请求头角色列表分别成为事实源。

建议表：

| 表 | 关键字段 | 约束与用途 |
| --- | --- | --- |
| `identity_user` | `user_id`, `oidc_sub`, `display_name`, `status`, `created_at`, `updated_at` | 唯一用户主体 |
| `identity_user_role` | `user_id`, `role`, `assigned_by_user_id`, `assigned_at` | 主键为 `(user_id, role)`；`role` 首期只允许 `teacher`、`student` |
| `identity_class` | `class_id`, `name`, `created_by_user_id`, `join_code`, `allow_official_content`, `status`, `created_at`, `updated_at` | 创建人必须具有教师角色；`join_code` 唯一；官方库开关默认开启 |
| `identity_class_user` | `class_id`, `user_id`, `class_role`, `status`, `added_by_user_id`, `joined_at` | 主键为 `(class_id, user_id)`；`class_role` 只允许 `teacher` 或 `student`；唯一教师可管理多个班级，学生可加入多个班级 |

班级创建事务必须同时写入：

1. `identity_class`；
2. 创建教师的 `identity_class_user(class_role = 'teacher')`。

Next 授权只读取 `identity_class_user`，不再把旧 `teacher_id` 或独立教师—学生绑定当作
事实源。旧列留到显式 cutover 清理，以免新实现反向修改旧服务。

班级管理权限固定为：该租户唯一教师创建和管理班级、管理学生、修改官方库开关，且只能
发布或撤下自己拥有的内容包。迁移通过 `(tenant_id) where role='teacher'` 唯一索引落实这一约束。

当前数据库已有的 `tenant_id` 本轮只维持原有部署级数据边界，不新增对应的产品实体、成员表或用户操作入口，也不让它参与班级内容授权。下文表格为突出业务拆分省略该重复列，实际迁移仍遵守现有租户外键和 RLS。

### 3.2 内容归属与发布

教师创建的实体和发布包都保存 `owner_teacher_user_id`，并要求该用户具有教师角色。官方初始库使用 `origin = 'official'`，教师内容使用 `origin = 'teacher'`：

- `origin = 'official'` 时，`owner_teacher_user_id` 必须为空；
- `origin = 'teacher'` 时，`owner_teacher_user_id` 必须非空；
- 教师发布自己的包到班级时只增加 `content_package_class_release`；
- 撤下班级发布只关闭发布关系，不删除包、不修改内容所有者；
- 最终复核通过只生成 `ready` 包。教师必须另行选择班级并执行发布。

### 3.3 可见性规则

服务端按当前登录用户计算内容并集，不接收模型传入的作用域：

| 当前用户 | 可见内容 |
| --- | --- |
| 教师 | 官方库；自己拥有的全部内容 |
| 有班级的学生 | 所加入班级中仍有效的发布包；若任一所加入班级开启官方库，则再加官方库 |
| 没有班级的学生 | 官方库 |

补充规则：

- 一个学生加入多个班级时，班级发布内容取并集。
- 官方库开关也使用并集语义：至少一个有效班级允许即可查看。
- 班级成员退出、发布撤下或角色失效后，下次查询立即按新关系计算，不保存静态用户—内容授权副本。
- 唯一教师只能把自己拥有且状态为 `ready` 的包发布到自己任教的班级。
- 所有列表、搜索、详情和文件下载都必须复用同一套可见性函数，避免入口间权限漂移。

普通产品页面可以按上表展示班级已经发布的内容；教师在 KTQ/ER 对话中调用的模型内容库
工具只返回官方库和当前教师自己拥有的内容。学生对话的内容工具按学生班级发布和官方库
开关计算。

## 4. 宿主管控方案

采用“宿主注入身份 + 类型化领域工具 + 服务端授权查询”的方式，不再给模型通用 SQL 工具。

### 4.1 信任边界

```text
浏览器登录身份
    -> api-next 验证会话并产生可信 principal
        -> pi-chat-runtime 绑定 thread.owner_user_id
            -> 内容工具仅携带宿主签发的 principal
                -> content 服务计算班级/所有者/官方库可见范围
                    -> PostgreSQL
```

模型只能提供业务查询条件，例如关键词、实体类型、页码和数量。以下字段不出现在模型工具参数里：

- `user_id`
- `owner_teacher_user_id`
- `class_id` 形式的权限覆盖参数
- 用户角色
- 任意 SQL、表名、where 片段

### 4.2 给模型的内容库工具

在 OCR、Core、Search 能力保持与旧管线等价的基础上，仅增加两个领域查询工具：

1. `content_library_search`
   - 输入：`query`, `entity_kinds`, `cursor`, `limit`；
   - 输出：有界、分页、字段固定的摘要投影和稳定实体引用；
   - 服务端自动加入当前用户可见性条件。
2. `content_library_get`
   - 输入：`entity_ref` 或 `package_ref`；
   - 输出：规范化详情、版本号和可用来源引用；
   - 服务端再次做对象级授权，不信任前一步搜索结果。

写入不通过这两个工具。模型在工作区生成符合 Skill 契约的结果文件并调用 `respond`；宿主验证器解析文件，内容服务在一个事务中写入规范化候选记录。

### 4.3 为什么选择这一方式

- 授权由登录主体决定，模型无法通过提示词扩大查询范围。
- 班级变化实时反映到查询结果，不需要维护大规模用户—内容静态绑定。
- 工具返回的是稳定、可验证的领域结构，不把数据库 Schema 暴露给模型。
- 所有查询均可限制实体类型、条数、字段和执行时间，便于审计和容量控制。
- Pi 沙箱无需数据库网络权限，也无需把凭据写进会话环境。
- 教师模型工具采用“官方库 + 当前教师所有内容”的固定投影；班级共同可见不自动转换为教师模型可见。

## 5. KTQ/ER 对话与复核状态机

### 5.1 KTQ 启动

1. 教师在任意普通对话中明确请求 KTQ 内容生产。
2. 模型通过运行时的 Skill 发现机制读取 `ktq-extraction/SKILL.md`。
3. 模型按 Skill 使用附件、OCR、Core、Search、内容库查询工具。
4. 模型完成结果文件后调用 `respond`。
5. 宿主确认当前用户具有教师角色，运行 KTQ 校验器并校验所有文件引用。
6. 校验通过后，内容服务写入一个新的 KTQ `content_candidate_set` 及规范化候选实体修订。
7. `respond` 的工具结果返回 `kind = 'content_review'`、候选集 ID、摘要、复核地址；assistant-ui 将其渲染为教学式复核卡片。

`respond` 仍是模型的终止工具，不增加一个让模型自行伪造复核卡片的工具。复核卡片描述由宿主在校验和落库成功后生成。

### 5.2 逐条复核与返回修改

复核页面地址固定为 `/content/review/:candidateSetId`。页面必须支持：

- 按 K/T/Q/E/R 类型分组查看；
- 查看每一条候选内容和来源溯源；
- 对整条内容批注；
- 对允许编辑的具体字段批注；
- 保存批注草稿；
- “返回 KTQ 修改”或“无批注，进入下一步”两个互斥动作。

当存在批注时：

1. 用户点击“返回 KTQ 修改”；
2. 服务端冻结本轮批注，并把本候选集标记为 `changes_requested`；
3. 同一事务把复核决定作为待投递 outbox；content 服务轮询并由宿主向原 KTQ 普通对话追加一条结构化、用户可见的复核反馈消息，其中只包含候选项引用、字段名和批注文本；
4. 浏览器返回 `/c/:threadId`；
5. 模型重新读取/继续遵循 KTQ Skill，生成新的候选集；
6. 新候选集以 `supersedes_candidate_set_id` 指向旧候选集，旧内容不可原地覆盖。

当前候选集只有在“没有任何未撤销批注”时才允许批准。前端禁用按钮不是安全措施，内容服务必须在批准事务中再次检查。

### 5.3 从 KTQ 进入 ER

内容库和 Pi 线程当前位于两个 PostgreSQL 数据库，不能把“批准 KTQ”和“创建 ER 线程”假定为一个数据库事务。这里采用事务性命令 + 幂等创建：

1. content 服务在批准事务中将 KTQ 候选集标记为 `approved`，同时写入唯一的 `content_er_start_command`，并预先生成目标 `thread_id`；
2. 宿主投递该命令到 pi-chat-runtime；
3. pi-chat-runtime 以命令 ID 为幂等键，使用预生成 ID 创建一个新的普通 `pi_thread`，所有者仍是当前教师；
4. pi-chat-runtime 向新会话追加一条用户可见的宿主启动消息，其中包含已批准 KTQ 候选集引用、稳定文件引用和“读取 `er-research` Skill 开始工作”的明确任务；
5. pi-chat-runtime 启动一次模型运行并确认接收；
6. content 服务将命令标记为 `dispatched`，浏览器取得目标线程 ID 后导航到新会话。

未确认的同一命令只会再次投递到同一个预生成线程 ID，不会创建第二个 ER 对话。这是跨数据库交接的一致性机制，不改变普通会话身份。

不在 `pi_threads` 中增加 `parent_thread_id`、`workflow_id` 或 `thread_type`。ER 候选集只引用作为业务输入的 KTQ 候选集，不保存“前一个会话 ID”；因此两段对话仍是独立普通对话。

### 5.4 ER 复核与可发布包

ER 使用与 KTQ 相同的复核机制：

- 有批注：回到本次 ER 的原普通对话，生成新的 ER 候选集；
- 无批注：批准当前 ER 候选集，并在同一事务中生成 `content_package(status = 'ready')`；
- 包的 `owner_teacher_user_id` 是当前教师；
- 包项同时锁定该流程已批准的 K/T/Q 与 E/R 实体修订，不指向可变“最新版”；
- 包生成后展示“查看包/选择班级发布”卡片，不自动向班级发布。

## 6. 规范化数据库设计

原则：JSON 可以继续作为 Skill 的文件交换格式，但进入数据库前必须完成 Schema 校验和字段拆分。原始结果文件作为 MinIO 审计对象保存，不能代替可检索的业务行。

旧数据转换不得继续沿用 `0018_content_library_scope.sql` 中“已发布即公共”的推断：

- 官方内容只能来自一份人工确认的初始库清单；旧 `public/published` 标记本身不能证明内容属于官方库；
- 教师内容优先使用可追溯的原始 `created_by`；无法追溯时使用该租户唯一 teacher 作为确定性默认 owner；
- 转换工具先生成数量、所有者、关系和哈希对账报告，全部通过后才允许执行 `0037_remove_legacy_content_pipeline.sql`。

### 6.1 K/T/Q/E/R 实体与不可变修订

| 表 | 关键字段 |
| --- | --- |
| `content_entity` | `entity_id`, `entity_kind`, `origin`, `owner_teacher_user_id`, `created_by_user_id`, `created_at` |
| `content_entity_revision` | `revision_id`, `entity_id`, `revision_no`, `candidate_set_id`, `lifecycle_status`, `created_by_thread_id`, `model_id`, `prompt_version`, `created_at` |
| `content_knowledge_revision` | `revision_id`, `name`, `description`, `grade_band`, `difficulty`, `mastery_standard`, `remediation_advice` |
| `content_question_type_revision` | `revision_id`, `name`, `description`, `identifying_features`, `standard_method` |
| `content_question_revision` | `revision_id`, `chapter_id`, `stem_format`, `stem_markdown`, `difficulty`, `question_type_revision_id`, `analysis_markdown` |
| `content_error_cause_revision` | `revision_id`, `category`, `name`, `description`, `manifestation`, `judgment_basis`, `remediation` |
| `content_diagnosis_rule_revision` | `revision_id`, `rule_version`, `trigger_text`, `probe_text` |

`content_entity_revision` 及其子类型行一经 `respond` 接受就不可更新。修改产生新实体修订和新候选集，保证复核、溯源和发布包始终能重现。

教师内容的 `candidate_set_id`、`created_by_thread_id` 必须非空；官方初始库导入的修订允许这两个字段为空，并由经过确认的导入批次和来源哈希负责溯源。

### 6.2 结构关系表

所有可重复子项先登记到 `content_revision_item(item_id, revision_id, item_kind, position)`。这样选项、答案、评分点、关系、资源都拥有稳定行 ID，既能固定目标修订，也能让复核批注和字段溯源精确指向单独一条。

| 表 | 关键字段与用途 |
| --- | --- |
| `content_revision_item` | `item_id`, `revision_id`, `item_kind`, `position` |
| `content_knowledge_prerequisite` | `item_id`, `prerequisite_revision_id`, `relation_kind` |
| `content_question_type_knowledge` | `item_id`, `knowledge_revision_id`, `role` |
| `content_question_option` | `item_id`, `option_key`, `option_text`, `is_correct` |
| `content_question_answer_item` | `item_id`, `answer_text`, `equivalence_rule` |
| `content_question_rubric_item` | `item_id`, `criterion`, `score` |
| `content_question_measurement_target` | `item_id`, `dimension_revision_id`, `target_role`, `evidence_rule` |
| `content_question_asset_revision` | `item_id`, `storage_object_id`, `asset_role`, `source_locator`, `mime_type`, `content_sha256` |
| `content_error_cause_knowledge` | `item_id`, `knowledge_revision_id`, `relation_kind` |
| `content_diagnosis_rule_dimension` | `item_id`, `dimension_revision_id` |
| `content_diagnosis_rule_error_cause` | `item_id`, `error_cause_revision_id` |
| `content_diagnosis_rule_citation` | `item_id`, `source_excerpt_id`, `claim_text` |

每个子类型表的 `item_id` 都是指向 `content_revision_item` 的主键/外键，并由约束确认 `item_kind` 相符。所有目标都指向具体 `revision_id`，不指向会随以后修改漂移的逻辑实体最新版；这些表不再用 JSON 数组保存实体关系。

### 6.3 来源与字段溯源

| 表 | 关键字段 |
| --- | --- |
| `storage_object` | `object_id`, `bucket_name`, `object_key`, `version_id`, `etag`, `sha256`, `byte_size`, `mime_type`, `original_name`, `owner_user_id`, `purpose`, `state`, `created_at`, `verified_at` |
| `content_source` | `source_id`, `origin`, `owner_teacher_user_id`, `uploaded_by_user_id`, `source_kind`, `original_sha256`, `storage_object_id`, `source_uri`, `verified_at`, `created_at` |
| `content_source_page` | `source_page_id`, `source_id`, `page_no`, `width`, `height`, `page_object_id` |
| `content_source_excerpt` | `source_excerpt_id`, `source_page_id`, `fragment_no`, `fragment_kind`, `bbox`, `text_content`, `content_sha256`, `created_at` |
| `content_field_provenance` | `provenance_id`, `revision_id`, `revision_item_id`, `field_name`, `source_excerpt_id`, `source_object_id`, `thread_id`, `tool_call_id`, `source_locator`, `derivation_type`, `provenance_status`, `review_decision`, `created_at` |

`etag` 只保存为对象存储返回的标识，不充当内容哈希。文件内容一致性统一使用服务端计算的 SHA-256。

来源沿用实体的归属约束：官方来源所有者为空，教师来源所有者必须是上传教师。线程附件
关系单独保存在 Pi 数据库的 `pi_attachments`，不把会话恢复目录当成附件目录表。

### 6.4 候选集、复核与轮次

| 表 | 关键字段 |
| --- | --- |
| `content_candidate_set` | `candidate_set_id`, `phase`, `owner_teacher_user_id`, `thread_id`, `sequence_no`, `input_candidate_set_id`, `supersedes_candidate_set_id`, `result_object_id`, `receipt_object_id`, `result_sha256`, `respond_tool_call_id`, `status`, `created_at`, `decided_at` |
| `content_candidate_set_item` | `candidate_set_id`, `revision_id`, `item_order` |
| `content_review_annotation` | `annotation_id`, `candidate_set_id`, `revision_id`, `revision_item_id`, `field_name`, `comment_text`, `author_user_id`, `state`, `created_at`, `withdrawn_at`, `submitted_at` |
| `content_review_decision` | `decision_id`, `candidate_set_id`, `decision`, `decided_by_user_id`, `decided_at`, `feedback_attempt_count`, `feedback_last_error`, `feedback_next_attempt_at`, `feedback_dispatched_at` |
| `content_er_start_command` | `command_id`, `approved_ktq_candidate_set_id`, `target_thread_id`, `status`, `attempt_count`, `last_error`, `created_at`, `dispatched_at` |

约束：

- `phase` 只允许 `ktq`、`er`；
- `status` 只允许 `pending_review`、`changes_requested`、`approved`、`superseded`；
- 批注 `state` 只允许 `draft`、`submitted`、`withdrawn`；审批时 `draft` 和 `submitted` 都算有效批注；
- 复核决定只允许 `changes_requested`、`approved`；ER 启动命令只允许 `pending`、`dispatched`，投递错误保留在 `pending` 并记录错误，不产生替代会话；
- ER 的 `input_candidate_set_id` 必须指向已批准的 KTQ 候选集；
- KTQ 的 `input_candidate_set_id` 必须为空；
- 每个已批准 KTQ 候选集最多一个 ER 启动命令，目标线程 ID 在命令创建时确定；
- 每个候选集最多一个最终决定；
- 批准事务要求该候选集不存在有效批注；
- 返回修改要求至少一条有效批注；决定写入后旧批注被冻结，投递状态字段作为返回原 Pi 会话的 outbox；
- `revision_item_id` 为空时批注整条实体或实体字段，非空时必须属于同一 `revision_id`，用于批注某个选项、答案、评分点、关系或资源；
- `thread_id` 只记录本候选集由哪个普通对话产生，不用它关联 KTQ 和 ER 对话。

### 6.5 发布包与班级发布

| 表 | 关键字段 |
| --- | --- |
| `content_package` | `package_id`, `origin`, `owner_teacher_user_id`, `title`, `version_no`, `status`, `manifest_object_id`, `manifest_sha256`, `approved_er_candidate_set_id`, `created_at` |
| `content_package_item` | `package_id`, `revision_id`, `item_order` |
| `content_package_class_release` | `package_id`, `class_id`, `published_by_user_id`, `published_at`, `withdrawn_at` |

发布包通过 `content_package_item.revision_id` 固定具体版本。班级只能看到仍有效的发布关系，不能借包 ID 查看未发布包。

教师包要求 `origin = 'teacher'`、所有者非空、`approved_er_candidate_set_id` 非空；官方初始包要求 `origin = 'official'`、所有者为空、ER 候选集为空，并引用已确认的官方导入批次。

### 6.6 检索索引

首期索引边界：

- K/T/E/R 的 `name`、`description`、`trigger_text` 建 PostgreSQL 全文检索索引；
- Q 的 `stem_markdown`、`analysis_markdown` 建全文检索索引；
- 所有所有者、班级成员、包发布、候选状态和外键列建 B-tree 索引；
- `content_field_provenance(tenant_id, revision_id, revision_item_id, field_name)` 建组合索引；
- 不为整块 JSON 建 GIN 索引，因为业务字段已拆分。

## 7. MinIO 文件模型

### 7.1 存储策略

所有 bucket 保持私有：

| Bucket | 内容 | 版本与保留策略 |
| --- | --- | --- |
| `mathpilot-content` | 原始来源、批准后的发布包、包清单 | 开启版本；当前版本不自动过期 |
| `mathpilot-working` | KTQ/ER 候选结果、校验回执、临时派生文件 | 开启版本；当前不自动删除审计对象 |
| `mathpilot-session` | 预留的 Pi 会话归档对象 | 当前 Pi JSONL/工作区仍保存在 runtime 卷，不作为内容文件事实源 |

对象键不包含用户名或邮箱，使用不可猜测 ID：

```text
source/<source_id>/<object_id>/<sanitized-name>
candidate/<object_id>/<sanitized-name>
package/<package_id>/<object_id>/<sanitized-name>
thread/<thread_id>/<archive-id>/<archive-name>
```

持久引用由 `bucket_name + object_key + version_id + sha256` 组成。对话、复核页、发布包和溯源表都引用 `storage_object.object_id`；展示时可以附带稳定 `object_key`，但不保存短时效 URL。

### 7.2 直接上传

浏览器上传改为：

1. 浏览器请求具体领域的上传初始化接口；
2. 领域服务检查线程所有者或教师权限，并向 storage 服务申请对象；
3. storage 服务创建 `pending` 对象记录并返回 MinIO 预签名 PUT 地址；
4. 浏览器直接上传到 MinIO；
5. 浏览器调用完成接口；
6. storage 服务读取对象元数据并流式计算一次 SHA-256，验证大小和允许的 MIME 类型；
7. 验证通过后置为 `ready`，领域服务再绑定到线程附件、来源文档或候选集。

客户端上传的哈希和 MIME 只能用于提前报错，不能替代服务端验证。MinIO CORS 只允许 MathPilot 的精确 Web Origin、PUT/GET/HEAD 和必要请求头。

### 7.3 直接下载

不提供“给任意 object ID 下载”的公共接口，按领域授权：

- `/api/chat/threads/:threadId/attachments/:objectId/download`
- `/api/content/sources/:sourceDocumentId/files/:objectId/download`
- `/api/content/packages/:packageId/files/:objectId/download`

领域服务先按当前用户检查线程所有权、候选所有权或内容可见性，再请求 storage 服务为精确对象版本生成短时效预签名 GET 地址。浏览器随后直接从 MinIO 下载，API 不代理文件字节，也不触发工作区恢复。

预签名地址建议有效期 5 分钟；这是访问凭证，不是文件身份。过期后由同一领域接口重新签发。

### 7.4 工作区与溯源

- 模型沙箱不持有 MinIO Access Key/Secret Key。
- 宿主只把已授权对象按需物化为只读工作区文件，并同时提供 `object_id`、`object_key`、`version_id`、`sha256` 描述。
- `respond` 校验器拒绝未登记对象、跨用户对象、版本不匹配对象和哈希不一致对象。
- 当前会话归档保留在 runtime 卷；附件只保存稳定对象引用，不在工作区归档中重复复制原件。
- 恢复会话只在模型需要继续工作时执行；用户下载不依赖恢复。
- 官方内容、已批准来源和已发布包不使用自动过期；未批准候选文件可在业务记录明确终止后按生命周期清理。

以上设计基于 MinIO 官方文档提供的预签名上传/下载、对象元数据、版本和生命周期能力。预签名 URL 的生成封装在 storage 服务中，前端和模型均不直接持有 MinIO 管理凭据。

## 8. 前端交互边界

### 8.1 对话内复核卡片

按 assistant-ui 当前推荐的 toolkit entry 方式，以工具名注册 `respond` 的类型化自定义渲染器，不采用已弃用的 `makeAssistantToolUI`。当工具结果的 `kind` 为 `content_review` 时展示：

- KTQ 或 ER 阶段；
- 候选条数及 K/T/Q/E/R 分类计数；
- 校验状态；
- “进入复核”按钮；
- 已请求修改、已批准等只读状态。

卡片的数据来自服务端落库结果，不从模型 message 文本解析。

ER 的 `respond` 仍先产生复核卡；教师在独立复核页批准后，决定接口返回真实包 ID，页面展示“查看并发布”按钮并跳转到 `/content/packages/:packageId`。

### 8.2 复核页面

复核页以候选集为边界，页面加载和每次写批注都重新验证当前教师是候选集所有者。页面布局建议为：

- 左侧：类型分组和条目导航；
- 中间：当前条目的字段化内容与来源；
- 右侧：条目/字段批注；
- 底部固定动作区：返回修改或无批注进入下一步。

这不是通用 JSON 编辑器。每种实体使用对应字段组件，关系项、选项、答案、评分点和引用都以独立行展示，才能对单项批注。

### 8.3 发布包页面

`/content/packages/:packageId` 展示固定修订清单、来源、版本、所有者和当前班级发布状态。只有包所有者能看到班级选择与发布/撤下动作；可选班级只来自当前用户作为有效教师加入的班级。发布动作再次由服务端校验包所有者和班级教师关系。

## 9. 已实施文件边界

以下只列新 Next 实现和显式 cutover 文件。旧 `web/api/content/agent-runtime` 源码不在本轮
改动范围内。

### 9.1 Pi 线程身份

- `src/apps/web-next/db/migrations/0003_pi_threads_user_owner.sql` 删除复制的
  `student_id`，线程读取只认 owner 或显式 ACL，删除只认 owner。
- `0004_pi_card_events_actor.sql` 使用统一 `actor_user_id`；`0005_pi_attachments.sql` 建立
  `pi_attachments`，保存 `storage_object_id`、工作副本路径与哈希。
- `pi-thread-store.ts` 与 `pi-chat-routes.ts` 使用 `ownerUserId`，不再接受
  `accessibleStudentIds`，教师角色也不是租户级线程管理员。
- `api-next` 只把当前登录主体转成受信网关头，不再计算学生线程范围。

### 9.2 身份和班级

- `db/migrations/0031_content_pipeline_cutover.sql` 一次建立 `identity_user_role` 和
  `identity_class_user`，角色只允许 `teacher/student`，并用部分唯一索引保证每租户唯一
  teacher。无法追溯的班级创建者使用该唯一 teacher。
- `api-next/src/auth.ts` 从规范化角色关系生成 principal；`api-next/src/index.ts` 实现教师
  班级列表/创建及学生按邀请码加入，授权查询只使用 Next 班级关系。
- 旧身份列仅供旧服务在显式切换前存活，不是 Next 的读写兼容接口；物理删除集中在
  `db/cutover/0037_remove_legacy_content_pipeline.sql`。

### 9.3 规范化内容、复核和发布

- `0031_content_pipeline_cutover.sql` 一次建立对象登记、独立来源、不可变 K/T/Q/E/R
  修订、结构关系、字段溯源、候选复核、ER 命令、固定版本包、班级发布和统一可见性函数。
- `db/migration-data/official-content-manifest.csv` 固定 home 五份已提取 CSV 的文件哈希、
  行数和类型；`content-next/src/cli/migrate-official-content.ts` 只读取该清单与 CSV，不读取
  旧内容表。
- `content-next/src/candidate-repository.ts` 实现候选登记、字段批注、批准/返回修改、包生成、
  发布/撤下和内容库查询；`content-next/src/index.ts` 暴露受信内部接口并轮询复核反馈与
  `content_er_start_command` 两类待投递命令。
- `db/cutover/0000_cleanup_partial_content_migrations.sql` 只清理确认无数据的错误增量对象；
  `0037_remove_legacy_content_pipeline.sql` 在显式维护窗口校验后移除旧入口表。

### 9.4 Storage 服务与 MinIO

- `src/services/storage-next/` 登记对象、服务端复核大小/MIME/SHA-256/版本，并签发 5 分钟
  预签名 PUT/GET；MinIO 管理凭据只进入该服务。
- `deploy/dev/compose.yaml` 与 storage bootstrap 配置三个私有 bucket、版本和 CORS；
  `MINIO_PUBLIC_ENDPOINT` 与 `MINIO_CORS_ALLOWED_ORIGINS` 分离浏览器地址和内部地址。
- `web-next/src/AttachmentAdapter.tsx` 走“初始化 → 浏览器直传 → 完成校验 → Pi 登记”；
  `pi-chat-routes.ts` 只用稳定 `object_id` 为模型回合物化私有只读副本，浏览器下载获取
  预签名地址。

### 9.5 KTQ/ER Skill 与 Pi 插件

- `pi-chat-runtime/skills/` 包含 KTQ、ER、OCR routing 和内容库 Skill，以及固定模板和校验
  脚本。
- `extensions/content-library.ts` 注册受限内容检索工具；`extensions/respond.ts` 验证结果、
  回执和哈希后，通过 runtime 内部预签名 PUT 固定两份 MinIO 审计对象，再携带对象 ID 登记
  候选；content 服务复核对象 owner、状态、版本和结果哈希。`pi-chat-routes.ts` 幂等处理复核
  反馈与 ER 启动命令。
- `src/capabilities/` 通过 `pi-mcp-adapter` 注册 Core、Search、OCR 及 OCR checkpoint；
  `pi-chat-server.ts` 将它和其他扩展一并放入 Pi 的 `agentDir/extensions`，使用的是同一套
  Pi 插件发现机制，不是另一种插件系统。
- `bin/qwen-mm-core-mcp.sh`、`qwen-mm-search-mcp.sh`、`paddleocr-mcp.sh` 和固定 revision
  提供隔离启动边界；Docker 镜像包含固定能力依赖和文档/PDF/媒体工具。

### 9.6 API 与前端

- `api-next/src/index.ts` 提供同源的 `/api/content/*` 与 `/api/storage/*` 受信中继，浏览器
  不接触内部密钥。
- `web-next/src/app.tsx` 分派对话、`/content/review/:candidateSetId` 和
  `/content/packages/:packageId`；两个页面及 `lib/content-api.ts` 完成字段批注、撤回、批准、
  返回修改、包查看和班级发布/撤下。
- `components/assistant-ui/content-review-card.tsx` 由现有 `learning-toolkit.tsx` 注册
  `respond` 类型化卡片；`AttachmentAdapter.tsx` 使用稳定对象引用和浏览器直传。

## 10. 验收条件

### 10.1 权限

- 唯一教师的未发布内容对学生不可见。
- 唯一教师发布到班级后，该班学生可见；非成员不可见。
- 学生无班级时可见官方库。
- 学生所在班级全部关闭官方库时不可见官方库；任一班级开启时可见。
- 模型改变工具查询参数不能越过服务端作用域。
- 线程查询完全不依赖学生身份字段、教师—学生静态绑定或 teacher 全租户旁路；只认 owner
  或显式 ACL，删除只认 owner。

### 10.2 KTQ/ER

- 只有用户明确请求时模型才读取并启动 KTQ Skill。
- KTQ 和 ER 都使用普通 `pi_thread`，数据库不存在两会话父子关系或特殊会话类型。
- `respond` 校验失败不产生候选集和复核卡片。
- 任一有效批注存在时不能批准当前候选集。
- 返回修改生成新候选集，不覆盖旧修订和旧批注。
- KTQ 批准后自动创建新普通 ER 会话并注入批准结果引用。
- ER 批准后只生成教师所有的 `ready` 包，未选择班级前学生不可见。

### 10.3 文件

- 浏览器上传/下载的数据字节不经过 API 服务代理。
- 下载不触发 Pi session/workspace 恢复。
- 数据库不保存预签名 URL。
- 对象版本或 SHA-256 不匹配时 `respond` 被拒绝。
- 被撤下或失去权限的内容不能通过旧预签名地址长期访问；地址在短时效后失效。
- 溯源可以从具体字段定位到来源片段及精确 MinIO 对象版本。

### 10.4 数据结构

- K/T/Q/E/R 核心业务字段、关系、批注、包项和发布关系均可用普通列与外键查询。
- 发布包固定实体修订，不随实体后续修改漂移。
- 正式切换后不存在旧内容管线入口、双写任务或旧 payload 读取路径。

## 11. 推荐实施顺序

1. 统一用户/班级关系与 Pi 线程所有者语义。
2. 建立 storage 服务、对象登记和直传直下，先替换附件链路。
3. 建立规范化内容、候选复核和发布包 Schema。
4. 实现 content 服务的统一可见性和两个模型查询工具。
5. 迁移 KTQ Skill、OCR/Core/Search、`respond` 宿主处理。
6. 实现 assistant-ui 复核卡片和复核页面。
7. 接入 KTQ 修改闭环、自动新建普通 ER 会话、ER 修改闭环和包生成。
8. 执行一次性旧数据转换与对账；通过验收后切换入口并删除旧管线。

实施阶段已按用户后续授权完成；生产数据库的手工清理脚本仍需在维护窗口显式确认后执行。

## 12. 2026-08-31 最终实施决策（覆盖前文未决项）

- 产品角色只有 `teacher` 与 `student`。退役的管理员、审核、家长和运维标签不进入 Next
  事实源，也不会自动获得 teacher 权限；当前部署每租户只有一个 teacher，该用户同时作为
  无法追溯的历史教师 owner 的确定性默认 owner。
- 不兼容旧内容表和旧 payload 入口。此前误做的六个 `0031`～`0036` 纯增量迁移已废弃，
  自动迁移只保留一个 `0031_content_pipeline_cutover.sql`；已误执行的空对象使用
  `db/cutover/0000_cleanup_partial_content_migrations.sql` 显式清理，有数据则拒绝删除。
- 官方初始库只取 home 已提取的五份 CSV：K=27、T=20、E=22、R=21、Q=84，共 174 项。
  `student_cases.*` 不是官方内容。清单、行数与 SHA-256 位于
  `db/migration-data/official-content-manifest.csv`，导入器只读这些文件，不读取旧内容表。
- 官方实体 `origin=official` 且没有教师 owner；无法追溯的教师归属使用唯一 teacher。官方 CSV
  在独立 `content_source` 中只把该 teacher 记作审计上传人，Next 所有权仍为空；旧
  `content_source_document/fragment/question_asset/field_lineage` 没有被扩列或读取。
- “数据库 outbox/polling”在本实现中是：返回修改的事务把复核决定留作反馈 outbox；批准
  KTQ 的事务写入 `content_er_start_command`。`content-next` 每 5 秒查询这两类待处理记录，
  分别调用 Pi 原会话或创建普通 ER 会话；失败保留记录并指数退避重试。它不是新数据库，
  也不是外部消息队列。
- 浏览器 MinIO 使用 `MINIO_PUBLIC_ENDPOINT`，CORS 使用
  `MINIO_CORS_ALLOWED_ORIGINS`。本地默认分别为 `http://localhost:9000` 与
  `http://localhost:8080`；当前生产值为 `https://mathpilot.tangentpi.com`（按实际 Web origin
  配置 CORS）。内部服务继续使用 Compose 内网 `MINIO_ENDPOINT=http://minio:9000`。
- 浏览器对普通文件执行预签名 PUT/GET，文件字节不经 API；API 只验证登录、签发请求和对象
  元数据。复核卡、`/content/review/:id`、`/content/packages/:id`、批注/撤回、批准/返回修改和
  班级发布/撤下均已接到同一套 `content-next` API。
