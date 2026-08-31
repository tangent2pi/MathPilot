export const LIGHT_COMPILER_VERSION = "light-compiler-v1";
export const REM_COMPILER_VERSION = "rem-window-compiler-v1";
export const DEEP_COMPILER_VERSION = "deep-bundle-compiler-v1";
export const DEEP_GATE_POLICY_VERSION = "deep-gate-v1";

const REF = /^[a-z][a-z0-9+.-]*:\/\/[^\s]{1,500}$/;
const DIMENSION = /^(krev|trev)_[A-Za-z0-9_.:-]{4,}$/;
const ERROR_CAUSE = /^erev_[A-Za-z0-9_.:-]{4,}$/;
const PERSONALITY_LABEL = /(聪明|愚笨|笨|懒惰|懒|焦虑型|人格|智商|天赋差|不努力)/u;

export class DreamValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DreamValidationError";
  }
}

const objectValue = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DreamValidationError(`${name} must be an object`);
  return value as Record<string, unknown>;
};

const exactKeys = (value: Record<string, unknown>, allowed: readonly string[], name: string): void => {
  const allow = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allow.has(key));
  if (unexpected) throw new DreamValidationError(`${name} contains unsupported field ${unexpected}`);
};

const stringValue = (value: unknown, name: string, maximum = 2000): string => {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new DreamValidationError(`${name} is invalid`);
  return value;
};

const identifier = (value: unknown, name: string, pattern: RegExp): string => {
  const result = stringValue(value,name,512);
  if (!pattern.test(result)) throw new DreamValidationError(`${name} is invalid`);
  return result;
};

const enumValue = <T extends string>(value: unknown, name: string, choices: readonly T[]): T => {
  if (typeof value !== "string" || !choices.includes(value as T)) throw new DreamValidationError(`${name} is invalid`);
  return value as T;
};

const integer = (value: unknown, name: string, minimum: number, maximum: number): number => {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new DreamValidationError(`${name} is invalid`);
  }
  return Number(value);
};

const dateTime = (value: unknown, name: string): string => {
  const text = stringValue(value,name,64);
  const date = new Date(text);
  if (!Number.isFinite(date.valueOf()) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    throw new DreamValidationError(`${name} must be an ISO date-time`);
  }
  return date.toISOString();
};

const uniqueStrings = (
  value: unknown,
  name: string,
  options: { maximum: number; minimum?: number; pattern?: RegExp; itemMaximum?: number },
): string[] => {
  if (!Array.isArray(value) || value.length < (options.minimum ?? 0) || value.length > options.maximum) {
    throw new DreamValidationError(`${name} is invalid`);
  }
  const items = value.map((item,index) => {
    const text = stringValue(item,`${name}[${index}]`,options.itemMaximum ?? 512);
    if (options.pattern && !options.pattern.test(text)) throw new DreamValidationError(`${name}[${index}] is invalid`);
    return text;
  });
  if (new Set(items).size !== items.length) throw new DreamValidationError(`${name} contains duplicates`);
  return items;
};

const stringMap = (value: unknown, name: string, requireValue = false): Record<string,string> => {
  const raw = objectValue(value,name);
  exactKeys(raw,Object.keys(raw),name);
  if (Object.keys(raw).length > 24 || requireValue && Object.keys(raw).length === 0) {
    throw new DreamValidationError(`${name} must contain 1..24 scoped facets`);
  }
  const result: Record<string,string> = {};
  for (const [key,item] of Object.entries(raw)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) throw new DreamValidationError(`${name} contains an invalid facet name`);
    result[key] = stringValue(item,`${name}.${key}`,240);
  }
  return result;
};

export interface LightAtomProposal {
  schema_version: 3;
  status: "ready" | "incomplete";
  dream_run_id: string;
  student_id: string;
  question_session_id: string;
  dimensions: string[];
  error_causes: string[];
  observed_behaviors: string[];
  method_signals: string[];
  hint_dependency: "none" | "low" | "medium" | "high" | "unknown";
  self_correction: "none" | "successful" | "partial" | "failed" | "unknown";
  transfer_context: Record<string,string>;
  supports: string[];
  counters: string[];
  unresolved: string[];
  source_refs: string[];
  summary: string;
}

