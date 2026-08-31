import { createHash } from "node:crypto";

export const ERROR_REDUCER_POLICY_REF = "error-reducer-production-v1@1";
export const ERROR_PROJECTOR_VERSION = "science-v3-error-projector@1";

export type ErrorRelation = "supports" | "counters" | "non_discriminating";
export type ErrorEvidenceKind =
  | "spontaneous_error"
  | "probe"
  | "self_correction"
  | "explanation"
  | "near_transfer"
  | "far_transfer"
  | "delayed_verification"
  | "teacher_confirmation"
  | "teacher_correction";
export type ErrorEvidenceQuality = "weak" | "strong" | "decisive";
export type ErrorPatternState = "suspected" | "confirmed" | "improving" | "resolved" | "superseded";

export interface ErrorReducerPolicy {
  policyId: string;
  policyVersion: number;
  independentSessionSupports: number;
  decisiveRequiresAdditionalIndependentSupport: true;
  improvementRequiredCounterKind: "near_transfer";
  improvementRequiresIndependent: true;
  acceptedVerificationSets: ReadonlyArray<ReadonlyArray<"near_transfer" | "far_transfer" | "delayed_verification">>;
  recurrenceMinimumSupportQuality: "strong" | "decisive";
  excludeProvisional: true;
  excludeNonDiscriminating: true;
  excludeSameQuestionPromptedCorrection: true;
  excludeReplacedFacts: true;
}

export interface ErrorVerificationPolicy {
  acceptedVerificationSets: ReadonlyArray<ReadonlyArray<"near_transfer" | "far_transfer" | "delayed_verification">>;
  confirmedNearDueDays: number;
  improvingFollowupDueDays: number;
  resolvedDelayedDueDays: number;
}

export interface DiagnosisRelation {
  errorCauseRevisionId: string;
  relation: ErrorRelation;
  kind?: ErrorEvidenceKind;
}

export interface DiagnosisOutcomeContext {
  tenantId: string;
  studentId: string;
  diagnosticClaimId: string;
  questionSessionId: string;
  questionRevisionId: string;
  source: "catalog" | "student_external" | "generated_provisional";
  candidateErrorCauseRevisionIds: readonly string[];
  activeRuleRevisionId: string;
  frozenRuleRevisionIds: readonly string[];
  rulePublished: boolean;
  outcomeBinId: string;
  outcomeQuality: ErrorEvidenceQuality;
  relations: readonly DiagnosisRelation[];
  kind: ErrorEvidenceKind;
  independent: boolean;
  hintLevel: number;
  contextFacets: Readonly<Record<string, string>>;
  evidenceRefs: readonly string[];
  judgmentId?: string;
  judgmentResolved: boolean;
  judgmentUncertainty: "low" | "medium" | "high";
  modelId?: string;
  promptVersion?: string;
  occurredAt: string;
  policyVersion: string;
}

export interface ErrorEvidence {
  errorEvidenceId: string;
  studentId: string;
  errorCauseRevisionId: string;
  diagnosticClaimId?: string;
  questionSessionId: string;
  questionRevisionId: string;
  relation: ErrorRelation;
  kind: ErrorEvidenceKind;
  quality: ErrorEvidenceQuality;
  independent: boolean;
  hintLevel: number;
  eligibility: "formal" | "provisional";
  contextFacets: Readonly<Record<string, string>>;
  evidenceRefs: readonly string[];
  ruleRevisionId?: string;
  judgmentId?: string;
  modelId?: string;
  promptVersion?: string;
  policyVersion: string;
  createdAt: string;
  supersedesErrorEvidenceId?: string;
  factVersion: number;
}

export interface ErrorPatternProjection {
  studentId: string;
  errorCauseId: string;
  activeDefinitionRevisionId: string;
  state: ErrorPatternState;
  supportCount: number;
  counterCount: number;
  independentSessionCount: number;
  recurrenceCount: number;
  verificationDueAt?: string;
  effectiveEvidenceIds: readonly string[];
  supersededByErrorCauseRevisionId?: string;
  policyVersion: string;
  projectionVersion: number;
  projectorVersion: string;
  projectedAt: string;
}

export interface ErrorRecurrenceEvent {
  recurrenceEventId: string;
  studentId: string;
  errorCauseId: string;
  triggerErrorEvidenceId: string;
  recurrenceNumber: number;
  occurredAt: string;
  policyVersion: string;
}

