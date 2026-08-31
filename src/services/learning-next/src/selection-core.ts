import { createHash } from "node:crypto";

export const SELECTOR_INPUT_SCHEMA = "https://schemas.mathpilot.dev/science-v3/selector-input/v1";
export const SELECTION_DECISION_SCHEMA = "https://schemas.mathpilot.dev/science-v3/selection-decision/v1";

export type ScientificPurpose = "measure" | "discriminate" | "remediate" | "verify" | "practice";
export type MeasurementEligibility = "formal" | "provisional" | "teaching_only";

export interface SelectionDecisionBase {
  schema_version: 3;
  intent_id: string;
  intent_revision: number;
  unsatisfied_preferences: string[];
  evidence_refs: string[];
  decision_summary: string;
}

export interface SelectedDecision extends SelectionDecisionBase {
  decision_type: "selected";
  chosen_question_revision_id: string;
  satisfied_requirements: string[];
  scientific_purpose: ScientificPurpose;
  target_dimensions: string[];
  target_error_causes: string[];
}

export interface NoCandidateDecision extends SelectionDecisionBase {
  decision_type: "no_candidate";
  search_summary: string;
}

export type SelectionDecision = SelectedDecision | NoCandidateDecision;

export interface QuestionCatalogCandidate {
  question_revision_id: string;
  stem: string;
  dimensions: ReadonlyArray<{
    dimension_revision_id: string;
    name: string;
    target_role: "primary" | "secondary" | "prerequisite";
  }>;
  difficulty: number;
  representation: "single_choice" | "multiple_choice" | "fill_blank" | "true_false" | "open_solution";
  estimated_burden: "low" | "medium" | "high";
  error_roles: ReadonlyArray<{
    error_cause_revision_id: string;
    name: string;
    role: "evokes" | "discriminates" | "remediates" | "verifies_near" | "verifies_far" | "verifies_delayed";
  }>;
  measurement_eligibility: MeasurementEligibility;
  provenance: {
    origin: "official" | "teacher";
    entity_id: string;
    revision_no: number;
  };
}

export interface QuestionCatalogResult {
  candidates: QuestionCatalogCandidate[];
  next_cursor?: string;
  page_ref: string;
}

export interface HardSelectionConstraints {
  learningActivityId?: string;
  chapterId?: string;
  measurementEligibility?: MeasurementEligibility;
  minimumDifficulty?: number;
  maximumDifficulty?: number;
  requiredDimensionRevisionId?: string;
  requiredErrorCauseRevisionId?: string;
  representation?: QuestionCatalogCandidate["representation"];
  allowRecentRevisit: boolean;
}

export class SelectionDecisionValidationError extends Error {
  readonly code = "selection_decision_invalid";
}

const objectValue = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SelectionDecisionValidationError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
};

const exactKeys = (value: Record<string, unknown>, allowed: readonly string[]): void => {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw new SelectionDecisionValidationError(`unexpected SelectionDecision field: ${extras[0]}`);
};

const requiredString = (value: unknown, name: string, maximum: number): string => {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new SelectionDecisionValidationError(`${name} is invalid`);
  }
  return value.trim();
};

const stringList = (value: unknown, name: string, maximumItems: number, minimumItems = 0): string[] => {
  if (!Array.isArray(value) || value.length < minimumItems || value.length > maximumItems) {
    throw new SelectionDecisionValidationError(`${name} is invalid`);
  }
  const result = value.map((item) => requiredString(item, name, 500));
  if (new Set(result).size !== result.length) throw new SelectionDecisionValidationError(`${name} contains duplicates`);
  return result;
};

const idList = (value: unknown, name: string, maximumItems: number, pattern: RegExp): string[] => {
  const result = stringList(value, name, maximumItems);
  if (result.some((item) => !pattern.test(item))) throw new SelectionDecisionValidationError(`${name} contains an invalid ID`);
  return result;
};

