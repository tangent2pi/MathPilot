import { createHash } from "node:crypto";
import {
  Rating,
  State,
  createEmptyCard,
  fsrs,
  type Card,
  type FSRSParameters,
  type ReviewLog,
} from "ts-fsrs";

export const EVIDENCE_POLICY_REF = "evidence-policy-production-v1@1";
export const MASTERY_PARAMETER_SET_ID = "bkt-oatutor-prior-v1";
export const RETENTION_PARAMETER_SET_ID = "fsrs-5.4.1-default-v1";
export const SCIENTIFIC_PROJECTOR_VERSION = "science-v3-projector@1";

export type BinaryOutcome = "success" | "failure";

export interface EvidencePolicy {
  policyId: string;
  policyVersion: number;
  requiredHintLevel: 0;
  requireFrozenQuestionRevision: true;
  requireReliableRubric: true;
  rejectSameQuestionCorrection: true;
  rejectPriorSolutionExposure: true;
  excludeSuperseded: true;
  minimumDelayMinutes: number;
  successRating: "good";
  failureRating: "again";
  unverifiedMeasurement: "reject";
}

export interface RubricResult {
  rubricItemId: string;
  status: "met" | "not_met" | "unclear";
  evidenceRefs: readonly string[];
}

export interface DimensionProposal {
  dimensionRevisionId: string;
  rubricItemId: string;
  outcome: BinaryOutcome | "unresolved";
}

export interface MeasurementTarget {
  measurementRuleId: string;
  dimensionRevisionId: string;
  evidenceRule: string;
}

export interface JudgmentCompilationContext {
  tenantId: string;
  studentId: string;
  questionSessionId: string;
  questionRevisionId: string | null;
  source: "catalog" | "student_external" | "generated_provisional";
  measurementEligibility: string;
  frozenDimensionRevisionIds: readonly string[];
  evidencePolicyRef: string;
  attempt: {
    attemptId: string;
    kind: "answer" | "probe" | "correction" | "explanation";
    hintLevel: number;
    contentRefs: readonly string[];
    submittedAt: string;
    supersedesAttemptId: string | null;
  };
  judgment: {
    judgmentId: string;
    verdict: "correct" | "partially_correct" | "incorrect" | "unresolved";
    rubricResults: readonly RubricResult[];
    dimensionProposals: readonly DimensionProposal[];
    uncertainty: "low" | "medium" | "high";
    evidenceRefs: readonly string[];
    factVersion: number;
    supersedesJudgmentId: string | null;
  };
  measurementTargets: readonly MeasurementTarget[];
}

export interface CompiledObservation {
  observationId: string;
  studentId: string;
  dimensionRevisionId: string;
  questionSessionId: string;
  questionRevisionId: string;
  judgmentId: string;
  outcome: BinaryOutcome;
  measurementRuleId: string;
  hintLevel: 0;
  evidenceRefs: readonly string[];
  occurredAt: string;
  policyVersion: string;
}

export interface CompiledLearningOpportunity {
  learningOpportunityId: string;
  studentId: string;
  dimensionRevisionIds: readonly string[];
  questionSessionId: string;
  interventionKind: "hint" | "explanation" | "worked_example" | "self_correction" | "guided_completion";
  hintLevel: number;
  evidenceRefs: readonly string[];
  occurredAt: string;
}

export type EvidenceRejectionCode =
  | "policy_mismatch"
  | "unverified_content"
  | "unresolved_judgment"
  | "high_uncertainty"
  | "non_independent_attempt"
  | "hint_present"
  | "missing_measurement_target"
  | "ambiguous_measurement_rule"
  | "unreliable_rubric"
  | "unresolved_dimension";

export interface CompiledEvidenceRejection {
  rejectionId: string;
  judgmentId: string;
  attemptId: string;
  dimensionRevisionId: string | null;
  code: EvidenceRejectionCode;
  policyVersion: string;
  detail: string;
}

export interface JudgmentCompilation {
  observations: CompiledObservation[];
  learningOpportunities: CompiledLearningOpportunity[];
  rejects: CompiledEvidenceRejection[];
}

