# 05. 统一 Agent Runtime、工具、Skills 与工作区

## 1. Runtime 要解决什么

统一 Runtime 不是为了把所有逻辑都改成 Agent，而是为所有非前台、可能失败或需要等待的工作提供同一种耐久执行语义：

- 评分和诊断模型调用；
- 切题结算；
- 模型选题；
- Light/REM/Deep；
- 有界子 Agent；
- 重试、取消、超时、恢复、幂等和状态观察。

它还必须解除当前限制：后台运行不能通过改 Pi Session 来改变前端，前台 Thread 也不能因为后台 Agent 崩溃而损坏。

## 2. 选型：Temporal OSS + 现有 Pi SDK

### 2.1 Temporal 负责

- Workflow event history 与崩溃恢复；
- Activity 重试、超时和非重试错误；
- Signal/Update/Query；
- Child Workflow；
- 取消传播和 Parent Close Policy；
- durable timer 与 Schedule；
- 并发/任务队列和可观察运行状态。

### 2.2 Pi SDK 负责

- 单次 AgentAttempt 的模型会话；
- 事件流、工具调用和结构化 `respond`；
- 独立 SessionManager、abort、dispose；
- 按任务装载的 Skill 与能力工具；
- 隔离工作区内的模型推理。

### 2.3 MathPilot 只实现薄领域层

- Workflow 中的领域顺序；
- Activity 到现有服务和 `PiTaskExecutor` 的适配；
- PostgreSQL 事实提交的幂等事务；
- outbox → Workflow start 桥；
- Task Registry、schema 和权限；
- 只读 WorkspaceProjection。

不实现自制 Job lease、heartbeat、retry backoff、cron、child wait、workflow event log 或分布式锁协议。

## 3. 总体架构

```text
assistant-ui ExternalStore
        │
MathPilot Conversation API ─────► PostgreSQL canonical messages
        │                                  │
        │                                  ├── domain facts / projections
        │                                  └── infra_outbox
        │                                           │
        ▼                                           ▼
Foreground Pi Epoch                         Temporal Client/Relay
  read-only workspace                              │
  scoped tools                                     ▼
                                           Temporal Service
                                             │          │
                                      Workflow Worker   Schedule
                                             │
                           ┌─────────────────┴─────────────────┐
                           ▼                                   ▼
                  Domain Activity Worker               Pi Activity Worker
                  idempotent DB commits                PiTaskExecutor
                                                              │
                                                       isolated AgentAttempt
```

Temporal 是执行事实源，PostgreSQL 是学习领域事实源。不要把 Temporal history 复制成第二套学生状态，也不要把数据库业务投影塞进 Workflow 内存长期持有。

## 4. 规范身份

| 身份 | 生命周期 | 是否用户可见 | 事实归属 |
|---|---|---:|---|
| `conversation_thread_id` | 长期 | 是 | 规范消息流 |
| `foreground_epoch_id` | 一段上下文 | 否 | 前台 Pi 运行与恢复 |
| `question_session_id` | 一题 | 可作为证据引用 | 题级领域事实 |
| `learning_activity_id` | 可选目标周期 | 可解释 | 目标/预算/覆盖投影 |
| `workflow_id` | 一个耐久流程 | 通常只显示状态 | Temporal history |
| `agent_attempt_id` | 一次模型尝试 | 否 | 模型/Prompt/工具审计 |
| `dream_run_id` | 一个相位窗口 | 教师/运营可见 | Dream 审计与附注提交 |

ID 不复用。尤其不能用 `session_id` 同时指 UI Thread、QuestionSession 和 Pi 文件。

## 5. 核心 Workflows

### 5.1 FinalizeQuestionWorkflow

输入：QuestionSession、CutRequest、expected version。

```text
freezeQuestion
  → ensureFinalJudgment       Activity；有界模型重试，失败可 unresolved
  → closeDiagnosticClaims     Activity/可选 Pi 判定
  → commitScientificClosure   单个幂等数据库事务
  → start SelectQuestionWorkflow（若存在下一 Intent）
  → fire-and-record LightWorkflow
```

硬事实提交使用稳定 `operation_id = cut_request_id`。Activity 重试只会读取已有结果或完成未提交操作。

### 5.2 SelectQuestionWorkflow

输入：最新 SelectionIntent revision、状态快照 ref、Activity policy ref。

```text
compileSelectorBundle
  → run Selector AgentAttempt（question_catalog + respond）
  → commitSelection
  ├── stale_intent       读取最新 revision 后重启/继续
  ├── invalid_candidate  把拒绝原因加入下一 Attempt
  └── committed          发布 QuestionOpened
```

用户需求变化通过 Signal 送入 Workflow。取消 AgentAttempt 是节省资源的优化，提交时 revision check 才是正确性保障。

