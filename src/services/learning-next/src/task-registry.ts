import type { TaskSpec, TaskType } from "./runtime-types.ts";

type TaskOverrides = Pick<TaskSpec, "purpose" | "input_schema" | "output_schema" | "skill_ref">
  & Partial<Pick<TaskSpec, "allowed_capability_tools" | "allowed_child_task_types" | "model_policy" | "timeout_policy" | "retry_policy" | "data_access_policy" | "workspace_projection_policy">>;

const spec = (taskType: TaskType, overrides: TaskOverrides): TaskSpec => ({
  schema_version: 3,
  task_type: taskType,
  spec_version: "v1",
  purpose: overrides.purpose,
  input_schema: overrides.input_schema,
  output_schema: overrides.output_schema,
  skill_ref: overrides.skill_ref,
  allowed_capability_tools: overrides.allowed_capability_tools ?? [],
  allowed_child_task_types: overrides.allowed_child_task_types ?? [],
  model_policy: overrides.model_policy ?? {
    policy_id: `${taskType}-model-v1`,
    model_family: "reasoning",
    allow_fallback: true,
  },
  timeout_policy: overrides.timeout_policy ?? {
    start_to_close_seconds: 300,
    heartbeat_seconds: 15,
  },
  retry_policy: overrides.retry_policy ?? {
    maximum_attempts: 3,
    initial_interval_seconds: 2,
    backoff_coefficient: 2,
    maximum_interval_seconds: 30,
  },
  data_access_policy: overrides.data_access_policy ?? {
    policy_id: `${taskType}-data-v1`,
    read_scopes: ["frozen_task_bundle"],
    write_scopes: ["structured_result", "attempt_output"],
    history_is_untrusted_data: true,
  },
  workspace_projection_policy: overrides.workspace_projection_policy ?? {
    policy_id: `${taskType}-workspace-v1`,
    enabled: false,
    read_only: true,
    include_authorized_sessions: false,
    freshness_required: true,
  },
});