const unique = (values: readonly string[]): string[] => [...new Set(values)];

export function scientificId(prefix: "obs" | "lop" | "drv" | "rej", seed: string): string {
  return `${prefix}_${createHash("sha256").update(seed).digest("hex").slice(0, 24)}`;
}

const rejection = (
  context: JudgmentCompilationContext,
  policy: EvidencePolicy,
  code: EvidenceRejectionCode,
  detail: string,
  dimensionRevisionId: string | null = null,
): CompiledEvidenceRejection => ({
  rejectionId: scientificId("rej", [context.tenantId, context.judgment.judgmentId, dimensionRevisionId ?? "all", code, context.evidencePolicyRef].join("\0")),
  judgmentId: context.judgment.judgmentId,
  attemptId: context.attempt.attemptId,
  dimensionRevisionId,
  code,
  policyVersion: `${policy.policyId}@${policy.policyVersion}`,
  detail,
});

const interventionKind = (context: JudgmentCompilationContext): CompiledLearningOpportunity["interventionKind"] => {
  if (context.attempt.kind === "correction") return "self_correction";
  if (context.attempt.kind === "explanation") return "explanation";
  return context.attempt.hintLevel > 0 ? "hint" : "guided_completion";
};

export function compileJudgment(context: JudgmentCompilationContext, policy: EvidencePolicy): JudgmentCompilation {
  const result: JudgmentCompilation = { observations: [], learningOpportunities: [], rejects: [] };
  const policyRef = `${policy.policyId}@${policy.policyVersion}`;
  if (context.evidencePolicyRef !== policyRef) {
    result.rejects.push(rejection(context, policy, "policy_mismatch", "QuestionSession 引用的 EvidencePolicy 与编译器加载版本不一致"));
    return result;
  }

  const proposedDimensions = unique(context.judgment.dimensionProposals.map((item) => item.dimensionRevisionId));
  const learningDimensions = proposedDimensions.length > 0
    ? proposedDimensions
    : unique(context.measurementTargets
      .map((target) => target.dimensionRevisionId)
      .filter((dimension) => context.frozenDimensionRevisionIds.includes(dimension)));
  if (context.attempt.hintLevel > 0) {
    if (learningDimensions.length > 0) {
      result.learningOpportunities.push({
        learningOpportunityId: scientificId("lop", [context.tenantId, context.judgment.judgmentId, policyRef].join("\0")),
        studentId: context.studentId,
        dimensionRevisionIds: learningDimensions,
        questionSessionId: context.questionSessionId,
        interventionKind: interventionKind(context),
        hintLevel: context.attempt.hintLevel,
        evidenceRefs: unique([...context.attempt.contentRefs, ...context.judgment.evidenceRefs]),
        occurredAt: context.attempt.submittedAt,
      });
    }
    result.rejects.push(rejection(context, policy, "hint_present", "提示等级不为 0，不能形成独立测量 Observation"));
    return result;
  }
  if (context.attempt.kind !== "answer" || context.attempt.supersedesAttemptId !== null) {
    result.rejects.push(rejection(context, policy, "non_independent_attempt", "探针、解释、同题改答或替代 Attempt 不作为独立掌握证据"));
    return result;
  }
  if (context.source !== "catalog" || context.questionRevisionId === null || context.measurementEligibility !== "formal") {
    result.rejects.push(rejection(context, policy, "unverified_content", "题目未通过正式 rubric 与 measurement target 审核"));
    return result;
  }
  if (context.judgment.verdict === "unresolved") {
    result.rejects.push(rejection(context, policy, "unresolved_judgment", "判定未形成可靠结论"));
    return result;
  }
  if (context.judgment.uncertainty === "high") {
    result.rejects.push(rejection(context, policy, "high_uncertainty", "高不确定性判定只保留为审计事实"));
    return result;
  }

  const frozenDimensions = new Set(context.frozenDimensionRevisionIds);
  const proposalCountByDimension = new Map<string,number>();
  for (const proposal of context.judgment.dimensionProposals) {
    proposalCountByDimension.set(
      proposal.dimensionRevisionId,
      (proposalCountByDimension.get(proposal.dimensionRevisionId) ?? 0) + 1,
    );
  }
  const rubricCountById = new Map<string,number>();
  for (const rubric of context.judgment.rubricResults) {
    rubricCountById.set(rubric.rubricItemId,(rubricCountById.get(rubric.rubricItemId) ?? 0) + 1);
  }
  const rubricById = new Map(context.judgment.rubricResults.map((item) => [item.rubricItemId, item]));
  const processedDimensions = new Set<string>();
  for (const proposal of context.judgment.dimensionProposals) {
    if (processedDimensions.has(proposal.dimensionRevisionId)) continue;
    processedDimensions.add(proposal.dimensionRevisionId);
    if (proposalCountByDimension.get(proposal.dimensionRevisionId) !== 1) {
      result.rejects.push(rejection(context, policy, "unreliable_rubric", "同一维度存在多个互相竞争的结果提议", proposal.dimensionRevisionId));
      continue;
    }
    if (proposal.outcome === "unresolved") {
      result.rejects.push(rejection(context, policy, "unresolved_dimension", "逐维度结果未能判定", proposal.dimensionRevisionId));
      continue;
    }
    const targets = context.measurementTargets.filter((target) =>
      target.dimensionRevisionId === proposal.dimensionRevisionId
      && target.evidenceRule.trim().length > 0
      && frozenDimensions.has(target.dimensionRevisionId));
    if (targets.length === 0) {
      result.rejects.push(rejection(context, policy, "missing_measurement_target", "逐维度提议没有冻结的 measurement target", proposal.dimensionRevisionId));
      continue;
    }
    if (targets.length > 1) {
      result.rejects.push(rejection(context, policy, "ambiguous_measurement_rule", "同一维度存在多个无法由 Judgment 区分的 measurement rule", proposal.dimensionRevisionId));
      continue;
    }
    const rubric = rubricById.get(proposal.rubricItemId);
    const expectedStatus = proposal.outcome === "success" ? "met" : "not_met";
    if (rubricCountById.get(proposal.rubricItemId) !== 1
        || !rubric || rubric.status !== expectedStatus || rubric.evidenceRefs.length === 0) {
      result.rejects.push(rejection(context, policy, "unreliable_rubric", "rubric 结果不能可靠支持逐维度二值 Observation", proposal.dimensionRevisionId));
      continue;
    }
    const target = targets[0]!;
    result.observations.push({
      observationId: scientificId("obs", [context.tenantId, context.judgment.judgmentId, proposal.dimensionRevisionId, target.measurementRuleId, policyRef].join("\0")),
      studentId: context.studentId,
      dimensionRevisionId: proposal.dimensionRevisionId,
      questionSessionId: context.questionSessionId,
      questionRevisionId: context.questionRevisionId,
      judgmentId: context.judgment.judgmentId,
      outcome: proposal.outcome,
      measurementRuleId: target.measurementRuleId,
      hintLevel: 0,
      evidenceRefs: unique([...rubric.evidenceRefs, ...context.judgment.evidenceRefs]),
      occurredAt: context.attempt.submittedAt,
      policyVersion: policyRef,
    });
  }
  if (context.judgment.dimensionProposals.length === 0) {
    result.rejects.push(rejection(context, policy, "missing_measurement_target", "Judgment 未给出逐维度结果"));
  }
  return result;
}

