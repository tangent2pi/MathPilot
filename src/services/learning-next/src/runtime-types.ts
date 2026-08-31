export const TASK_TYPES = [
  "grade",
  "diagnose",
  "teach_summary",
  "select_question",
  "light",
  "rem",
  "deep",
  "foreground_teaching",
  "semantic_decomposition",
] as const;

export type TaskType = (typeof TASK_TYPES)[number];
export type CapabilityTool = "question_catalog" | "read" | "grep" | "learning_action" | "delegate";

export interface TaskSpec {
  schema_version: 3;
  task_type: TaskType;
  spec_version: `v${number}` | `v${number}.${number}` | `v${number}.${number}.${number}`;
  purpose: string;
  input_schema: string;
  output_schema: string;
  skill_ref: `skill:${string}@v${string}`;
  allowed_capability_tools: readonly CapabilityTool[];
  allowed_child_task_types: readonly TaskType[];
  model_policy: {
    policy_id: string;
    model_family: "reasoning" | "fast" | "vision";
    allow_fallback: boolean;
  };
  timeout_policy: {
    start_to_close_seconds: number;
    heartbeat_seconds: number;
  };
  retry_policy: {
    maximum_attempts: number;
    initial_interval_seconds: number;
    backoff_coefficient: number;
    maximum_interval_seconds: number;
  };
  data_access_policy: {
    policy_id: string;
    read_scopes: readonly string[];
    write_scopes: readonly string[];
    history_is_untrusted_data: true;
  };
  workspace_projection_policy: {
    policy_id: string;
    enabled: boolean;
    read_only: true;
    include_authorized_sessions: boolean;
    freshness_required: boolean;
  };
}

export const OUTBOX_EVENT_TYPES = [
  "question.cut_requested",
  "selection.intent_revised",
  "question.closed",
  "dream.rem_requested",
  "dream.deep_requested",
  "teacher.correction_recorded",
] as const;

export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];

export interface OutboxWorkflowStart {
  schemaVersion: 3;
  eventId: string;
  tenantId: string;
  operationId: string;
  eventType: OutboxEventType;
  aggregateRef: string;
  aggregateVersion: number;
  payloadRef: string;
  occurredAt: string;
}

export interface TaskRevision {
  revision: number;
  inputRef: string;
  reason: string;
}

export interface AgentTaskWorkflowInput {
  schemaVersion: 3;
  tenantId: string;
  operationId: string;
  eventId?: string;
  aggregateRef: string;
  aggregateVersion: number;
  taskType: TaskType;
  taskSpecVersion: string;
  inputRef: string;
  idempotencyKey: string;
  revision: number;
  carriedAttempts?: number;
  continueAsNewAfter?: number;
  resultOwnership?: "workflow" | "parent";
}

export interface AgentTaskWorkflowResult {
  operationId: string;
  taskType: TaskType;
  status: "succeeded";
  outputRef: string;
  aggregateRef: string;
  aggregateVersion: number;
  revision: number;
}

export interface AgentTaskWorkflowState {
  status: "running" | "revising" | "succeeded" | "failed" | "cancelled";
  taskType: TaskType;
  revision: number;
  inputRef: string;
  attemptsCompleted: number;
}

export interface AllowedChildWorkflowInput {
  parentTaskType: TaskType;
  children: readonly AgentTaskWorkflowInput[];
}

export interface ScheduledDreamTickInput {
  tenantId: string;
  phase: "rem" | "deep";
}

export interface PiTaskActivityInput extends AgentTaskWorkflowInput {
  workflowId: string;
}

export interface PiTaskActivityResult {
  outputRef: string;
  resolvedModelId: string;
  inputTokens: number;
  outputTokens: number;
}

export interface CommitOperationResultInput {
  tenantId: string;
  operationId: string;
  idempotencyKey: string;
  aggregateRef: string;
  aggregateVersion: number;
  outputRef: string;
}

export interface PersistedOperationResult {
  resultStatus: "committed" | "already_committed";
  outputRef: string;
}

export interface FinalizeQuestionWorkflowInput {
  schemaVersion: 3;
  tenantId: string;
  operationId: string;
  eventId: string;
  cutRequestId?: string;
  questionSessionId: string;
  aggregateVersion: number;
  inputRef: string;
}

export interface PreparedQuestionFinalization {
  tenantId: string;
  operationId: string;
  cutRequestId: string;
  questionSessionId: string;
  gradeTasks: ReadonlyArray<{
    attemptId: string;
    judgmentId: string;
    workflowInput: AgentTaskWorkflowInput;
  }>;
}

export interface RecordFinalJudgmentInput {
  tenantId: string;
  cutRequestId: string;
  questionSessionId: string;
  attemptId: string;
  judgmentId: string;
  outputRef: string;
}

export interface RecordUnresolvedJudgmentInput {
  tenantId: string;
  cutRequestId: string;
  questionSessionId: string;
  attemptId: string;
  judgmentId: string;
  reason: string;
}

export interface CommitQuestionClosureInput {
  tenantId: string;
  operationId: string;
  eventId: string;
  cutRequestId: string;
  questionSessionId: string;
}

export interface QuestionClosureResult {
  questionClosureId: string;
  questionSessionId: string;
  status: "closed" | "abandoned";
  sessionVersion: number;
  judgmentRefs: readonly string[];
  observationRefs: readonly string[];
}

export interface ScientificReplayWorkflowInput {
  schemaVersion: 3;
  tenantId: string;
  operationId: string;
  eventId: string;
  studentId: string;
  teacherCorrectionId: string;
  aggregateVersion: number;
  inputRef: string;
}

export interface ScientificReplayResult {
  teacherCorrectionId: string;
  questionSessionId: string;
  masteryProjectionRefs: readonly string[];
  retentionProjectionRefs: readonly string[];
}

export interface PiExecutorRequest {
  agentAttemptId: string;
  tenantId: string;
  operationId: string;
  workflowId: string;
  inputRef: string;
  inputBundle: unknown;
  taskSpec: TaskSpec;
  signal: AbortSignal;
  heartbeat: (detail?: unknown) => void;
}

export interface PiExecutorResult {
  output: unknown;
  resolvedModelId: string;
  inputTokens: number;
  outputTokens: number;
}

export interface PiTaskExecutor {
  execute(request: PiExecutorRequest): Promise<PiExecutorResult>;
}

export interface LearningNextActivities {
  executePiTask(input: PiTaskActivityInput): Promise<PiTaskActivityResult>;
  commitOperationResult(input: CommitOperationResultInput): Promise<PersistedOperationResult>;
  markOperationFailed(input: { tenantId: string; operationId: string; cancelled: boolean; message: string }): Promise<void>;
  enqueueScheduledDream(input: { tenantId: string; phase: "rem" | "deep"; scheduledAt: string }): Promise<OutboxWorkflowStart>;
  prepareQuestionFinalization(input: FinalizeQuestionWorkflowInput): Promise<PreparedQuestionFinalization>;
  recordFinalJudgment(input: RecordFinalJudgmentInput): Promise<void>;
  recordUnresolvedJudgment(input: RecordUnresolvedJudgmentInput): Promise<void>;
  commitQuestionClosure(input: CommitQuestionClosureInput): Promise<QuestionClosureResult>;
  replayScientificCorrection(input: ScientificReplayWorkflowInput): Promise<ScientificReplayResult>;
}