export function parseLightAtomProposal(
  value: unknown,
  expected: { dreamRunId: string; studentId: string; questionSessionId: string },
): LightAtomProposal {
  const raw = objectValue(value,"Light output");
  exactKeys(raw,[
    "schema_version","status","dream_run_id","student_id","question_session_id","dimensions",
    "error_causes","observed_behaviors","method_signals","hint_dependency","self_correction",
    "transfer_context","supports","counters","unresolved","source_refs","summary",
  ],"Light output");
  if (raw.schema_version !== 3) throw new DreamValidationError("Light output schema_version must be 3");
  const result: LightAtomProposal = {
    schema_version: 3,
    status: enumValue(raw.status,"status",["ready","incomplete"] as const),
    dream_run_id: identifier(raw.dream_run_id,"dream_run_id",/^drm_[A-Za-z0-9]{8,}$/),
    student_id: identifier(raw.student_id,"student_id",/^stu_[A-Za-z0-9]{8,}$/),
    question_session_id: identifier(raw.question_session_id,"question_session_id",/^qsn_[A-Za-z0-9]{8,}$/),
    dimensions: uniqueStrings(raw.dimensions,"dimensions",{ maximum: 32,pattern: DIMENSION }),
    error_causes: uniqueStrings(raw.error_causes,"error_causes",{ maximum: 32,pattern: ERROR_CAUSE }),
    observed_behaviors: uniqueStrings(raw.observed_behaviors,"observed_behaviors",{ maximum: 32,itemMaximum: 500 }),
    method_signals: uniqueStrings(raw.method_signals,"method_signals",{ maximum: 32,itemMaximum: 500 }),
    hint_dependency: enumValue(raw.hint_dependency,"hint_dependency",["none","low","medium","high","unknown"] as const),
    self_correction: enumValue(raw.self_correction,"self_correction",["none","successful","partial","failed","unknown"] as const),
    transfer_context: stringMap(raw.transfer_context,"transfer_context"),
    supports: uniqueStrings(raw.supports,"supports",{ maximum: 256,pattern: REF }),
    counters: uniqueStrings(raw.counters,"counters",{ maximum: 256,pattern: REF }),
    unresolved: uniqueStrings(raw.unresolved,"unresolved",{ maximum: 256,pattern: REF }),
    source_refs: uniqueStrings(raw.source_refs,"source_refs",{ maximum: 256,minimum: raw.status === "ready" ? 1 : 0,pattern: REF }),
    summary: stringValue(raw.summary,"summary"),
  };
  if (result.dream_run_id !== expected.dreamRunId || result.student_id !== expected.studentId
    || result.question_session_id !== expected.questionSessionId) {
    throw new DreamValidationError("Light output is not bound to its frozen run, student and QuestionSession");
  }
  const sources = new Set(result.source_refs);
  for (const ref of [...result.supports,...result.counters,...result.unresolved]) {
    if (!sources.has(ref)) throw new DreamValidationError("Light relationship refs must also appear in source_refs");
  }
  return result;
}

export type RemTargetKind = "dimension" | "error_cause" | "student_trait" | "content_insight";

export interface RemCandidateProposal {
  candidate_id: string;
  target_kind: RemTargetKind;
  target_ref: string;
  proposed_claim: string;
  proposed_scope: Record<string,string>;
  support_atom_refs: string[];
  counter_atom_refs: string[];
  contradictions: string[];
  actionability: string;
  distinct_session_count: number;
  context_diversity: number;
  recency: "current" | "recent" | "historical" | "mixed";
  source_trust: "verified_facts" | "mixed" | "insufficient";
  recommended_action: "hold" | "deep_review" | "collect_more" | "content_review";
}

export interface RemOutput {
  schema_version: 3;
  dream_run_id: string;
  window_id: string;
  student_id: string;
  candidates: RemCandidateProposal[];
  summary: string;
}