export interface DelayedReviewCandidate {
  tenantId: string;
  studentId: string;
  retentionUnitRevisionId: string;
  observation: CompiledObservation;
  previousEvidenceId: string;
  previousEvidenceKind: "observation" | "learning_opportunity";
  previousOccurredAt: string;
}

export interface CompiledDelayedReview {
  delayedReviewEventId: string;
  studentId: string;
  retentionUnitRevisionId: string;
  observationId: string;
  previousObservationId: string | null;
  previousLearningOpportunityId: string | null;
  rating: "again" | "good";
  elapsedDays: number;
  occurredAt: string;
  policyVersion: string;
}

export function compileDelayedReview(candidate: DelayedReviewCandidate, policy: EvidencePolicy): CompiledDelayedReview | undefined {
  const current = Date.parse(candidate.observation.occurredAt);
  const previous = Date.parse(candidate.previousOccurredAt);
  if (!Number.isFinite(current) || !Number.isFinite(previous) || current <= previous) throw new Error("invalid delayed review chronology");
  const elapsedMinutes = (current - previous) / 60_000;
  if (elapsedMinutes < policy.minimumDelayMinutes) return undefined;
  const policyRef = `${policy.policyId}@${policy.policyVersion}`;
  return {
    delayedReviewEventId: scientificId("drv", [
      candidate.tenantId,
      candidate.retentionUnitRevisionId,
      candidate.observation.observationId,
      candidate.previousEvidenceKind,
      candidate.previousEvidenceId,
      policyRef,
    ].join("\0")),
    studentId: candidate.studentId,
    retentionUnitRevisionId: candidate.retentionUnitRevisionId,
    observationId: candidate.observation.observationId,
    previousObservationId: candidate.previousEvidenceKind === "observation" ? candidate.previousEvidenceId : null,
    previousLearningOpportunityId: candidate.previousEvidenceKind === "learning_opportunity" ? candidate.previousEvidenceId : null,
    rating: candidate.observation.outcome === "success" ? policy.successRating : policy.failureRating,
    elapsedDays: elapsedMinutes / 1_440,
    occurredAt: candidate.observation.occurredAt,
    policyVersion: policyRef,
  };
}