const INTENT_ID = /^int_[A-Za-z0-9]{8,}$/;
const QUESTION_REVISION_ID = /^qrev_[A-Za-z0-9_.:-]{4,}$/;
const DIMENSION_REVISION_ID = /^(?:krev|trev)_[A-Za-z0-9_.:-]{4,}$/;
const ERROR_CAUSE_REVISION_ID = /^erev_[A-Za-z0-9_.:-]{4,}$/;
const EVIDENCE_REF = /^[a-z][a-z0-9+.-]*:\/\/\S+$/;
const purposes = new Set<ScientificPurpose>(["measure", "discriminate", "remediate", "verify", "practice"]);

export function parseSelectionDecision(
  value: unknown,
  expected?: { intentId: string; intentRevision: number },
): SelectionDecision {
  const raw = objectValue(value, "SelectionDecision");
  const baseKeys = [
    "schema_version", "decision_type", "intent_id", "intent_revision",
    "unsatisfied_preferences", "evidence_refs", "decision_summary",
  ];
  if (raw.schema_version !== 3) throw new SelectionDecisionValidationError("schema_version must be 3");
  if (raw.decision_type !== "selected" && raw.decision_type !== "no_candidate") {
    throw new SelectionDecisionValidationError("decision_type is invalid");
  }
  const intentId = requiredString(raw.intent_id, "intent_id", 160);
  if (!INTENT_ID.test(intentId)) throw new SelectionDecisionValidationError("intent_id is invalid");
  const intentRevision = raw.intent_revision;
  if (!Number.isSafeInteger(intentRevision) || Number(intentRevision) < 1) {
    throw new SelectionDecisionValidationError("intent_revision is invalid");
  }
  if (expected && (intentId !== expected.intentId || intentRevision !== expected.intentRevision)) {
    throw new SelectionDecisionValidationError("SelectionDecision does not match its frozen intent");
  }
  const unsatisfied = stringList(raw.unsatisfied_preferences, "unsatisfied_preferences", 16);
  const evidenceRefs = stringList(raw.evidence_refs, "evidence_refs", 64, 1);
  if (evidenceRefs.some((ref) => !EVIDENCE_REF.test(ref))) {
    throw new SelectionDecisionValidationError("evidence_refs contains an invalid reference");
  }
  const decisionSummary = requiredString(raw.decision_summary, "decision_summary", 1000);

  if (raw.decision_type === "no_candidate") {
    exactKeys(raw, [...baseKeys, "search_summary"]);
    return {
      schema_version: 3,
      decision_type: "no_candidate",
      intent_id: intentId,
      intent_revision: Number(intentRevision),
      unsatisfied_preferences: unsatisfied,
      evidence_refs: evidenceRefs,
      decision_summary: decisionSummary,
      search_summary: requiredString(raw.search_summary, "search_summary", 2000),
    };
  }

  exactKeys(raw, [
    ...baseKeys, "chosen_question_revision_id", "satisfied_requirements", "scientific_purpose",
    "target_dimensions", "target_error_causes",
  ]);
  const questionRevisionId = requiredString(raw.chosen_question_revision_id, "chosen_question_revision_id", 160);
  if (!QUESTION_REVISION_ID.test(questionRevisionId)) {
    throw new SelectionDecisionValidationError("chosen_question_revision_id is invalid");
  }
  if (typeof raw.scientific_purpose !== "string" || !purposes.has(raw.scientific_purpose as ScientificPurpose)) {
    throw new SelectionDecisionValidationError("scientific_purpose is invalid");
  }
  return {
    schema_version: 3,
    decision_type: "selected",
    intent_id: intentId,
    intent_revision: Number(intentRevision),
    chosen_question_revision_id: questionRevisionId,
    satisfied_requirements: stringList(raw.satisfied_requirements, "satisfied_requirements", 16, 1),
    unsatisfied_preferences: unsatisfied,
    scientific_purpose: raw.scientific_purpose as ScientificPurpose,
    target_dimensions: idList(raw.target_dimensions, "target_dimensions", 32, DIMENSION_REVISION_ID),
    target_error_causes: idList(raw.target_error_causes, "target_error_causes", 32, ERROR_CAUSE_REVISION_ID),
    evidence_refs: evidenceRefs,
    decision_summary: decisionSummary,
  };
}