export interface ErrorReplayResult {
  projection: ErrorPatternProjection | null;
  recurrenceEvents: ErrorRecurrenceEvent[];
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

const stableId = (prefix: "eev" | "erec", seed: string): string =>
  `${prefix}_${createHash("sha256").update(seed).digest("hex").slice(0, 24)}`;

const assertUnique = (values: readonly string[], label: string): void => {
  if (values.length !== new Set(values).size) throw new Error(`${label} must be unique`);
};

export function compileDiagnosisOutcome(context: DiagnosisOutcomeContext): ErrorEvidence[] {
  if (!Number.isInteger(context.hintLevel) || context.hintLevel < 0 || context.hintLevel > 5) {
    throw new Error("diagnosis hint level must be between 0 and 5");
  }
  if (!context.candidateErrorCauseRevisionIds.length) throw new Error("DiagnosticClaim has no candidates");
  assertUnique(context.candidateErrorCauseRevisionIds,"DiagnosticClaim candidates");
  assertUnique(context.relations.map((relation) => relation.errorCauseRevisionId),"diagnosis outcome relations");
  const relationByCandidate = new Map(context.relations.map((relation) => [relation.errorCauseRevisionId,relation]));
  for (const candidate of context.candidateErrorCauseRevisionIds) {
    if (!relationByCandidate.has(candidate)) {
      throw new Error(`published diagnosis matrix does not map candidate ${candidate}`);
    }
  }
  if (context.relations.some((relation) => !context.candidateErrorCauseRevisionIds.includes(relation.errorCauseRevisionId))) {
    throw new Error("diagnosis outcome matrix contains a candidate outside the frozen claim");
  }
  const evidenceRefs = unique(context.evidenceRefs);
  if (!evidenceRefs.length) throw new Error("diagnosis outcome requires evidence refs");
  const formal = context.source === "catalog"
    && context.rulePublished
    && context.frozenRuleRevisionIds.includes(context.activeRuleRevisionId)
    && context.judgmentResolved
    && context.judgmentUncertainty !== "high";
  return context.candidateErrorCauseRevisionIds.map((candidate) => {
    const relation = relationByCandidate.get(candidate)!;
    const factKind = relation.kind ?? context.kind;
    const factIndependent = context.independent && context.hintLevel === 0
      && factKind !== "self_correction" && factKind !== "explanation";
    return {
      errorEvidenceId: stableId("eev",[
        context.tenantId,context.diagnosticClaimId,context.outcomeBinId,candidate,
        relation.relation,context.judgmentId ?? "host",context.policyVersion,
      ].join("\0")),
      studentId: context.studentId,
      errorCauseRevisionId: candidate,
      diagnosticClaimId: context.diagnosticClaimId,
      questionSessionId: context.questionSessionId,
      questionRevisionId: context.questionRevisionId,
      relation: relation.relation,
      kind: factKind,
      quality: context.outcomeQuality,
      independent: factIndependent,
      hintLevel: context.hintLevel,
      eligibility: formal ? "formal" : "provisional",
      contextFacets: { ...context.contextFacets },
      evidenceRefs,
      ruleRevisionId: context.activeRuleRevisionId,
      ...(context.judgmentId ? { judgmentId: context.judgmentId } : {}),
      ...(context.modelId ? { modelId: context.modelId } : {}),
      ...(context.promptVersion ? { promptVersion: context.promptVersion } : {}),
      policyVersion: context.policyVersion,
      createdAt: context.occurredAt,
      factVersion: 1,
    };
  });
}

const qualityAtLeast = (actual: ErrorEvidenceQuality, minimum: ErrorEvidenceQuality): boolean => {
  const rank: Record<ErrorEvidenceQuality,number> = { weak: 0,strong: 1,decisive: 2 };
  return rank[actual] >= rank[minimum];
};

const addDays = (iso: string, days: number): string => {
  const value = new Date(iso);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString();
};

const isPromptedSameQuestionCorrection = (fact: ErrorEvidence): boolean =>
  fact.kind === "self_correction" && (!fact.independent || fact.hintLevel > 0);

export function replayErrorPattern(input: {
  studentId: string;
  errorCauseId: string;
  activeDefinitionRevisionId: string;
  facts: readonly ErrorEvidence[];
  reducerPolicy: ErrorReducerPolicy;
  verificationPolicy: ErrorVerificationPolicy;
  projectedAt: string;
  projectionVersion?: number;
  supersededByErrorCauseRevisionId?: string;
}): ErrorReplayResult {
  const policyRef = `${input.reducerPolicy.policyId}@${input.reducerPolicy.policyVersion}`;
  const replacedIds = new Set(input.facts
    .map((fact) => fact.supersedesErrorEvidenceId)
    .filter((value): value is string => Boolean(value)));
  const active = [...input.facts]
    .filter((fact) => !replacedIds.has(fact.errorEvidenceId))
    .sort((left,right) => left.createdAt.localeCompare(right.createdAt)
      || left.errorEvidenceId.localeCompare(right.errorEvidenceId));
  const effective = active.filter((fact) => fact.eligibility === "formal"
    && fact.relation !== "non_discriminating"
    && !isPromptedSameQuestionCorrection(fact));
  if (!effective.length && !input.supersededByErrorCauseRevisionId) {
    return { projection: null,recurrenceEvents: [] };
  }

  const supportCount = effective.filter((fact) => fact.relation === "supports").length;
  const counterCount = effective.filter((fact) => fact.relation === "counters").length;
  const independentSessionCount = new Set(effective
    .filter((fact) => fact.independent)
    .map((fact) => fact.questionSessionId)).size;
  let state: ErrorPatternState | null = null;
  let recurrenceCount = 0;
  let lastTransitionAt = effective[0]?.createdAt ?? input.projectedAt;
  let supportSessions = new Set<string>();
  let verificationKinds = new Set<ErrorEvidenceKind>();
  const recurrenceEvents: ErrorRecurrenceEvent[] = [];

  for (const fact of effective) {
    if (fact.relation === "supports") {
      if (fact.independent) supportSessions.add(fact.questionSessionId);
      if (state === null) {
        state = "suspected";
        lastTransitionAt = fact.createdAt;
      }
      const decisiveWithAdditional = [...effective]
        .filter((candidate) => candidate.relation === "supports" && candidate.independent
          && candidate.createdAt.localeCompare(fact.createdAt) <= 0)
        .some((candidate) => candidate.quality === "decisive") && supportSessions.size >= 2;
      if (state === "suspected"
          && (supportSessions.size >= input.reducerPolicy.independentSessionSupports || decisiveWithAdditional)) {
        state = "confirmed";
        verificationKinds = new Set();
        lastTransitionAt = fact.createdAt;
      } else if (state === "improving" && qualityAtLeast(fact.quality,input.reducerPolicy.recurrenceMinimumSupportQuality)) {
        state = "confirmed";
        verificationKinds = new Set();
        lastTransitionAt = fact.createdAt;
      } else if (state === "resolved" && qualityAtLeast(fact.quality,input.reducerPolicy.recurrenceMinimumSupportQuality)) {
        state = "confirmed";
        recurrenceCount += 1;
        verificationKinds = new Set();
        lastTransitionAt = fact.createdAt;
        recurrenceEvents.push({
          recurrenceEventId: stableId("erec",[
            input.studentId,input.errorCauseId,fact.errorEvidenceId,String(recurrenceCount),policyRef,
          ].join("\0")),
          studentId: input.studentId,
          errorCauseId: input.errorCauseId,
          triggerErrorEvidenceId: fact.errorEvidenceId,
          recurrenceNumber: recurrenceCount,
          occurredAt: fact.createdAt,
          policyVersion: policyRef,
        });
      }
      continue;
    }
    if (fact.relation !== "counters" || !fact.independent) continue;
    if (state === "confirmed" && fact.kind === input.reducerPolicy.improvementRequiredCounterKind) {
      state = "improving";
      verificationKinds = new Set([fact.kind]);
      lastTransitionAt = fact.createdAt;
      continue;
    }
    if (state !== "improving") continue;
    if (fact.kind === "near_transfer" || fact.kind === "far_transfer" || fact.kind === "delayed_verification") {
      verificationKinds.add(fact.kind);
    }
    if (input.verificationPolicy.acceptedVerificationSets.some((set) =>
      set.every((kind) => verificationKinds.has(kind)))) {
      state = "resolved";
      lastTransitionAt = fact.createdAt;
    }
  }

  if (input.supersededByErrorCauseRevisionId) state = "superseded";
  if (!state) return { projection: null,recurrenceEvents };
  const delay = state === "confirmed"
    ? input.verificationPolicy.confirmedNearDueDays
    : state === "improving"
      ? input.verificationPolicy.improvingFollowupDueDays
      : state === "resolved"
        ? input.verificationPolicy.resolvedDelayedDueDays
        : null;
  return {
    projection: {
      studentId: input.studentId,
      errorCauseId: input.errorCauseId,
      activeDefinitionRevisionId: input.activeDefinitionRevisionId,
      state,
      supportCount,
      counterCount,
      independentSessionCount,
      recurrenceCount,
      ...(delay === null ? {} : { verificationDueAt: addDays(lastTransitionAt,delay) }),
      effectiveEvidenceIds: effective.map((fact) => fact.errorEvidenceId),
      ...(input.supersededByErrorCauseRevisionId
        ? { supersededByErrorCauseRevisionId: input.supersededByErrorCauseRevisionId }
        : {}),
      policyVersion: policyRef,
      projectionVersion: input.projectionVersion ?? 1,
      projectorVersion: ERROR_PROJECTOR_VERSION,
      projectedAt: input.projectedAt,
    },
    recurrenceEvents,
  };
}

export type ErrorConsumer =
  | "diagnostic_planner"
  | "teaching"
  | "selection"
  | "verification"
  | "report"
  | "teacher_review"
  | "content_insight";

export interface ErrorConsumerAction {
  consumer: ErrorConsumer;
  action: string;
  questionRole?: "discriminates" | "remediates" | "verifies_near" | "verifies_far" | "verifies_delayed";
  evidenceRefs: readonly string[];
}

export function deriveErrorConsumerActions(
  projection: ErrorPatternProjection,
  at: string,
): ErrorConsumerAction[] {
  const evidenceRefs = projection.effectiveEvidenceIds.map((id) => `error-evidence://${id}`);
  const actions: ErrorConsumerAction[] = [
    { consumer: "teacher_review",action: "show_evidence_timeline",evidenceRefs },
    { consumer: "content_insight",action: "aggregate_authorized_evidence",evidenceRefs },
  ];
  if (projection.state === "suspected") {
    actions.push(
      { consumer: "diagnostic_planner",action: "next_probe",questionRole: "discriminates",evidenceRefs },
      { consumer: "teaching",action: "contrast_without_label",evidenceRefs },
      { consumer: "selection",action: "select_discriminating_question",questionRole: "discriminates",evidenceRefs },
      { consumer: "report",action: "show_needs_confirmation",evidenceRefs },
    );
  } else if (projection.state === "confirmed") {
    actions.push(
      { consumer: "diagnostic_planner",action: "conclude",evidenceRefs },
      { consumer: "teaching",action: "apply_remediation",questionRole: "remediates",evidenceRefs },
      { consumer: "selection",action: "select_remediation_question",questionRole: "remediates",evidenceRefs },
      { consumer: "verification",action: "schedule_near_transfer",questionRole: "verifies_near",evidenceRefs },
      { consumer: "report",action: "show_current_behavior_and_next_step",evidenceRefs },
    );
  } else if (projection.state === "improving") {
    actions.push(
      { consumer: "teaching",action: "reduce_explanation",evidenceRefs },
      { consumer: "selection",action: "select_far_or_delayed_verification",questionRole: "verifies_far",evidenceRefs },
      { consumer: "verification",action: "complete_verification_set",questionRole: "verifies_far",evidenceRefs },
      { consumer: "report",action: "show_progress",evidenceRefs },
    );
  } else if (projection.state === "resolved") {
    const due = projection.verificationDueAt !== undefined && projection.verificationDueAt <= at;
    actions.push(
      { consumer: "teaching",action: "avoid_repeating_label",evidenceRefs },
      { consumer: "selection",action: due ? "select_delayed_verification" : "no_error_driven_question",...(due ? { questionRole: "verifies_delayed" as const } : {}),evidenceRefs },
      { consumer: "verification",action: due ? "verify_now" : "wait_until_due",...(due ? { questionRole: "verifies_delayed" as const } : {}),evidenceRefs },
      { consumer: "report",action: "hide_by_default",evidenceRefs },
    );
  } else {
    actions.push(
      { consumer: "diagnostic_planner",action: "ignore_superseded_definition",evidenceRefs },
      { consumer: "teaching",action: "ignore_superseded_definition",evidenceRefs },
      { consumer: "selection",action: "ignore_superseded_definition",evidenceRefs },
      { consumer: "verification",action: "cancel_superseded_verification",evidenceRefs },
      { consumer: "report",action: "hide_superseded_definition",evidenceRefs },
    );
  }
  return actions;
}