export interface BktParameters {
  parameterSetId: string;
  prior: number;
  learn: number;
  slip: number;
  guess: number;
  calibrationStatus: "prior_only" | "calibrated";
  thresholds: {
    minimumIndependentCount: number;
    weak: number;
    learning: number;
    mastered: number;
  };
}

export interface MasteryObservation {
  observationId: string;
  outcome: BinaryOutcome;
  occurredAt: string;
  transferEvidence?: boolean;
}

export interface MasteryReplayResult {
  pMastery: number;
  state: "insufficient_evidence" | "weak" | "learning" | "possibly_mastered" | "mastered";
  independentCount: number;
  transferEvidence: number;
  inputObservationIds: string[];
}

// Thin port of CAHLR/OATutor@6c729b7 src/models/BKT/BKT-brain.js. The adapter
// changes only names and immutability; pyBKT is the independent offline oracle.
export function oatutorBktUpdate(probability: number, outcome: BinaryOutcome, parameters: BktParameters): number {
  const values = [probability, parameters.learn, parameters.slip, parameters.guess];
  if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) throw new Error("invalid BKT parameters");
  const numerator = outcome === "success"
    ? probability * (1 - parameters.slip)
    : probability * parameters.slip;
  const other = outcome === "success"
    ? (1 - probability) * parameters.guess
    : (1 - probability) * (1 - parameters.guess);
  const denominator = numerator + other;
  if (denominator <= 0) throw new Error("degenerate BKT observation likelihood");
  const posterior = numerator / denominator;
  return posterior + (1 - posterior) * parameters.learn;
}

export function replayMastery(observations: readonly MasteryObservation[], parameters: BktParameters): MasteryReplayResult {
  const ordered = [...observations].sort((left, right) =>
    left.occurredAt.localeCompare(right.occurredAt) || left.observationId.localeCompare(right.observationId));
  let pMastery = parameters.prior;
  for (const observation of ordered) pMastery = oatutorBktUpdate(pMastery, observation.outcome, parameters);
  const transferEvidence = ordered.filter((item) => item.transferEvidence).length;
  let state: MasteryReplayResult["state"];
  if (ordered.length < parameters.thresholds.minimumIndependentCount) state = "insufficient_evidence";
  else if (pMastery < parameters.thresholds.weak) state = "weak";
  else if (pMastery < parameters.thresholds.learning) state = "learning";
  else if (pMastery < parameters.thresholds.mastered) state = "possibly_mastered";
  else state = transferEvidence > 0 ? "mastered" : "possibly_mastered";
  return {
    pMastery,
    state,
    independentCount: ordered.length,
    transferEvidence,
    inputObservationIds: ordered.map((item) => item.observationId),
  };
}