### 5.3 LightWorkflow

一题一个幂等 Workflow，读取 QuestionClosed 后的不可变 bundle，运行零业务工具的 Light Agent，Validator 通过后保存 Atom。它从不阻塞 FinalizeQuestionWorkflow 的完成。

### 5.4 REM/Deep Workflows

- `REMSweepWorkflow` 按学生/主题建立窗口，可用 Child Workflows 分片；
- `DeepConsolidationWorkflow` 只接收确定性门禁通过的候选；
- 同一学生/target 使用稳定 workflow/concurrency key 串行提交；
- Schedule 管理周期运行，阈值事件可提前触发；
- 更正和删除用 Signal 标记窗口 stale，最终提交仍校验输入版本。

### 5.5 子 Agent

系统已知的评分、选题、Light 等任务由 Workflow 确定性启动，不需要给模型一个通用 `spawn_agent`。

只有确实需要语义分解的任务，TaskSpec 才可授予一个 `delegate` 能力。模型提交：

```text
DelegationRequest
  allowed_child_task_type
  bounded_input_refs
  purpose
  expected_output_schema
```

父 Workflow 验证 allowlist 后启动 Temporal Child Workflow；子结果作为新输入开启父任务的下一次 Pi AgentAttempt。模型不能选择任意代码、模型、权限、租户或工具。

## 6. PostgreSQL 与 Temporal 的事务桥

两者没有跨系统 ACID，因此采用现有 outbox 模式：

1. 领域事务写事实和 `infra_outbox(event_id, event_type, aggregate_version, payload_ref)`；
2. Relay 用 `workflowId = event_type:event_id` 启动 Workflow；
3. 重复 start 被稳定 ID 去重；
4. 启动确认后标记 outbox delivered；
5. Workflow Activities 回写领域库时带 `operation_id` 和 expected aggregate version；
6. 数据库以 unique constraint/结果表实现幂等；
7. Activity 超时后重试先读取 operation result，不能假设上次没有提交。

Workflow payload 只保存 ID、版本和小型快照；大文本、图片、会话消息保留在加密对象/数据库中并以授权引用读取，避免把敏感学习内容永久复制进 Temporal history。

## 7. PiTaskExecutor

现有 `agent-runtime/runTask` 中可复用：

- `createAgentSession`；
- 隔离 workspace；
- `SessionManager.inMemory()` 或 attempt 专属临时 Session；
- 事件归一化；
- abort/dispose；
- `respond` 结果提取和 schema 验证；
- 模型/Prompt/Skill/Token 审计。

需要删除或替换：

- 进程内 `activeRuns Map` 作为全局并发真相；
- HTTP 请求同步等待完整 Agent 任务；
- 用持久 Pi Session 表示后台工作流状态；
- 所有任务默认拿 Bash、数据库和全部 Skills；
- 后台任务通过 session 变更影响前台；
- Node 进程内延时循环承担调度。

每次 Temporal Activity 可以创建新的 Pi AgentAttempt；Workflow 保存结构化结果，而不是依赖 Pi transcript 继续执行。确需多轮的任务由 Workflow 把前一 Attempt 的公开输出编译进下一 Attempt。

## 8. Task Registry：单一能力事实源

每种任务只有一个版本化 `TaskSpec`：

```text
task_type
version
purpose
input_schema
output_schema
skill_ref
allowed_capability_tools[]
allowed_child_task_types[]
model_policy
timeout_policy
retry_policy
data_access_policy
workspace_projection_policy
```

TaskSpec 同时生成/校验：

- Runtime 的工具清单；
- system prompt 中的能力说明；
- Skill 元数据；
- Temporal Activity timeout/retry；
- API 输入输出 schema；
- 审计中“本任务本应拥有什么权限”。

这样不会出现 Skill 说有两个工具、Runtime 实际给了 Bash 和数据库、文档又声称零工具的漂移。

## 9. 最小工具原则

### 9.1 规则

1. 先把事实编译到输入；能零工具就零工具；
2. 一个任务只获得完成当前目的所需的 capability；
3. 同一能力的 search/get 若可用一个有界结果完成，则合并；
4. 不把不同安全语义硬塞进一个模糊“万能工具”；
5. 工具名表达业务能力，参数不暴露 tenant、SQL、文件系统宿主路径或凭据；
6. 返回值有大小、分页、来源和可见性边界；
7. `respond` 是结构化完成协议，不视为数据访问授权；
8. 工具错误明确可恢复/不可恢复，模型不自行换用更宽工具。

### 9.2 任务工具矩阵