const targetRef = (kind: RemTargetKind, value: unknown): string => {
  const ref = stringValue(value,"target_ref",512);
  const accepted = kind === "dimension" ? /^dimension:(krev|trev)_[A-Za-z0-9_.:-]{4,}$/.test(ref)
    : kind === "error_cause" ? /^error-cause:erev_[A-Za-z0-9_.:-]{4,}$/.test(ref)
      : kind === "student_trait" ? /^student:stu_[A-Za-z0-9]{8,}$/.test(ref)
        : /^(content|question|diagnosis-rule):[^\s]{4,}$/.test(ref);
  if (!accepted) throw new DreamValidationError(`target_ref is invalid for ${kind}`);
  return ref;
};

export function parseRemOutput(
  value: unknown,
  expected: { dreamRunId: string; windowId: string; studentId: string },
): RemOutput {
  const raw = objectValue(value,"REM output");
  exactKeys(raw,["schema_version","dream_run_id","window_id","student_id","candidates","summary"],"REM output");
  if (raw.schema_version !== 3 || !Array.isArray(raw.candidates) || raw.candidates.length > 32) {
    throw new DreamValidationError("REM output envelope is invalid");
  }
  const result: RemOutput = {
    schema_version: 3,
    dream_run_id: identifier(raw.dream_run_id,"dream_run_id",/^drm_[A-Za-z0-9]{8,}$/),
    window_id: identifier(raw.window_id,"window_id",/^rwin_[A-Za-z0-9]{8,}$/),
    student_id: identifier(raw.student_id,"student_id",/^stu_[A-Za-z0-9]{8,}$/),
    candidates: raw.candidates.map((value,index) => {
      const candidate = objectValue(value,`candidates[${index}]`);
      exactKeys(candidate,[
        "candidate_id","target_kind","target_ref","proposed_claim","proposed_scope","support_atom_refs",
        "counter_atom_refs","contradictions","actionability","distinct_session_count","context_diversity",
        "recency","source_trust","recommended_action",
      ],`candidates[${index}]`);
      const kind = enumValue(candidate.target_kind,"target_kind",["dimension","error_cause","student_trait","content_insight"] as const);
      return {
        candidate_id: identifier(candidate.candidate_id,"candidate_id",/^remc_[A-Za-z0-9]{8,}$/),
        target_kind: kind,
        target_ref: targetRef(kind,candidate.target_ref),
        proposed_claim: stringValue(candidate.proposed_claim,"proposed_claim"),
        proposed_scope: stringMap(candidate.proposed_scope,"proposed_scope"),
        support_atom_refs: uniqueStrings(candidate.support_atom_refs,"support_atom_refs",{ maximum: 64,pattern: /^light-atom:\/\/lat_[A-Za-z0-9]{8,}$/ }),
        counter_atom_refs: uniqueStrings(candidate.counter_atom_refs,"counter_atom_refs",{ maximum: 64,pattern: /^light-atom:\/\/lat_[A-Za-z0-9]{8,}$/ }),
        contradictions: uniqueStrings(candidate.contradictions,"contradictions",{ maximum: 32,itemMaximum: 1000 }),
        actionability: stringValue(candidate.actionability,"actionability",1000),
        distinct_session_count: integer(candidate.distinct_session_count,"distinct_session_count",1,64),
        context_diversity: integer(candidate.context_diversity,"context_diversity",1,64),
        recency: enumValue(candidate.recency,"recency",["current","recent","historical","mixed"] as const),
        source_trust: enumValue(candidate.source_trust,"source_trust",["verified_facts","mixed","insufficient"] as const),
        recommended_action: enumValue(candidate.recommended_action,"recommended_action",["hold","deep_review","collect_more","content_review"] as const),
      };
    }),
    summary: stringValue(raw.summary,"summary"),
  };
  if (result.dream_run_id !== expected.dreamRunId || result.window_id !== expected.windowId || result.student_id !== expected.studentId) {
    throw new DreamValidationError("REM output is not bound to its frozen window");
  }
  if (new Set(result.candidates.map((item) => item.candidate_id)).size !== result.candidates.length) {
    throw new DreamValidationError("REM candidate IDs must be unique within the window");
  }
  return result;
}

