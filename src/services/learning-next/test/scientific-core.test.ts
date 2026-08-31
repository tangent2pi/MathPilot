import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createEmptyCard, type FSRSParameters } from "ts-fsrs";
import {
  EVIDENCE_POLICY_REF,
  advanceRetentionCard,
  compileDelayedReview,
  compileJudgment,
  oatutorBktUpdate,
  replayMastery,
  replayRetention,
  rollbackRetentionCard,
  serializeFsrsCard,
  type BktParameters,
  type EvidencePolicy,
  type JudgmentCompilationContext,
  type RetentionParameters,
  type RetentionReview,
} from "../src/scientific-core.ts";

const policy: EvidencePolicy = {
  policyId: "evidence-policy-production-v1",
  policyVersion: 1,
  requiredHintLevel: 0,
  requireFrozenQuestionRevision: true,
  requireReliableRubric: true,
  rejectSameQuestionCorrection: true,
  rejectPriorSolutionExposure: true,
  excludeSuperseded: true,
  minimumDelayMinutes: 1_440,
  successRating: "good",
  failureRating: "again",
  unverifiedMeasurement: "reject",
};

const validContext = (): JudgmentCompilationContext => ({
  tenantId: "tnt_test00001",
  studentId: "stu_test00001",
  questionSessionId: "qsn_test00001",
  questionRevisionId: "qrev_test00001",
  source: "catalog",
  measurementEligibility: "formal",
  frozenDimensionRevisionIds: ["krev_algebra001"],
  evidencePolicyRef: EVIDENCE_POLICY_REF,
  attempt: {
    attemptId: "att_test00001",
    kind: "answer",
    hintLevel: 0,
    contentRefs: ["message://msg_test00001"],
    submittedAt: "2026-01-03T00:00:00.000Z",
    supersedesAttemptId: null,
  },
  judgment: {
    judgmentId: "jdg_test00001",
    verdict: "correct",
    rubricResults: [{ rubricItemId: "rubric-one",status: "met",evidenceRefs: ["message://msg_test00001"] }],
    dimensionProposals: [{ dimensionRevisionId: "krev_algebra001",rubricItemId: "rubric-one",outcome: "success" }],
    uncertainty: "low",
    evidenceRefs: ["message://msg_test00001"],
    factVersion: 1,
    supersedesJudgmentId: null,
  },
  measurementTargets: [{
    measurementRuleId: "measurement-one",
    dimensionRevisionId: "krev_algebra001",
    evidenceRule: "rubric-one must be independently met",
  }],
});

test("EvidencePolicy compiles only reliable independent dimension facts", () => {
  const valid = compileJudgment(validContext(),policy);
  assert.equal(valid.observations.length,1);
  assert.equal(valid.observations[0]?.outcome,"success");
  assert.deepEqual(valid.rejects,[]);

  const cases: Array<{
    name: string;
    mutate(context: JudgmentCompilationContext): void;
    code: string;
  }> = [
    { name: "hint",mutate: (context) => { context.attempt.hintLevel = 1; },code: "hint_present" },
    { name: "correction",mutate: (context) => { context.attempt.kind = "correction"; },code: "non_independent_attempt" },
    { name: "external",mutate: (context) => { context.source = "student_external"; },code: "unverified_content" },
    { name: "unresolved",mutate: (context) => { context.judgment.verdict = "unresolved"; },code: "unresolved_judgment" },
    { name: "high uncertainty",mutate: (context) => { context.judgment.uncertainty = "high"; },code: "high_uncertainty" },
    { name: "missing target",mutate: (context) => { context.measurementTargets = []; },code: "missing_measurement_target" },
    { name: "ambiguous target",mutate: (context) => {
      context.measurementTargets = [...context.measurementTargets,{ ...context.measurementTargets[0]!,measurementRuleId: "measurement-two" }];
    },code: "ambiguous_measurement_rule" },
    { name: "duplicate dimension proposal",mutate: (context) => {
      context.judgment.dimensionProposals = [...context.judgment.dimensionProposals,{ ...context.judgment.dimensionProposals[0]!,outcome: "failure" }];
    },code: "unreliable_rubric" },
  ];
  for (const entry of cases) {
    const context = validContext();
    entry.mutate(context);
    const compiled = compileJudgment(context,policy);
    assert.equal(compiled.observations.length,0,entry.name);
    assert.ok(compiled.rejects.some((reject) => reject.code === entry.code),entry.name);
    if (entry.name === "hint") assert.equal(compiled.learningOpportunities.length,1);
  }
});