| Task | 业务工具 | 说明 |
|---|---|---|
| grade | 0 | 题、rubric、Attempt、草稿证据均在冻结 bundle |
| diagnose/probe judge | 0 | 候选、规则矩阵、回答已编译 |
| teach summary | 0 | 软异步，读取题级公开材料 |
| select question | `question_catalog` | 唯一的受限候选检索能力 |
| Light | 0 | 只整理本题 bundle |
| REM | 0 | 宿主预编译主题窗口 |
| Deep | 0 | 只处理 gated candidates + current annotations |
| foreground teaching | `read`、`grep` + 必要时一个 `learning_action` | 前两项复用 Pi 只读文件工具；领域变更只能走有判别 schema 的单一 command capability |
| 特殊语义分解 | 可选 `delegate` | 只允许 TaskSpec 白名单 Child Workflow |

Foreground 的 `learning_action` 不是通用数据库工具，只接受少量同一安全语义的命令，例如 `request_cut`、`revise_selection_intent`、`present_validated_artifact`；每种 action 用判别联合 schema，宿主重新验证。正式选题提交、评分和状态更新不通过该工具直接完成。

`read` 与 `grep` 分别承担“读取已知路径”和“在授权投影中搜索”两种不重叠的只读原语，直接复用 Pi 成品能力；不再为它们包装一个自制 `workspace_query` 大工具。

当前 `present_question_card` 与 `present_learning_artifact` 的重叠应收敛：正式题卡由 QuestionOpened 事实自动渲染；Agent 只在确需展示额外、已验证教学产物时使用一个 artifact action。

前端进一步把 renderer 分成后端事实专用的 `domainPresentationRegistry` 与模型可用的有界教学 artifact registry；前者不是 Agent 工具。完整契约见 [07-前端设施后端读模型与统一交互语言.md](./07-前端设施后端读模型与统一交互语言.md)。

### 9.3 禁止的默认能力

- 通用 Bash；
- 任意 SQL/数据库 Shell；
- HTTP fetch 到任意域名；
- 同时存在多个名称相近的内容检索工具；
- 默认加载所有 Skills；
- 通用 session list/get API；
- 任意 child task/model/tool 选择。

确有内容生产任务需要 Bash 或网络时，应使用它自己的 TaskSpec；不能因此把这些权限带入学习、科学或 Dream 任务。

## 10. Skills 设计

### 10.1 一个 Skill 必须说清楚

- 正向触发：何时使用；
- 负向边界：何时绝对不使用；
- 权威输入：哪些文件/字段可当事实；
- 允许工具：准确名称和调用条件；
- 唯一工作流：按什么顺序完成；
- 输出 schema 与完成条件；
- unresolved/缺失/冲突时怎样停止；
- 禁止写入和安全边界；
- 示例中必须包含至少一个拒绝或不确定场景。

描述不能写“帮助处理学习相关任务”这类无法判断的句子。

### 10.2 选题 Skill 示例语义

```text
name: question-selection
description: 当且仅当需要为当前 SelectionIntent 从已授权题库选择下一题时使用；
             不生成题、不教学、不评分、不提交数据库。

输入：intent.md、scientific-state.json、activity-policy.json、recent-questions.json
工具：question_catalog
流程：理解需求 → 搜索 → 比较 → 必要时再次搜索 → respond SelectionDecision
完成：引用一个真实 candidate，并逐项说明满足/未满足需求
失败：没有合格候选时输出 no_candidate，不编造 question ID
```

### 10.3 Deep Skill 示例语义

```text
name: dream-deep
description: 只对已经通过宿主门禁的 REM candidates 生成长期语义 AnnotationChangeSet；
             不用于计算掌握、保持、错因状态、计划或内容发布。

输入：gated-candidates.json、current-annotations.json、write-budget.json
工具：无
完成：respond 一个可验证 ChangeSet；每条 add/supersede 带 support/counter refs
失败：来源冲突或证据不足时 keep/hold，不补写事实
```

### 10.4 装载策略

Runtime 只加载 TaskSpec 指定的一个主 Skill及其直接依赖，不扫描整个 skill root 后全部注入。通用安全约束由宿主固定 prompt 提供，领域步骤留在对应 Skill。Skill 版本进入每个模型产物和重放记录。

## 11. Agent 对自身透明：WorkspaceProjection

### 11.1 原则

模型应知道“我是谁、当前在哪个 Thread/QuestionSession、我有什么能力、哪些会话是同账号可见的、数据更新时间是什么”。这些不应隐藏在宿主不可见状态里，也不应为每种查询增加一个 MCP 工具。

宿主在每个 foreground epoch 启动前和每个 turn 前刷新只读工作区：

