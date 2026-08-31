import assert from "node:assert/strict";
import test from "node:test";
import {
  ERROR_REDUCER_POLICY_REF,
  compileDiagnosisOutcome,
  deriveErrorConsumerActions,
  replayErrorPattern,
  type ErrorEvidence,
  type ErrorReducerPolicy,
  type ErrorVerificationPolicy,
} from "../src/error-core.ts";

const reducerPolicy: ErrorReducerPolicy = {
  policyId: "error-reducer-production-v1",
  policyVersion: 1,
  independentSessionSupports: 2,
  decisiveRequiresAdditionalIndependentSupport: true,
  improvementRequiredCounterKind: "near_transfer",
  improvementRequiresIndependent: true,
  acceptedVerificationSets: [["near_transfer","far_transfer"],["near_transfer","delayed_verification"]],
  recurrenceMinimumSupportQuality: "strong",
  excludeProvisional: true,
  excludeNonDiscriminating: true,
  excludeSameQuestionPromptedCorrection: true,
  excludeReplacedFacts: true,
};

const verificationPolicy: ErrorVerificationPolicy = {
  acceptedVerificationSets: [["near_transfer","far_transfer"],["near_transfer","delayed_verification"]],
  confirmedNearDueDays: 1,
  improvingFollowupDueDays: 7,
  resolvedDelayedDueDays: 30,
};

test("published outcome matrix expands one probe into counterevidence for A and support for B", () => {
  const context = {
    tenantId: "tnt_errortest01",
    studentId: "stu_errortest01",
    diagnosticClaimId: "dcl_errortest01",
    questionSessionId: "qsn_errortest01",
    questionRevisionId: "qrev_errortest01",
    source: "catalog" as const,
    candidateErrorCauseRevisionIds: ["erev_error_a","erev_error_b"],
    activeRuleRevisionId: "rrev_error_ab",
    frozenRuleRevisionIds: ["rrev_error_ab"],
    rulePublished: true,
    outcomeBinId: "supports_b",
    outcomeQuality: "strong" as const,
    relations: [
      { errorCauseRevisionId: "erev_error_a",relation: "counters" as const },
      { errorCauseRevisionId: "erev_error_b",relation: "supports" as const },
    ],
    kind: "probe" as const,
    independent: true,
    hintLevel: 0,
    contextFacets: { representation: "diagram" },
    evidenceRefs: ["answer://msg_errortest01/part-1"],
    judgmentId: "jdg_errortest01",
    judgmentResolved: true,
    judgmentUncertainty: "low" as const,
    modelId: "fixture",
    promptVersion: "fixture-v1",
    occurredAt: "2026-01-01T00:00:00.000Z",
    policyVersion: ERROR_REDUCER_POLICY_REF,
  };
  const facts = compileDiagnosisOutcome(context);
  assert.deepEqual(facts.map((fact) => [fact.errorCauseRevisionId,fact.relation]),[
    ["erev_error_a","counters"],
    ["erev_error_b","supports"],
  ]);
  assert.ok(facts.every((fact) => fact.eligibility === "formal"));
  assert.ok(compileDiagnosisOutcome({ ...context,source: "student_external" })
    .every((fact) => fact.eligibility === "provisional"));
});

const fact = (
  index: number,
  overrides: Partial<ErrorEvidence> = {},
): ErrorEvidence => ({
  errorEvidenceId: `eev_error${String(index).padStart(4,"0")}`,
  studentId: "stu_errortest01",
  errorCauseRevisionId: "erev_error_a",
  diagnosticClaimId: `dcl_error${String(index).padStart(4,"0")}`,
  questionSessionId: `qsn_error${String(index).padStart(4,"0")}`,
  questionRevisionId: `qrev_error${String(index).padStart(4,"0")}`,
  relation: "supports",
  kind: "probe",
  quality: "strong",
  independent: true,
  hintLevel: 0,
  eligibility: "formal",
  contextFacets: {},
  evidenceRefs: [`answer://msg_error${String(index).padStart(4,"0")}/part-1`],
  ruleRevisionId: "rrev_error_a",
  judgmentId: `jdg_error${String(index).padStart(4,"0")}`,
  policyVersion: ERROR_REDUCER_POLICY_REF,
  createdAt: new Date(Date.UTC(2026,0,index)).toISOString(),
  factVersion: 1,
  ...overrides,
});

const replay = (facts: readonly ErrorEvidence[]) => replayErrorPattern({
  studentId: "stu_errortest01",
  errorCauseId: "E_ERROR_A",
  activeDefinitionRevisionId: "erev_error_a",
  facts,
  reducerPolicy,
  verificationPolicy,
  projectedAt: "2026-02-01T00:00:00.000Z",
});

test("error reducer confirms, improves, resolves and records recurrence by replay", () => {
  const supportOne = fact(1);
  assert.equal(replay([supportOne]).projection?.state,"suspected");
  const decisiveAlone = fact(1,{ quality: "decisive" });
  assert.equal(replay([decisiveAlone]).projection?.state,"suspected");

  const supportTwo = fact(2);
  const promptedCorrection = fact(3,{
    questionSessionId: supportTwo.questionSessionId,
    relation: "counters",
    kind: "self_correction",
    independent: false,
    hintLevel: 1,
  });
  assert.equal(replay([supportOne,supportTwo,promptedCorrection]).projection?.state,"confirmed");
  assert.equal(replay([supportOne,supportTwo,promptedCorrection]).projection?.counterCount,0);

  const near = fact(4,{ relation: "counters",kind: "near_transfer" });
  assert.equal(replay([supportOne,supportTwo,near]).projection?.state,"improving");
  const far = fact(5,{ relation: "counters",kind: "far_transfer" });
  const resolved = replay([supportOne,supportTwo,near,far]);
  assert.equal(resolved.projection?.state,"resolved");
  assert.equal(resolved.projection?.verificationDueAt,"2026-02-04T00:00:00.000Z");

  const recurrence = fact(6,{ quality: "strong" });
  const recurred = replay([supportOne,supportTwo,near,far,recurrence]);
  assert.equal(recurred.projection?.state,"confirmed");
  assert.equal(recurred.projection?.recurrenceCount,1);
  assert.equal(recurred.recurrenceEvents.length,1);
});

test("provisional and superseded evidence cannot create or retain formal C_e", () => {
  assert.equal(replay([fact(1,{ eligibility: "provisional" })]).projection,null);
  const original = fact(1);
  const replacement = fact(2,{
    relation: "counters",
    kind: "teacher_correction",
    supersedesErrorEvidenceId: original.errorEvidenceId,
    factVersion: 2,
  });
  assert.equal(replay([original,replacement]).projection,null);
});

test("consumer actions preserve the state boundary instead of writing it", () => {
  const projection = replay([fact(1),fact(2)]).projection!;
  const actions = deriveErrorConsumerActions(projection,"2026-02-01T00:00:00.000Z");
  assert.ok(actions.some((entry) => entry.consumer === "teaching" && entry.action === "apply_remediation"));
  assert.ok(actions.some((entry) => entry.consumer === "selection" && entry.questionRole === "remediates"));
  assert.ok(actions.some((entry) => entry.consumer === "teacher_review"));
  assert.ok(actions.some((entry) => entry.consumer === "content_insight"));
});