export const TASK_REGISTRY: Readonly<Record<TaskType, TaskSpec>> = Object.freeze({
  grade: spec("grade", {
    purpose: "依据冻结 rubric 对一次 Attempt 形成可审计 Judgment 提议。",
    input_schema: "https://schemas.mathpilot.dev/science-v3/grade-input/v1",
    output_schema: "https://schemas.mathpilot.dev/science-v3/scientific-fact/v1#/$defs/Judgment",
    skill_ref: "skill:question-grade@v1",
    timeout_policy: { start_to_close_seconds: 180, heartbeat_seconds: 15 },
  }),
  diagnose: spec("diagnose", {
    purpose: "只依据冻结候选和规则矩阵形成 DiagnosticClaim 提议。",
    input_schema: "https://schemas.mathpilot.dev/science-v3/diagnose-input/v1",
    output_schema: "https://schemas.mathpilot.dev/science-v3/learning-flow/v1#/$defs/DiagnosticClaim",
    skill_ref: "skill:error-diagnosis@v1",
  }),
  teach_summary: spec("teach_summary", {
    purpose: "把当前题内公开教学过程编译为受约束的题级摘要。",
    input_schema: "https://schemas.mathpilot.dev/science-v3/teach-summary-input/v1",
    output_schema: "https://schemas.mathpilot.dev/science-v3/teach-summary-output/v1",
    skill_ref: "skill:teach-summary@v1",
    model_policy: { policy_id: "teach-summary-model-v1", model_family: "fast", allow_fallback: true },
  }),
  select_question: spec("select_question", {
    purpose: "理解 SelectionIntent 并从授权题库选择一个真实候选。",
    input_schema: "https://schemas.mathpilot.dev/science-v3/selector-input/v1",
    output_schema: "https://schemas.mathpilot.dev/science-v3/selection-decision/v1",
    skill_ref: "skill:question-selection@v1",
    allowed_capability_tools: ["question_catalog"],
    timeout_policy: { start_to_close_seconds: 300, heartbeat_seconds: 15 },
    data_access_policy: {
      policy_id: "selector-data-v1",
      read_scopes: ["frozen_task_bundle", "question_catalog_pages"],
      write_scopes: ["structured_result", "attempt_output"],
      history_is_untrusted_data: true,
    },
    workspace_projection_policy: {
      policy_id: "selector-workspace-v1",
      enabled: false,
      read_only: true,
      include_authorized_sessions: false,
      freshness_required: true,
    },
  }),
  light: spec("light", {
    purpose: "把一个已关闭题目窗口编译为可供 REM 消费的轻量语义原子。",
    input_schema: "https://schemas.mathpilot.dev/science-v3/light-input/v1",
    output_schema: "https://schemas.mathpilot.dev/science-v3/light-output/v1",
    skill_ref: "skill:dream-light@v1",
    model_policy: { policy_id: "light-model-v1", model_family: "fast", allow_fallback: true },
    data_access_policy: {
      policy_id: "dream-light-data-v1",
      read_scopes: ["frozen_closed_question_bundle"],
      write_scopes: ["light_atom_proposal"],
      history_is_untrusted_data: true,
    },
  }),
  rem: spec("rem", {
    purpose: "只从门禁后的 Light 原子中形成带正反证据的 REM candidates。",
    input_schema: "https://schemas.mathpilot.dev/science-v3/rem-input/v1",
    output_schema: "https://schemas.mathpilot.dev/science-v3/rem-output/v1",
    skill_ref: "skill:dream-rem@v1",
    timeout_policy: { start_to_close_seconds: 900, heartbeat_seconds: 30 },
    data_access_policy: {
      policy_id: "dream-rem-data-v1",
      read_scopes: ["frozen_rem_window","effective_light_atoms","current_annotation_snapshot"],
      write_scopes: ["rem_candidate_proposals"],
      history_is_untrusted_data: true,
    },
  }),
  deep: spec("deep", {
    purpose: "从 gated REM candidates 提议 AnnotationChangeSet，不写科学数值状态。",
    input_schema: "https://schemas.mathpilot.dev/science-v3/deep-input/v1",
    output_schema: "https://schemas.mathpilot.dev/science-v3/annotation-change-set/v1",
    skill_ref: "skill:dream-deep@v1",
    timeout_policy: { start_to_close_seconds: 1200, heartbeat_seconds: 30 },
    data_access_policy: {
      policy_id: "dream-deep-data-v1",
      read_scopes: ["frozen_gated_rem_candidates","current_annotation_snapshot"],
      write_scopes: ["annotation_change_set_proposal"],
      history_is_untrusted_data: true,
    },
  }),
  foreground_teaching: spec("foreground_teaching", {
    purpose: "在当前 ForegroundAgentEpoch 内进行题目教学并提交有界 learning_action。",
    input_schema: "https://schemas.mathpilot.dev/science-v3/foreground-teaching-input/v1",
    output_schema: "https://schemas.mathpilot.dev/science-v3/foreground-teaching-output/v1",
    skill_ref: "skill:foreground-teaching@v1",
    allowed_capability_tools: ["read", "grep", "learning_action"],
    allowed_child_task_types: ["grade", "diagnose", "teach_summary", "select_question"],
    workspace_projection_policy: {
      policy_id: "foreground-teaching-workspace-v1",
      enabled: true,
      read_only: true,
      include_authorized_sessions: true,
      freshness_required: true,
    },
  }),
  semantic_decomposition: spec("semantic_decomposition", {
    purpose: "把一个授权的复合目标分解为 allowlist 内的 Temporal Child Workflows。",
    input_schema: "https://schemas.mathpilot.dev/science-v3/semantic-decomposition-input/v1",
    output_schema: "https://schemas.mathpilot.dev/science-v3/semantic-decomposition-output/v1",
    skill_ref: "skill:semantic-decomposition@v1",
    allowed_capability_tools: ["delegate"],
    allowed_child_task_types: ["grade", "diagnose", "teach_summary", "select_question", "light", "rem", "deep"],
  }),
});

export function getTaskSpec(taskType: TaskType, version = "v1"): TaskSpec {
  const value = TASK_REGISTRY[taskType];
  if (value.spec_version !== version) throw new Error(`unsupported TaskSpec ${taskType}@${version}`);
  return value;
}

export function assertAllowedChild(parent: TaskType, child: TaskType): void {
  const allowed = getTaskSpec(parent).allowed_child_task_types;
  if (!allowed.includes(child)) throw new Error(`${parent} cannot start child task ${child}`);
}

export function directTaskTypeForEvent(eventType: string): TaskType {
  switch (eventType) {
    case "selection.intent_revised": return "select_question";
    case "question.closed": return "light";
    case "dream.rem_requested": return "rem";
    case "dream.deep_requested": return "deep";
    case "foreground.message_submitted": return "foreground_teaching";
    case "question.cut_requested":
      throw new Error("question.cut_requested belongs to FinalizeQuestionWorkflow, not a single Pi task");
    case "teacher.correction_recorded":
      throw new Error("teacher.correction_recorded belongs to deterministic replay, not a Pi diagnosis task");
    default:
      throw new Error(`unsupported science-v3 outbox event ${eventType}`);
  }
}