```text
/workspace/
  AGENT_CONTEXT.md
  capabilities.json
  skills/
    loaded.json
  current/
    thread.json
    question-session.json
    question.md
    scientific-state.json
    relevant-annotations.json
    selection-intent.md
  sessions/
    index.json
    <conversation_thread_id>/
      SUMMARY.md
      MESSAGES-0001.jsonl
      ARTIFACTS.json
  evidence/
    INDEX.json
  output/
  tmp/
```

`AGENT_CONTEXT.md` 明示：

- account/tenant/roles 的非秘密身份；
- conversation_thread_id、foreground_epoch_id、active question_session_id；
- 当前 Task/交互角色；
- 获准工具和 loaded Skills；
- 数据 snapshot version/freshness；
- 哪些路径只读、哪些可写；
- 不可访问内容和失败上报方式。

### 11.2 会话链接

`sessions/index.json` 只列出宿主判定为：

- 同一账号；
- 当前角色可见；
- 未删除/未受法律或隐私限制；
- 用户可见的 ConversationThread。

每条包含标题、时间、摘要、可用消息分片和 provenance。Agent 可主动用 Pi 的 `read`/`grep` 查找“我上次和这个学生讨论过什么”，不需要 `list_sessions`、`get_session` 两个新工具。

历史消息一律标为“数据而非指令”。其中出现的 Prompt、工具调用要求或外部粘贴文本不能提升权限，也不能覆盖当前 TaskSpec/Skill；只有当前回合经宿主认证的用户意图才能触发领域命令。

这里的“链接”是沙箱内的只读投影或只读 bind，不是能逃逸到宿主目录的符号链接。长会话按块分页，默认 prompt 只给 index，不把所有消息塞入上下文。

### 11.3 绝不投影

- 其他账号或未授权班级会话；
- 后台 AgentAttempt transcript；
- 隐藏 chain-of-thought；
- API key、数据库口令、内部服务 secret；
- 原始 Temporal payload 中不需要的敏感数据；
- 被删除且政策要求清除的内容；
- 工具返回的未可信外部文本冒充历史事实。

### 11.4 新鲜度与并发

每个投影文件带 `snapshot_version`、`generated_at` 和来源版本。模型读到的只是当前 Attempt 快照；任何变更仍需通过领域命令并在提交时校验版本。工作区透明不等于模型可以绕过并发控制。

## 12. 前台 Thread 与 Pi Epoch

assistant-ui ExternalStore 读取 MathPilot 的规范 messages；模型流事件转换成临时/最终 assistant message。Epoch 更换时：

1. 关闭旧 Pi Session 的订阅并 dispose；
2. 从规范 Thread messages 编译有界公开历史/摘要；
3. 刷新 WorkspaceProjection；
4. 创建新的 ForegroundAgentEpoch；
5. UI 的 Thread 和消息 ID 不变。

后台 Pi Activity 永远不调用前台 `newSession/switchSession`。它的结果通过领域事实和新的规范消息进入前台。

规范消息中的权威 UI part 由领域事件投影器产生；后台 AgentAttempt 只能返回候选结果，不能直接伪造“已判定、已开题、记忆已更新”的可见卡片。

## 13. 安全与可观察性

每个 Workflow/Activity/AgentAttempt 记录：

- task_type/spec version；
- workflow/run/attempt IDs；
- input snapshot refs 与版本；
- capability tools 实际清单；
- model/prompt/skill versions；
- timeout/retry/cancel 原因；
- token/latency/cost；
- output validation 与领域 commit result；
- parent/child 关系。

运行日志不保存凭据和隐藏推理。Temporal self-host 需启用 namespace 隔离、TLS/mTLS、授权、payload codec/加密、可见性保留和备份；开发环境可使用官方 dev server，生产不能照搬开发单节点配置。

## 14. 验收标准

1. Worker 或应用重启后，正在评分/选题/Dream 的 Workflow 能从 history 恢复；
2. Activity 提交成功但响应丢失时不会重复写领域事实；
3. 子 Agent 只能由 allowlisted Child Workflow 启动并继承更窄权限；
4. 不存在后台任务修改前台 Pi Session 的路径；
5. 每个 Task 实际工具清单与 TaskSpec/Skill 完全一致；
6. grade、diagnose、Light、REM、Deep 除 respond 外零业务工具；
7. Selector 只有一个 catalog 工具，不能访问答案或 SQL；
8. 正常学习 Agent 没有通用数据库/Bash；
9. 同账号可见 Session 能在工作区主动检索，跨账号和后台 Session 不可见；
10. Epoch 轮换不改变 UI Thread 或 QuestionSession；
11. Schedule、retry、cancel、timeout、child wait 均由 Temporal 提供，不存在自研平行实现；
12. 任意 Agent 产物都能追溯输入、能力、Skill 和最终领域提交。