const allowedConstraintKeys = new Set([
  "learning_activity_id", "chapter_id", "measurement_eligibility", "minimum_difficulty",
  "maximum_difficulty", "required_dimension_revision_id", "required_error_cause_revision_id",
  "representation", "allow_recent_revisit",
]);
const representations = new Set<QuestionCatalogCandidate["representation"]>([
  "single_choice", "multiple_choice", "fill_blank", "true_false", "open_solution",
]);
const eligibility = new Set<MeasurementEligibility>(["formal", "provisional", "teaching_only"]);

const optionalNumber = (value: string | undefined, name: string): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`${name} must be between 0 and 1`);
  return parsed;
};

export function parseHardSelectionConstraints(value: unknown): HardSelectionConstraints {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  for (const [key, item] of Object.entries(raw)) {
    if (!allowedConstraintKeys.has(key)) throw new Error(`unsupported activity constraint ${key}`);
    if (typeof item !== "string" || item.length > 240) throw new Error(`activity constraint ${key} must be a string`);
  }
  const strings = raw as Record<string, string>;
  const minimumDifficulty = optionalNumber(strings.minimum_difficulty, "minimum_difficulty");
  const maximumDifficulty = optionalNumber(strings.maximum_difficulty, "maximum_difficulty");
  if (minimumDifficulty !== undefined && maximumDifficulty !== undefined && minimumDifficulty > maximumDifficulty) {
    throw new Error("minimum_difficulty cannot exceed maximum_difficulty");
  }
  if (strings.measurement_eligibility && !eligibility.has(strings.measurement_eligibility as MeasurementEligibility)) {
    throw new Error("measurement_eligibility is invalid");
  }
  if (strings.representation && !representations.has(strings.representation as QuestionCatalogCandidate["representation"])) {
    throw new Error("representation is invalid");
  }
  if (strings.allow_recent_revisit && strings.allow_recent_revisit !== "true" && strings.allow_recent_revisit !== "false") {
    throw new Error("allow_recent_revisit must be true or false");
  }
  return {
    ...(strings.learning_activity_id ? { learningActivityId: strings.learning_activity_id } : {}),
    ...(strings.chapter_id ? { chapterId: strings.chapter_id } : {}),
    ...(strings.measurement_eligibility ? { measurementEligibility: strings.measurement_eligibility as MeasurementEligibility } : {}),
    ...(minimumDifficulty !== undefined ? { minimumDifficulty } : {}),
    ...(maximumDifficulty !== undefined ? { maximumDifficulty } : {}),
    ...(strings.required_dimension_revision_id ? { requiredDimensionRevisionId: strings.required_dimension_revision_id } : {}),
    ...(strings.required_error_cause_revision_id ? { requiredErrorCauseRevisionId: strings.required_error_cause_revision_id } : {}),
    ...(strings.representation ? { representation: strings.representation as QuestionCatalogCandidate["representation"] } : {}),
    allowRecentRevisit: strings.allow_recent_revisit === "true",
  };
}

const sortJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, sortJson(item)]));
};

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex");
}

interface CatalogCursor {
  version: 1;
  scope: string;
  offset: number;
}

export function encodeCatalogCursor(scope: string, offset: number): string {
  if (!/^[0-9a-f]{64}$/.test(scope) || !Number.isSafeInteger(offset) || offset < 1) throw new Error("invalid catalog cursor state");
  return Buffer.from(JSON.stringify({ version: 1, scope, offset } satisfies CatalogCursor), "utf8").toString("base64url");
}

export function decodeCatalogCursor(value: string | undefined, scope: string): number {
  if (value === undefined) return 0;
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("question_catalog cursor is invalid");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<CatalogCursor>;
    if (parsed.version !== 1 || parsed.scope !== scope || !Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 1) {
      throw new Error("cursor scope mismatch");
    }
    return Number(parsed.offset);
  } catch {
    throw new Error("question_catalog cursor is invalid or stale");
  }
}

export function estimatedBurden(difficulty: number, stemLength: number): "low" | "medium" | "high" {
  const score = difficulty + Math.min(Math.max(stemLength, 0), 1000) / 2000;
  return score < 0.55 ? "low" : score < 1.05 ? "medium" : "high";
}
