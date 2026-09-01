import { responseJson } from "./http-problem";

export async function contentApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/content${path}`, {
    credentials: "include",
    ...init,
    headers: init?.body
      ? { "content-type": "application/json", ...init.headers }
      : init?.headers,
  });
  return responseJson<T>(response);
}

export type CandidateItem = {
  item_order: number;
  entity_id: string;
  entity_kind: "knowledge" | "question_type" | "question" | "error_cause" | "diagnosis_rule";
  revision_id: string;
  revision_no: number;
  lifecycle_status: string;
  knowledge_name?: string | null;
  knowledge_description?: string | null;
  knowledge_grade_band?: string | null;
  knowledge_difficulty?: number | null;
  knowledge_mastery_standard?: string | null;
  knowledge_remediation_advice?: string | null;
  question_type_name?: string | null;
  question_type_description?: string | null;
  question_type_identifying_features?: string | null;
  question_type_standard_method?: string | null;
  chapter_id?: string | null;
  stem_format?: string | null;
  stem_markdown?: string | null;
  question_difficulty?: number | null;
  question_type_revision_id?: string | null;
  analysis_markdown?: string | null;
  error_category?: string | null;
  error_name?: string | null;
  error_description?: string | null;
  error_manifestation?: string | null;
  error_judgment_basis?: string | null;
  error_remediation?: string | null;
  rule_version?: string | null;
  trigger_text?: string | null;
  probe_text?: string | null;
};

export type ReviewAnnotation = {
  annotation_id: string;
  revision_id: string;
  revision_item_id?: string | null;
  field_name?: string | null;
  comment_text: string;
  state: "draft" | "submitted" | "withdrawn";
  created_at: string;
};

export type CandidateDetail = {
  candidate: {
    candidate_set_id: string;
    phase: "ktq" | "er";
    thread_id: string;
    sequence_no: number;
    status: "pending_review" | "changes_requested" | "approved" | "superseded";
    item_count: number;
    created_at: string;
  };
  items: CandidateItem[];
  annotations: ReviewAnnotation[];
  provenance: Array<{
    provenance_id: string;
    revision_id: string;
    revision_item_id?: string | null;
    field_name: string;
    source_locator?: string | null;
    source_object_id?: string | null;
    source_version_id?: string | null;
    source_sha256?: string | null;
    derivation_type: string;
    provenance_status: string;
    review_decision: string;
    created_at: string;
  }>;
  decision: {
    decision: "changes_requested" | "approved";
    decided_at: string;
    feedback_attempt_count?: number;
    feedback_last_error?: string | null;
    feedback_dispatched_at?: string | null;
  } | null;
  er_start_command?: {
    target_thread_id: string;
    status: "pending" | "dispatched";
    attempt_count: number;
    last_error?: string | null;
    dispatched_at?: string | null;
  } | null;
};

export type ContentPackageDetail = {
  package: {
    package_id: string;
    origin: "official" | "teacher";
    owner_teacher_user_id?: string | null;
    title: string;
    version_no: number;
    status: "ready" | "published" | "withdrawn";
    created_at: string;
  };
  items: Array<{
    item_order: number;
    entity_id: string;
    entity_kind: CandidateItem["entity_kind"];
    revision_id: string;
    revision_no: number;
  }>;
  releases: Array<{
    release_id: string;
    class_id: string;
    published_at: string;
    withdrawn_at?: string | null;
  }>;
};