test("DelayedReviewEvent requires the versioned minimum delay and latest evidence anchor", () => {
  const observation = compileJudgment(validContext(),policy).observations[0]!;
  const delayed = compileDelayedReview({
    tenantId: "tnt_test00001",
    studentId: "stu_test00001",
    retentionUnitRevisionId: "rurev_algebra001",
    observation,
    previousEvidenceId: "obs_previous001",
    previousEvidenceKind: "observation",
    previousOccurredAt: "2026-01-01T00:00:00.000Z",
  },policy);
  assert.equal(delayed?.elapsedDays,2);
  assert.equal(delayed?.rating,"good");
  assert.equal(delayed?.previousObservationId,"obs_previous001");
  assert.equal(compileDelayedReview({
    tenantId: "tnt_test00001",
    studentId: "stu_test00001",
    retentionUnitRevisionId: "rurev_algebra001",
    observation,
    previousEvidenceId: "lop_recent0001",
    previousEvidenceKind: "learning_opportunity",
    previousOccurredAt: "2026-01-02T12:00:00.000Z",
  },policy),undefined);
});

const bktParameters: BktParameters = {
  parameterSetId: "bkt-oatutor-prior-v1",
  prior: 0.3,
  learn: 0,
  slip: 0.1,
  guess: 0.2,
  calibrationStatus: "prior_only",
  thresholds: { minimumIndependentCount: 2,weak: 0.4,learning: 0.8,mastered: 0.95 },
};

test("OATutor replay matches the pyBKT 1.4.3 golden fixture and incremental replay", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/bkt-pybkt-golden.json",import.meta.url),"utf8")) as {
    cases: Array<{ outcomes: Array<"success" | "failure">; p_mastery: number }>;
  };
  for (const entry of fixture.cases) {
    const observations = entry.outcomes.map((outcome,index) => ({
      observationId: `obs_golden${String(index).padStart(4,"0")}`,
      outcome,
      occurredAt: new Date(Date.UTC(2026,0,index + 1)).toISOString(),
    }));
    const replay = replayMastery(observations,bktParameters);
    assert.ok(Math.abs(replay.pMastery - entry.p_mastery) < 1e-12);
    let incremental = bktParameters.prior;
    for (const observation of observations) {
      incremental = oatutorBktUpdate(incremental,observation.outcome,bktParameters);
    }
    assert.equal(incremental,replay.pMastery);
    for (let size = 0; size <= observations.length; size += 1) {
      const prefix = replayMastery(observations.slice(0,size),bktParameters);
      assert.ok(Number.isFinite(prefix.pMastery));
    }
  }
});

const fsrsParameters: FSRSParameters = {
  request_retention: 0.9,
  maximum_interval: 36_500,
  w: [0.212,1.2931,2.3065,8.2956,6.4133,0.8334,3.0194,0.001,1.8722,0.1666,0.796,1.4835,0.0614,0.2629,1.6483,0.6014,1.8729,0.5425,0.0912,0.0658,0.1542],
  enable_fuzz: false,
  enable_short_term: false,
  learning_steps: [],
  relearning_steps: [],
};
const retentionParameters: RetentionParameters = {
  parameterSetId: "fsrs-5.4.1-default-v1",
  engineVersion: "5.4.1",
  parameters: fsrsParameters,
};
const reviews: RetentionReview[] = [
  { delayedReviewEventId: "drv_golden0001",rating: "good",occurredAt: "2026-01-01T00:00:00.000Z" },
  { delayedReviewEventId: "drv_golden0002",rating: "again",occurredAt: "2026-01-05T00:00:00.000Z" },
  { delayedReviewEventId: "drv_golden0003",rating: "good",occurredAt: "2026-01-08T00:00:00.000Z" },
];

test("TS-FSRS 5.4.1 replay matches pinned golden values and supports rollback", () => {
  const replay = replayRetention(reviews,retentionParameters,"2026-01-09T00:00:00.000Z");
  assert.equal(replay.dueAt,"2026-01-12T00:00:00.000Z");
  assert.equal(replay.stability,3.99907132);
  assert.equal(replay.difficulty,7.38233661);
  assert.equal(replay.retrievability,0.96675664);
  assert.equal(replay.cardState,"review");

  let card = createEmptyCard(new Date(reviews[0]!.occurredAt));
  const incremental = reviews.map((review) => {
    const result = advanceRetentionCard(card,review,retentionParameters);
    card = result.card;
    return result;
  });
  assert.deepEqual(serializeFsrsCard(card),replay.card);
  const rolledBack = rollbackRetentionCard(replay.card,replay.lastLog,retentionParameters);
  assert.equal(rolledBack.stability,incremental[1]!.card.stability);
  assert.equal(rolledBack.difficulty,incremental[1]!.card.difficulty);
  assert.equal(rolledBack.reps,2);
});