export interface WindowAtom {
  atomId: string;
  questionSessionId: string;
  dimensions: readonly string[];
  errorCauses: readonly string[];
  context: Record<string,string>;
  supports: readonly string[];
  counters: readonly string[];
}

export interface RemGateResult {
  status: "accepted" | "rejected" | "review_required";
  reasons: string[];
  distinctSessionCount: number;
  contextDiversity: number;
  supportRefs: string[];
  counterRefs: string[];
}

export function gateRemCandidate(candidate: RemCandidateProposal, atoms: ReadonlyMap<string,WindowAtom>): RemGateResult {
  const reasons: string[] = [];
  const supportAtoms = candidate.support_atom_refs.map((ref) => atoms.get(ref.slice("light-atom://".length)));
  const counterAtoms = candidate.counter_atom_refs.map((ref) => atoms.get(ref.slice("light-atom://".length)));
  if ([...supportAtoms,...counterAtoms].some((atom) => !atom)) reasons.push("candidate cites an atom outside the authorized REM window");
  const selected = [...supportAtoms,...counterAtoms].filter((atom): atom is WindowAtom => Boolean(atom));
  const sessions = new Set(selected.map((atom) => atom.questionSessionId));
  const contexts = new Set(selected.flatMap((atom) => Object.entries(atom.context).map(([key,value]) => `${key}=${value}`)));
  const distinctSessionCount = sessions.size;
  const contextDiversity = Math.max(1,contexts.size);
  if (candidate.distinct_session_count !== distinctSessionCount || candidate.context_diversity !== contextDiversity) {
    reasons.push("model-reported session or context counts do not match host facts");
  }
  if (candidate.source_trust !== "verified_facts") reasons.push("candidate sources are not verified facts");
  if (!Object.keys(candidate.proposed_scope).length) reasons.push("candidate has no bounded scope");
  if (!candidate.support_atom_refs.length) reasons.push("candidate has no supporting Light atom");
  if (!candidate.counter_atom_refs.length) reasons.push("candidate has no explicit counterevidence");
  const minimumSessions = candidate.target_kind === "student_trait" ? 4 : 3;
  const minimumContexts = candidate.target_kind === "student_trait" ? 3 : 2;
  if (distinctSessionCount < minimumSessions) reasons.push(`candidate requires at least ${minimumSessions} independent QuestionSessions`);
  if (contextDiversity < minimumContexts) reasons.push(`candidate requires at least ${minimumContexts} context facets`);
  if (candidate.target_kind === "dimension") {
    const revision = candidate.target_ref.slice("dimension:".length);
    if (!selected.some((atom) => atom.dimensions.includes(revision))) reasons.push("dimension target is not grounded in the selected atoms");
  }
  if (candidate.target_kind === "error_cause") {
    const revision = candidate.target_ref.slice("error-cause:".length);
    if (!selected.some((atom) => atom.errorCauses.includes(revision))) reasons.push("error-cause target is not grounded in the selected atoms");
  }
  if (candidate.target_kind === "student_trait" && PERSONALITY_LABEL.test(candidate.proposed_claim)) {
    reasons.push("student-trait claim uses a prohibited personality label");
  }
  const supportRefs = [...new Set(supportAtoms.flatMap((atom) => atom?.supports ?? []))];
  const counterRefs = [...new Set(counterAtoms.flatMap((atom) => [...(atom?.supports ?? []),...(atom?.counters ?? [])]))];
  if (candidate.target_kind === "content_insight" || candidate.recommended_action === "content_review") {
    return { status: "review_required", reasons: reasons.length ? reasons : ["content insight requires human review"], distinctSessionCount, contextDiversity, supportRefs, counterRefs };
  }
  if (candidate.target_kind === "student_trait") {
    return { status: "review_required", reasons: reasons.length ? reasons : ["student-trait claim requires human review"], distinctSessionCount, contextDiversity, supportRefs, counterRefs };
  }
  if (candidate.recommended_action !== "deep_review") reasons.push("candidate was not recommended for Deep review");
  return {
    status: reasons.length ? "rejected" : "accepted",
    reasons: reasons.length ? reasons : ["verified sources, support/counter evidence, scope and diversity gates passed"],
    distinctSessionCount,
    contextDiversity,
    supportRefs,
    counterRefs,
  };
}

