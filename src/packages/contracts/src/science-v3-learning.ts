export type LearningViewKind =
  | "thread_list" | "thread_messages" | "thread_context" | "question_interaction"
  | "judgment" | "question_closure" | "learning_overview" | "learning_history"
  | "scientific_state" | "error_pattern_list" | "memory_ledger" | "annotation_detail"
  | "review_queue" | "evidence_bundle" | "learning_activity" | "agent_context_manifest"
  | "operation";

export type LearningAction =
  | "create_thread" | "send_message" | "rename_thread" | "archive_thread"
  | "submit_attempt" | "request_cut" | "revise_selection_intent" | "start_review"
  | "annotation_feedback" | "set_context_preference" | "cancel_operation"
  | "teacher_supersede_fact";

export interface CommandCapability {
  action: LearningAction;
  href: string;
  method: "POST";
  expected_version: number;
  expires_at?: string;
  disabled_reason?: string;
}

export interface LearningView<T extends object = Record<string, unknown>> {
  schema: `mathpilot.learning-view/${string}/v${number}`;
  view_kind: LearningViewKind;
  resource: { kind: string; id: string; version: number };
  generated_at: string;
  facts_through: string;
  projection_status: "ready" | "updating" | "rebuilding" | "unavailable";
  freshness_note?: string;
  permissions: string[];
  redactions?: string[];
  data: T;
  command_capabilities: CommandCapability[];
}

export interface DomainUIPart {
  schema: "mathpilot.message-part/domain-ui/v1";
  part_id: string;
  view_kind: "question" | "answer_receipt" | "judgment" | "probe" | "question_closure"
    | "learning_update" | "memory_update" | "review_due" | "activity_milestone";
  resource_ref: string;
  resource_version: number;
  snapshot: {
    schema: `mathpilot.view/${string}/v${number}`;
    title: string;
    summary: string;
    data: Record<string, unknown>;
    redactions?: string[];
  };
  action_slots: string[];
  occurred_at: string;
  origin: "domain_projector";
  domain_event_ref: string;
}

export type CanonicalMessagePart =
  | { type: "text"; text: string }
  | { type: "attachment"; attachment_ref: string; name: string; mime_type: string }
  | { type: "domain_ui"; part: DomainUIPart }
  | { type: "teaching_artifact"; artifact_ref: string; artifact_schema: string; summary: string };

export interface CanonicalMessage {
  schema_version: 3;
  message_id: string;
  conversation_thread_id: string;
  sequence: number;
  author_kind: "student" | "assistant" | "system";
  lifecycle: "streaming" | "committed" | "failed" | "superseded";
  parts: CanonicalMessagePart[];
  reply_to_message_id?: string;
  question_session_id?: string;
  editable: boolean;
  lock_reason?: string;
  created_at: string;
  version: number;
  action_capabilities: CommandCapability[];
}

export interface LearningClientEvent {
  event_id: string;
  cursor: string;
  event_type: "canonical_message.appended" | "canonical_message.updated"
    | "learning_resource.changed" | "learning_operation.changed";
  resource_key: string;
  resource_version: number;
  occurred_at: string;
}
