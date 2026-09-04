// grade-core.ts — respond-time contract gate for the `grade` TaskSpec.
//
// The grade AgentAttempt must return a scientific-fact/v1 Judgment proposal
// that the host can commit through question-store.recordFinalJudgment. The
// model only sees the output_schema URL as text, so it frequently invents an
// envelope (e.g. `measurements`/`score`) instead of the frozen contract
// (`rubric_results`/`dimension_proposals`/`uncertainty`/`decision_summary`).
// This pure validator mirrors the authoritative recordFinalJudgment checks
// using only the frozen input bundle, so a malformed proposal fails fast at
// respond time and the AgentAttempt can self-correct on retry.
//
// The database insert path (question-store.ts) remains the source of truth;
// this module intentionally never reads scientific state.

const VERDICTS = ["correct", "partially_correct", "incorrect", "unresolved"] as const;
const UNCERTAINTIES = ["low", "medium", "high"] as const;
const RUBRIC_STATUSES = ["met", "not_met", "unclear"] as const;
const DIMENSION_OUTCOMES = ["success", "failure", "unresolved"] as const;

export interface GradeProposalContext {
  judgmentId: string;
  attemptId: string;
  schemaVersion: number;
  factVersion: number;
  allowedEvidenceRefs: string[];
  allowedRubricItemIds: string[];
  allowedDimensionRevisionIds: string[];
}

const asRecord = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`grade respond rejected: ${name} must be an object`);
  return value as Record<string, unknown>;
};

const asString = (value: unknown, name: string, maximum = 2000): string => {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`grade respond rejected: ${name} is invalid`);
  return value;
};

const asEnum = <T extends string>(value: unknown, name: string, choices: readonly T[]): T => {
  if (typeof value !== "string" || !(choices as readonly string[]).includes(value)) {
    throw new Error(`grade respond rejected: ${name} is invalid (expected one of ${choices.join("/")})`);
  }
  return value as T;
};

const asStringArray = (value: unknown, name: string, minimum: number): string[] => {
  if (!Array.isArray(value) || value.length < minimum || !value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new Error(`grade respond rejected: ${name} is invalid`);
  }
  return [...new Set(value as string[])];
};

const subsetOf = (refs: string[], allowed: string[], name: string): void => {
  if (allowed.length === 0) return; // bundle did not publish an allowlist; stay permissive
  const disallowed = refs.filter((ref) => !allowed.includes(ref));
  if (disallowed.length > 0) throw new Error(`grade respond rejected: ${name} cites evidence outside the frozen Attempt: ${disallowed.join(", ")}`);
};

export function parseJudgmentProposal(value: unknown, context: GradeProposalContext): Record<string, unknown> {
  const proposal = asRecord(value, "Judgment proposal");
  if (proposal.schema_version !== context.schemaVersion) {
    throw new Error(`grade respond rejected: schema_version must be ${context.schemaVersion}`);
  }
  if (proposal.fact_version !== context.factVersion) {
    throw new Error(`grade respond rejected: fact_version must be ${context.factVersion}`);
  }
  if (proposal.fact_type !== "judgment") throw new Error("grade respond rejected: fact_type must be \"judgment\"");
  if (proposal.judgment_id !== context.judgmentId) throw new Error("grade respond rejected: judgment_id does not match the frozen task");
  if (proposal.attempt_id !== context.attemptId) throw new Error("grade respond rejected: attempt_id does not match the frozen task");

  asEnum(proposal.verdict, "verdict", VERDICTS);
  asEnum(proposal.uncertainty, "uncertainty", UNCERTAINTIES);
  asString(proposal.decision_summary, "decision_summary");
  const evidenceRefs = asStringArray(proposal.evidence_refs, "evidence_refs", 1);
  subsetOf(evidenceRefs, context.allowedEvidenceRefs, "evidence_refs");

  if (!Array.isArray(proposal.rubric_results) || proposal.rubric_results.length < 1) {
    throw new Error("grade respond rejected: rubric_results is invalid (must be a non-empty array)");
  }
  const rubricById = new Map<string, { status: (typeof RUBRIC_STATUSES)[number]; evidence_refs: string[] }>();
  for (const [index, raw] of proposal.rubric_results.entries()) {
    const item = asRecord(raw, `rubric_results[${index}]`);
    const rubricItemId = asString(item.rubric_item_id, `rubric_results[${index}].rubric_item_id`, 160);
    const status = asEnum(item.status, `rubric_results[${index}].status`, RUBRIC_STATUSES);
    const itemEvidence = asStringArray(item.evidence_refs, `rubric_results[${index}].evidence_refs`, 1);
    subsetOf(itemEvidence, context.allowedEvidenceRefs, `rubric_results[${index}].evidence_refs`);
    if (context.allowedRubricItemIds.length > 0 && !context.allowedRubricItemIds.includes(rubricItemId)) {
      throw new Error(`grade respond rejected: rubric_results[${index}] uses a rubric item outside the frozen question: ${rubricItemId}`);
    }
    if (rubricById.has(rubricItemId)) throw new Error(`grade respond rejected: rubric_results contains duplicate rubric item ${rubricItemId}`);
    rubricById.set(rubricItemId, { status, evidence_refs: itemEvidence });
  }

  if (!Array.isArray(proposal.dimension_proposals)) {
    throw new Error("grade respond rejected: dimension_proposals is invalid (must be an array)");
  }
  const seenDimensions = new Set<string>();
  for (const [index, raw] of proposal.dimension_proposals.entries()) {
    const item = asRecord(raw, `dimension_proposals[${index}]`);
    const dimension = asString(item.dimension_revision_id, `dimension_proposals[${index}].dimension_revision_id`, 160);
    const rubricItemId = asString(item.rubric_item_id, `dimension_proposals[${index}].rubric_item_id`, 160);
    const outcome = asEnum(item.outcome, `dimension_proposals[${index}].outcome`, DIMENSION_OUTCOMES);
    if (context.allowedDimensionRevisionIds.length > 0 && !context.allowedDimensionRevisionIds.includes(dimension)) {
      throw new Error(`grade respond rejected: dimension_proposals[${index}] proposes an unfrozen dimension: ${dimension}`);
    }
    if (seenDimensions.has(dimension)) throw new Error(`grade respond rejected: dimension_proposals contains duplicate dimension ${dimension}`);
    seenDimensions.add(dimension);
    const rubric = rubricById.get(rubricItemId);
    if (!rubric) throw new Error(`grade respond rejected: dimension_proposals[${index}] references a rubric item missing from rubric_results`);
    if (outcome === "success" && rubric.status !== "met") {
      throw new Error(`grade respond rejected: dimension_proposals[${index}] outcome=success contradicts rubric status ${rubric.status}`);
    }
    if (outcome === "failure" && rubric.status !== "not_met") {
      throw new Error(`grade respond rejected: dimension_proposals[${index}] outcome=failure contradicts rubric status ${rubric.status}`);
    }
  }

  return proposal;
}