export type AnnotationTargetKind = "dimension" | "error_cause" | "student_trait";

export interface AnnotationDraft {
  target_kind: AnnotationTargetKind;
  target_ref: string;
  claim: string;
  scope: Record<string,string>;
  support_refs: string[];
  counter_refs: string[];
  confidence: "low" | "medium" | "high";
  trend?: "stable" | "improving" | "worsening" | "mixed" | "unknown";
  action_hint?: string;
  valid_from: string;
  review_due_at?: string;
}

export type AnnotationOperation =
  | { op: "add"; annotation: AnnotationDraft }
  | { op: "supersede"; annotation_id: string; replacement: AnnotationDraft; reason: string }
  | { op: "keep"; annotation_id: string; reason: string; evidence_refs: string[] }
  | { op: "propose_review"; target_kind: "student_trait" | "content_insight" | "annotation"; target_ref: string; reason: string; support_refs: string[]; counter_refs: string[] };

export interface AnnotationChangeSet {
  schema_version: 3;
  change_set_id: string;
  student_id: string;
  dream_run_id: string;
  expected_annotation_set_version: number;
  operations: AnnotationOperation[];
  source_refs: string[];
  policy_version: string;
  model_id: string;
  prompt_version: string;
  skill_version: string;
  created_at: string;
}

const parseDraft = (value: unknown, name: string): AnnotationDraft => {
  const raw = objectValue(value,name);
  exactKeys(raw,[
    "target_kind","target_ref","claim","scope","support_refs","counter_refs","confidence",
    "trend","action_hint","valid_from","review_due_at",
  ],name);
  const kind = enumValue(raw.target_kind,`${name}.target_kind`,["dimension","error_cause","student_trait"] as const);
  const claim = stringValue(raw.claim,`${name}.claim`);
  if (kind === "student_trait" && PERSONALITY_LABEL.test(claim)) throw new DreamValidationError("student-trait claim uses a prohibited personality label");
  const validFrom = dateTime(raw.valid_from,`${name}.valid_from`);
  const reviewDueAt = raw.review_due_at === undefined ? undefined : dateTime(raw.review_due_at,`${name}.review_due_at`);
  if (reviewDueAt && reviewDueAt <= validFrom) throw new DreamValidationError("review_due_at must be later than valid_from");
  return {
    target_kind: kind,
    target_ref: targetRef(kind,raw.target_ref),
    claim,
    scope: stringMap(raw.scope,`${name}.scope`,true),
    support_refs: uniqueStrings(raw.support_refs,`${name}.support_refs`,{ maximum: 256,minimum: 1,pattern: REF }),
    counter_refs: uniqueStrings(raw.counter_refs,`${name}.counter_refs`,{ maximum: 256,pattern: REF }),
    confidence: enumValue(raw.confidence,`${name}.confidence`,["low","medium","high"] as const),
    ...(raw.trend === undefined ? {} : { trend: enumValue(raw.trend,`${name}.trend`,["stable","improving","worsening","mixed","unknown"] as const) }),
    ...(raw.action_hint === undefined ? {} : { action_hint: stringValue(raw.action_hint,`${name}.action_hint`,1000) }),
    valid_from: validFrom,
    ...(reviewDueAt ? { review_due_at: reviewDueAt } : {}),
  };
};