export interface RetentionParameters {
  parameterSetId: string;
  engineVersion: "5.4.1";
  parameters: FSRSParameters;
}

export interface RetentionReview {
  delayedReviewEventId: string;
  rating: "again" | "good";
  occurredAt: string;
}

export interface SerializedFsrsCard {
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: State;
  last_review?: string;
}

export interface RetentionReplayResult {
  dueAt: string;
  stability: number;
  difficulty: number;
  retrievability: number;
  cardState: "new" | "learning" | "review" | "relearning";
  lastReviewEventId: string;
  reviewCount: number;
  inputReviewEventIds: string[];
  card: SerializedFsrsCard;
  lastLog: ReviewLog;
}

export const serializeFsrsCard = (card: Card): SerializedFsrsCard => {
  const { due, last_review: lastReview, ...fields } = card;
  return {
    ...fields,
    due: due.toISOString(),
    ...(lastReview ? { last_review: lastReview.toISOString() } : {}),
  };
};

export const deserializeFsrsCard = (card: SerializedFsrsCard): Card => {
  const { due, last_review: lastReview, ...fields } = card;
  return {
    ...fields,
    due: new Date(due),
    ...(lastReview ? { last_review: new Date(lastReview) } : {}),
  };
};

const cardState = (state: State): RetentionReplayResult["cardState"] => {
  switch (state) {
    case State.New: return "new";
    case State.Learning: return "learning";
    case State.Review: return "review";
    case State.Relearning: return "relearning";
  }
};

const grade = (rating: RetentionReview["rating"]): Rating.Again | Rating.Good =>
  rating === "again" ? Rating.Again : Rating.Good;

export function advanceRetentionCard(card: Card, review: RetentionReview, parameters: RetentionParameters): { card: Card; log: ReviewLog } {
  if (parameters.engineVersion !== "5.4.1") throw new Error("unsupported TS-FSRS engine version");
  const occurredAt = new Date(review.occurredAt);
  if (!Number.isFinite(occurredAt.getTime())) throw new Error("invalid review time");
  const record = fsrs(parameters.parameters).next(card, occurredAt, grade(review.rating));
  return { card: record.card, log: record.log };
}

export function replayRetention(
  reviews: readonly RetentionReview[],
  parameters: RetentionParameters,
  projectedAt: string,
): RetentionReplayResult {
  const ordered = [...reviews].sort((left, right) =>
    left.occurredAt.localeCompare(right.occurredAt) || left.delayedReviewEventId.localeCompare(right.delayedReviewEventId));
  if (ordered.length === 0) throw new Error("Retention replay requires at least one DelayedReviewEvent");
  let card = createEmptyCard(new Date(ordered[0]!.occurredAt));
  let lastLog: ReviewLog | undefined;
  for (const review of ordered) {
    const advanced = advanceRetentionCard(card, review, parameters);
    card = advanced.card;
    lastLog = advanced.log;
  }
  const scheduler = fsrs(parameters.parameters);
  const at = new Date(projectedAt);
  const retrievability = scheduler.get_retrievability(card, at, false);
  if (!lastLog || !Number.isFinite(retrievability)) throw new Error("TS-FSRS returned an invalid retention projection");
  return {
    dueAt: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    retrievability,
    cardState: cardState(card.state),
    lastReviewEventId: ordered.at(-1)!.delayedReviewEventId,
    reviewCount: ordered.length,
    inputReviewEventIds: ordered.map((item) => item.delayedReviewEventId),
    card: serializeFsrsCard(card),
    lastLog,
  };
}

export function rollbackRetentionCard(card: SerializedFsrsCard, log: ReviewLog, parameters: RetentionParameters): SerializedFsrsCard {
  if (parameters.engineVersion !== "5.4.1") throw new Error("unsupported TS-FSRS engine version");
  return serializeFsrsCard(fsrs(parameters.parameters).rollback(deserializeFsrsCard(card), log));
}