export function parseAnnotationChangeSet(
  value: unknown,
  expected: { dreamRunId: string; studentId: string; annotationSetVersion: number },
): AnnotationChangeSet {
  const raw = objectValue(value,"AnnotationChangeSet");
  exactKeys(raw,[
    "schema_version","change_set_id","student_id","dream_run_id","expected_annotation_set_version",
    "operations","source_refs","policy_version","model_id","prompt_version","skill_version","created_at",
  ],"AnnotationChangeSet");
  if (raw.schema_version !== 3 || !Array.isArray(raw.operations) || raw.operations.length < 1 || raw.operations.length > 50) {
    throw new DreamValidationError("AnnotationChangeSet envelope is invalid");
  }
  const result: AnnotationChangeSet = {
    schema_version: 3,
    change_set_id: identifier(raw.change_set_id,"change_set_id",/^acs_[A-Za-z0-9]{8,}$/),
    student_id: identifier(raw.student_id,"student_id",/^stu_[A-Za-z0-9]{8,}$/),
    dream_run_id: identifier(raw.dream_run_id,"dream_run_id",/^drm_[A-Za-z0-9]{8,}$/),
    expected_annotation_set_version: integer(raw.expected_annotation_set_version,"expected_annotation_set_version",0,Number.MAX_SAFE_INTEGER),
    operations: raw.operations.map((value,index): AnnotationOperation => {
      const operation = objectValue(value,`operations[${index}]`);
      const op = enumValue(operation.op,`operations[${index}].op`,["add","supersede","keep","propose_review"] as const);
      if (op === "add") {
        exactKeys(operation,["op","annotation"],`operations[${index}]`);
        return { op,annotation: parseDraft(operation.annotation,`operations[${index}].annotation`) };
      }
      if (op === "supersede") {
        exactKeys(operation,["op","annotation_id","replacement","reason"],`operations[${index}]`);
        return {
          op,
          annotation_id: identifier(operation.annotation_id,"annotation_id",/^ann_[A-Za-z0-9]{8,}$/),
          replacement: parseDraft(operation.replacement,`operations[${index}].replacement`),
          reason: stringValue(operation.reason,"reason",1000),
        };
      }
      if (op === "keep") {
        exactKeys(operation,["op","annotation_id","reason","evidence_refs"],`operations[${index}]`);
        return {
          op,
          annotation_id: identifier(operation.annotation_id,"annotation_id",/^ann_[A-Za-z0-9]{8,}$/),
          reason: stringValue(operation.reason,"reason",1000),
          evidence_refs: uniqueStrings(operation.evidence_refs,"evidence_refs",{ maximum: 256,pattern: REF }),
        };
      }
      exactKeys(operation,["op","target_kind","target_ref","reason","support_refs","counter_refs"],`operations[${index}]`);
      const reviewKind = enumValue(operation.target_kind,"target_kind",["student_trait","content_insight","annotation"] as const);
      const reviewTargetRef = stringValue(operation.target_ref,"target_ref",512);
      if (!/^[a-z][a-z0-9+.-]*:[^\s]+$/.test(reviewTargetRef)) throw new DreamValidationError("review target_ref is invalid");
      return {
        op,
        target_kind: reviewKind,
        target_ref: reviewTargetRef,
        reason: stringValue(operation.reason,"reason"),
        support_refs: uniqueStrings(operation.support_refs,"support_refs",{ maximum: 256,minimum: 1,pattern: REF }),
        counter_refs: uniqueStrings(operation.counter_refs,"counter_refs",{ maximum: 256,pattern: REF }),
      };
    }),
    source_refs: uniqueStrings(raw.source_refs,"source_refs",{ maximum: 64,minimum: 1,pattern: /^rem-candidate:\/\/remc_[A-Za-z0-9]{8,}$/ }),
    policy_version: stringValue(raw.policy_version,"policy_version",160),
    model_id: stringValue(raw.model_id,"model_id",160),
    prompt_version: stringValue(raw.prompt_version,"prompt_version",160),
    skill_version: stringValue(raw.skill_version,"skill_version",160),
    created_at: dateTime(raw.created_at,"created_at"),
  };
  if (result.dream_run_id !== expected.dreamRunId || result.student_id !== expected.studentId
    || result.expected_annotation_set_version !== expected.annotationSetVersion) {
    throw new DreamValidationError("AnnotationChangeSet is not bound to its frozen Deep window");
  }
  if (result.policy_version !== DEEP_GATE_POLICY_VERSION) throw new DreamValidationError("AnnotationChangeSet policy_version is not current");
  return result;
}
