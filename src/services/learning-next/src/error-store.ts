import type pg from "pg";
import {
  ERROR_REDUCER_POLICY_REF,
  compileDiagnosisOutcome,
  deriveErrorConsumerActions,
  replayErrorPattern,
  type DiagnosisRelation,
  type ErrorConsumerAction,
  type ErrorEvidence,
  type ErrorEvidenceKind,
  type ErrorPatternProjection,
  type ErrorReducerPolicy,
  type ErrorVerificationPolicy,
} from "./error-core.ts";

export interface ErrorCommitInput {
  tenantId: string;
  questionSessionId: string;
  frozenAttemptSequence: number;
  projectedAt: string;
}

export interface ErrorCommitResult {
  errorEvidenceRefs: string[];
  errorPatternProjectionRefs: string[];
}

interface SessionRow {
  source: "catalog" | "student_external" | "generated_provisional";
  frozen_measurement_contract: Record<string,unknown>;
}

interface OutcomeRow {
  diagnostic_outcome_id: string;
  diagnostic_claim_id: string;
  rule_revision_id: string;
  outcome_bin_id: string;
  outcome_quality: "weak" | "strong" | "decisive";
  outcome_evidence_refs: string[];
  outcome_created_at: Date | string;
  supersedes_diagnostic_outcome_id: string | null;
  student_id: string;
  active_rule_revision_id: string;
  judgment_id: string;
  verdict: "correct" | "partially_correct" | "incorrect" | "unresolved";
  uncertainty: "low" | "medium" | "high";
  judgment_evidence_refs: string[];
  model_id: string;
  prompt_version: string;
  attempt_id: string;
  attempt_kind: "answer" | "probe" | "correction" | "explanation";
  hint_level: number;
  attempt_content_refs: string[];
  question_revision_id: string;
}

interface EvidenceRow {
  error_evidence_id: string;
  student_id: string;
  error_cause_revision_id: string;
  error_cause_id: string;
  diagnostic_claim_id: string | null;
  question_session_id: string;
  question_revision_id: string;
  relation: ErrorEvidence["relation"];
  kind: ErrorEvidence["kind"];
  quality: ErrorEvidence["quality"];
  independent: boolean;
  hint_level: number;
  eligibility: ErrorEvidence["eligibility"];
  context_facets: Record<string,string>;
  evidence_refs: string[];
  rule_revision_id: string | null;
  judgment_id: string | null;
  model_id: string | null;
  prompt_version: string | null;
  policy_version: string;
  created_at: Date | string;
  supersedes_error_evidence_id: string | null;
  fact_version: string;
}

interface DefinitionRow {
  error_cause_id: string;
  error_cause_revision_id: string;
  revision_no: number;
  accepted_verification_sets: unknown;
  confirmed_near_due_days: number;
  improving_followup_due_days: number;
  resolved_delayed_due_days: number;
  superseded_by_error_cause_revision_id: string | null;
}

const record = (value: unknown, label: string): Record<string,unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string,unknown>;
};

const array = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
};

const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
  return value;
};

const integer = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${label} must be an integer`);
  return value;
};

const requiredTrue = (value: unknown, label: string): true => {
  if (value !== true) throw new Error(`${label} must remain true`);
  return true;
};

const iso = (value: Date | string): string => new Date(value).toISOString();
const unique = (values: readonly string[]): string[] => [...new Set(values)];

type VerificationKind = "near_transfer" | "far_transfer" | "delayed_verification";
const parseVerificationSets = (value: unknown, label: string): VerificationKind[][] =>
  array(value,label).map((entry,index) => {
    const values = array(entry,`${label}[${index}]`).map((kind) => text(kind,"verification kind"));
    if (values.length < 2 || values.some((kind) =>
      kind !== "near_transfer" && kind !== "far_transfer" && kind !== "delayed_verification")) {
      throw new Error(`${label}[${index}] is not a supported verification set`);
    }
    if (values.length !== new Set(values).size) throw new Error(`${label}[${index}] contains duplicates`);
    return values as VerificationKind[];
  });

const parseReducerPolicy = (configuration: unknown, expectedRef: string): ErrorReducerPolicy => {
  const root = record(configuration,"ErrorReducerPolicy");
  const confirmation = record(root.confirmation,"confirmation");
  const improvement = record(root.improvement,"improvement");
  const resolution = record(root.resolution,"resolution");
  const recurrence = record(root.recurrence,"recurrence");
  const exclusions = record(root.exclusions,"exclusions");
  const supersession = record(root.supersession,"supersession");
  const policyId = text(root.policy_id,"policy_id");
  const policyVersion = integer(root.policy_version,"policy_version");
  const minimumQuality = text(recurrence.minimum_support_quality,"minimum support quality");
  if (`${policyId}@${policyVersion}` !== expectedRef
      || improvement.required_counter_kind !== "near_transfer"
      || minimumQuality !== "strong" && minimumQuality !== "decisive") {
    throw new Error("unsupported ErrorReducerPolicy configuration");
  }
  return {
    policyId,
    policyVersion,
    independentSessionSupports: integer(confirmation.independent_session_supports,"independent session supports"),
    decisiveRequiresAdditionalIndependentSupport: requiredTrue(
      confirmation.decisive_requires_additional_independent_support,
      "decisive additional support",
    ),
    improvementRequiredCounterKind: "near_transfer",
    improvementRequiresIndependent: requiredTrue(improvement.require_independent,"improvement independence"),
    acceptedVerificationSets: parseVerificationSets(resolution.accepted_verification_sets,"accepted verification sets"),
    recurrenceMinimumSupportQuality: minimumQuality,
    excludeProvisional: requiredTrue(exclusions.provisional,"provisional exclusion"),
    excludeNonDiscriminating: requiredTrue(exclusions.non_discriminating,"non-discriminating exclusion"),
    excludeSameQuestionPromptedCorrection: requiredTrue(
      exclusions.same_question_prompted_correction,
      "prompted correction exclusion",
    ),
    excludeReplacedFacts: requiredTrue(supersession.exclude_replaced_facts,"replaced fact exclusion"),
  };
};

const loadReducerPolicy = async (client: pg.PoolClient): Promise<ErrorReducerPolicy> => {
  const result = await client.query<{ configuration: unknown }>(
    "select configuration from science_v3_error_reducer_policy where policy_ref=$1",
    [ERROR_REDUCER_POLICY_REF],
  );
  if (!result.rows[0]) throw new Error(`ErrorReducerPolicy ${ERROR_REDUCER_POLICY_REF} is not published`);
  return parseReducerPolicy(result.rows[0].configuration,ERROR_REDUCER_POLICY_REF);
};

const contextFacets = (contract: Record<string,unknown>, source: string): Record<string,string> => {
  const raw = contract.context_facets;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { source };
  const facets = Object.fromEntries(Object.entries(raw)
    .filter((entry): entry is [string,string] => typeof entry[1] === "string")
    .slice(0,23));
  return { source,...facets };
};

const evidenceKind = (attemptKind: OutcomeRow["attempt_kind"]): ErrorEvidenceKind => {
  if (attemptKind === "probe") return "probe";
  if (attemptKind === "correction") return "self_correction";
  if (attemptKind === "explanation") return "explanation";
  return "spontaneous_error";
};

const verificationKind = (roles: readonly string[]): VerificationKind | undefined => {
  const mapped: VerificationKind[] = roles.flatMap((role): VerificationKind[] => {
    if (role === "verifies_near") return ["near_transfer"];
    if (role === "verifies_far") return ["far_transfer"];
    if (role === "verifies_delayed") return ["delayed_verification"];
    return [];
  });
  const kinds: VerificationKind[] = [...new Set<VerificationKind>(mapped)];
  if (kinds.length > 1) throw new Error("question has ambiguous verification roles for one error cause");
  return kinds[0];
};

const compileErrorFacts = async (
  client: pg.PoolClient,
  input: ErrorCommitInput,
  session: SessionRow,
): Promise<void> => {
  const outcomes = await client.query<OutcomeRow>(
    `select o.diagnostic_outcome_id,o.diagnostic_claim_id,o.rule_revision_id,o.outcome_bin_id,
            bin.quality as outcome_quality,o.evidence_refs as outcome_evidence_refs,
            o.created_at as outcome_created_at,o.supersedes_diagnostic_outcome_id,
            claim.student_id,claim.active_rule_revision_id,j.judgment_id,j.verdict,j.uncertainty,
            j.evidence_refs as judgment_evidence_refs,j.model_id,j.prompt_version,
            a.attempt_id,a.kind as attempt_kind,a.hint_level,a.content_refs as attempt_content_refs,
            a.question_revision_id
       from science_v3_diagnosis_outcome o
       join science_v3_diagnostic_claim claim
         on claim.tenant_id=o.tenant_id and claim.diagnostic_claim_id=o.diagnostic_claim_id
       join science_v3_diagnosis_outcome_bin bin
         on bin.tenant_id=o.tenant_id and bin.rule_revision_id=o.rule_revision_id
        and bin.outcome_bin_id=o.outcome_bin_id
       join science_v3_judgment j
         on j.tenant_id=o.tenant_id and j.judgment_id=o.judgment_id
       join science_v3_attempt a
         on a.tenant_id=j.tenant_id and a.attempt_id=j.attempt_id
      where o.tenant_id=$1 and claim.question_session_id=$2 and a.session_sequence <= $3
        and not exists (
          select 1 from science_v3_diagnosis_outcome newer
           where newer.tenant_id=o.tenant_id
             and newer.supersedes_diagnostic_outcome_id=o.diagnostic_outcome_id
        )
        and not exists (
          select 1 from science_v3_judgment newer_j
           where newer_j.tenant_id=j.tenant_id and newer_j.supersedes_judgment_id=j.judgment_id
        )
        and not exists (
          select 1 from science_v3_attempt newer_a
           where newer_a.tenant_id=a.tenant_id and newer_a.supersedes_attempt_id=a.attempt_id
        )
      order by o.created_at,o.diagnostic_outcome_id`,
    [input.tenantId,input.questionSessionId,input.frozenAttemptSequence],
  );
  const frozenRules = array(session.frozen_measurement_contract.diagnosis_rule_revision_ids,"frozen diagnosis rules")
    .map((value) => text(value,"frozen diagnosis rule"));
  const facets = contextFacets(session.frozen_measurement_contract,session.source);

  for (const row of outcomes.rows) {
    if (row.active_rule_revision_id !== row.rule_revision_id) {
      throw new Error("diagnosis outcome does not use the DiagnosticClaim active rule");
    }
    const candidates = await client.query<{ error_cause_revision_id: string }>(
      `select error_cause_revision_id from science_v3_diagnostic_claim_candidate
        where tenant_id=$1 and diagnostic_claim_id=$2 order by position`,
      [input.tenantId,row.diagnostic_claim_id],
    );
    const candidateIds = candidates.rows.map((candidate) => candidate.error_cause_revision_id);
    const relations = await client.query<{
      error_cause_revision_id: string;
      relation: DiagnosisRelation["relation"];
    }>(
      `select error_cause_revision_id,relation from science_v3_diagnosis_outcome_relation
        where tenant_id=$1 and rule_revision_id=$2 and outcome_bin_id=$3
          and error_cause_revision_id=any($4::text[])
        order by error_cause_revision_id`,
      [input.tenantId,row.rule_revision_id,row.outcome_bin_id,candidateIds],
    );
    const roles = await client.query<{ error_cause_revision_id: string; role: string }>(
      `select error_cause_revision_id,role from science_v3_question_error_role
        where tenant_id=$1 and question_revision_id=$2
          and error_cause_revision_id=any($3::text[])
        order by error_cause_revision_id,role`,
      [input.tenantId,row.question_revision_id,candidateIds],
    );
    const rolesByCandidate = new Map<string,string[]>();
    for (const role of roles.rows) {
      const values = rolesByCandidate.get(role.error_cause_revision_id) ?? [];
      values.push(role.role);
      rolesByCandidate.set(role.error_cause_revision_id,values);
    }
    const mappedRelations: DiagnosisRelation[] = relations.rows.map((relation) => {
      const kind = verificationKind(rolesByCandidate.get(relation.error_cause_revision_id) ?? []);
      return {
        errorCauseRevisionId: relation.error_cause_revision_id,
        relation: relation.relation,
        ...(kind ? { kind } : {}),
      };
    });
    const published = await client.query<{ ready: boolean; policy_count: number }>(
      `select exists(
          select 1 from content_entity_revision
           where tenant_id=$1 and revision_id=$2 and lifecycle_status='ready'
        ) as ready,
        (select count(*)::int from science_v3_error_cause_policy
          where tenant_id=$1 and error_cause_revision_id=any($3::text[])) as policy_count`,
      [input.tenantId,row.rule_revision_id,candidateIds],
    );
    const status = published.rows[0];
    const facts = compileDiagnosisOutcome({
      tenantId: input.tenantId,
      studentId: row.student_id,
      diagnosticClaimId: row.diagnostic_claim_id,
      questionSessionId: input.questionSessionId,
      questionRevisionId: row.question_revision_id,
      source: session.source,
      candidateErrorCauseRevisionIds: candidateIds,
      activeRuleRevisionId: row.rule_revision_id,
      frozenRuleRevisionIds: frozenRules,
      rulePublished: status?.ready === true && status.policy_count === candidateIds.length,
      outcomeBinId: row.outcome_bin_id,
      outcomeQuality: row.outcome_quality,
      relations: mappedRelations,
      kind: evidenceKind(row.attempt_kind),
      independent: row.hint_level === 0,
      hintLevel: row.hint_level,
      contextFacets: facets,
      evidenceRefs: unique([...row.attempt_content_refs,...row.judgment_evidence_refs,...row.outcome_evidence_refs]),
      judgmentId: row.judgment_id,
      judgmentResolved: row.verdict !== "unresolved",
      judgmentUncertainty: row.uncertainty,
      modelId: row.model_id,
      promptVersion: row.prompt_version,
      occurredAt: iso(row.outcome_created_at),
      policyVersion: ERROR_REDUCER_POLICY_REF,
    });
    for (const fact of facts) {
      const predecessor = row.supersedes_diagnostic_outcome_id
        ? await client.query<{ error_evidence_id: string; fact_version: string }>(
          `select evidence.error_evidence_id,evidence.fact_version
             from science_v3_diagnosis_outcome previous
             join science_v3_error_evidence evidence
               on evidence.tenant_id=previous.tenant_id
              and evidence.diagnostic_claim_id=previous.diagnostic_claim_id
              and evidence.judgment_id=previous.judgment_id
            where previous.tenant_id=$1 and previous.diagnostic_outcome_id=$2
              and evidence.error_cause_revision_id=$3
            order by evidence.fact_version desc limit 1`,
          [input.tenantId,row.supersedes_diagnostic_outcome_id,fact.errorCauseRevisionId],
        )
        : { rows: [] as Array<{ error_evidence_id: string; fact_version: string }> };
      const previous = predecessor.rows[0];
      await client.query(
        `insert into science_v3_error_evidence(
           error_evidence_id,tenant_id,student_id,error_cause_revision_id,diagnostic_claim_id,
           question_session_id,question_revision_id,relation,kind,quality,independent,hint_level,
           eligibility,context_facets,evidence_refs,rule_revision_id,judgment_id,model_id,
           prompt_version,policy_version,created_at,supersedes_error_evidence_id,fact_version
         ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20,$21,$22,$23)
         on conflict(error_evidence_id) do nothing`,
        [fact.errorEvidenceId,input.tenantId,fact.studentId,fact.errorCauseRevisionId,
          fact.diagnosticClaimId ?? null,fact.questionSessionId,fact.questionRevisionId,
          fact.relation,fact.kind,fact.quality,fact.independent,fact.hintLevel,fact.eligibility,
          JSON.stringify(fact.contextFacets),fact.evidenceRefs,fact.ruleRevisionId ?? null,
          fact.judgmentId ?? null,fact.modelId ?? null,fact.promptVersion ?? null,
          fact.policyVersion,fact.createdAt,previous?.error_evidence_id ?? null,
          previous ? Number(previous.fact_version)+1 : 1],
      );
    }
  }
};

const evidenceFromRow = (row: EvidenceRow): ErrorEvidence => ({
  errorEvidenceId: row.error_evidence_id,
  studentId: row.student_id,
  errorCauseRevisionId: row.error_cause_revision_id,
  ...(row.diagnostic_claim_id ? { diagnosticClaimId: row.diagnostic_claim_id } : {}),
  questionSessionId: row.question_session_id,
  questionRevisionId: row.question_revision_id,
  relation: row.relation,
  kind: row.kind,
  quality: row.quality,
  independent: row.independent,
  hintLevel: row.hint_level,
  eligibility: row.eligibility,
  contextFacets: row.context_facets,
  evidenceRefs: row.evidence_refs,
  ...(row.rule_revision_id ? { ruleRevisionId: row.rule_revision_id } : {}),
  ...(row.judgment_id ? { judgmentId: row.judgment_id } : {}),
  ...(row.model_id ? { modelId: row.model_id } : {}),
  ...(row.prompt_version ? { promptVersion: row.prompt_version } : {}),
  policyVersion: row.policy_version,
  createdAt: iso(row.created_at),
  ...(row.supersedes_error_evidence_id
    ? { supersedesErrorEvidenceId: row.supersedes_error_evidence_id }
    : {}),
  factVersion: Number(row.fact_version),
});

const loadReplayEvidence = async (
  client: pg.PoolClient,
  tenantId: string,
  studentId: string,
): Promise<EvidenceRow[]> => {
  const result = await client.query<EvidenceRow>(
    `select evidence.*,entity.entity_id as error_cause_id
       from science_v3_error_evidence evidence
       join content_entity_revision revision
         on revision.tenant_id=evidence.tenant_id
        and revision.revision_id=evidence.error_cause_revision_id
       join content_entity entity
         on entity.tenant_id=revision.tenant_id and entity.entity_id=revision.entity_id
      where evidence.tenant_id=$1 and evidence.student_id=$2
        and (
          evidence.judgment_id is null or not exists (
            select 1 from science_v3_judgment newer_j
             where newer_j.tenant_id=evidence.tenant_id
               and newer_j.supersedes_judgment_id=evidence.judgment_id
          )
        )
        and (
          evidence.judgment_id is null or not exists (
            select 1 from science_v3_judgment source_j
            join science_v3_attempt newer_a
              on newer_a.tenant_id=source_j.tenant_id
             and newer_a.supersedes_attempt_id=source_j.attempt_id
           where source_j.tenant_id=evidence.tenant_id
             and source_j.judgment_id=evidence.judgment_id
          )
        )
      order by evidence.created_at,evidence.error_evidence_id`,
    [tenantId,studentId],
  );
  return result.rows;
};

const verificationPolicy = (row: DefinitionRow): ErrorVerificationPolicy => ({
  acceptedVerificationSets: parseVerificationSets(
    row.accepted_verification_sets,
    `VerificationPolicy ${row.error_cause_revision_id}`,
  ),
  confirmedNearDueDays: row.confirmed_near_due_days,
  improvingFollowupDueDays: row.improving_followup_due_days,
  resolvedDelayedDueDays: row.resolved_delayed_due_days,
});

const projectErrorPatterns = async (
  client: pg.PoolClient,
  input: ErrorCommitInput,
  studentId: string,
): Promise<string[]> => {
  const reducerPolicy = await loadReducerPolicy(client);
  const rows = await loadReplayEvidence(client,input.tenantId,studentId);
  const definitions = await client.query<DefinitionRow>(
    `select entity.entity_id as error_cause_id,policy.error_cause_revision_id,
            revision.revision_no,policy.accepted_verification_sets,
            policy.confirmed_near_due_days,policy.improving_followup_due_days,
            policy.resolved_delayed_due_days,policy.superseded_by_error_cause_revision_id
       from science_v3_error_cause_policy policy
       join content_entity_revision revision
         on revision.tenant_id=policy.tenant_id
        and revision.revision_id=policy.error_cause_revision_id
       join content_entity entity
         on entity.tenant_id=revision.tenant_id and entity.entity_id=revision.entity_id
      where policy.tenant_id=$1
      order by entity.entity_id,revision.revision_no desc`,
    [input.tenantId],
  );
  const definitionByCause = new Map<string,DefinitionRow>();
  for (const definition of definitions.rows) {
    if (!definitionByCause.has(definition.error_cause_id)) {
      definitionByCause.set(definition.error_cause_id,definition);
    }
  }
  const grouped = new Map<string,EvidenceRow[]>();
  for (const row of rows) {
    const values = grouped.get(row.error_cause_id) ?? [];
    values.push(row);
    grouped.set(row.error_cause_id,values);
  }
  const existing = await client.query<{ error_cause_id: string; projection_version: string }>(
    `select error_cause_id,projection_version from science_v3_error_pattern_projection
      where tenant_id=$1 and student_id=$2`,
    [input.tenantId,studentId],
  );
  const existingVersion = new Map(existing.rows.map((row) => [row.error_cause_id,Number(row.projection_version)]));
  for (const row of existing.rows) {
    if (!grouped.has(row.error_cause_id)) grouped.set(row.error_cause_id,[]);
  }

  const refs: string[] = [];
  for (const [errorCauseId,facts] of grouped) {
    if (!/^E_[A-Z0-9_]{2,}$/.test(errorCauseId)) {
      throw new Error(`error cause ${errorCauseId} is not a canonical science-v3 E identity`);
    }
    const definition = definitionByCause.get(errorCauseId);
    if (!definition) {
      await client.query(
        `delete from science_v3_error_pattern_projection
          where tenant_id=$1 and student_id=$2 and error_cause_id=$3`,
        [input.tenantId,studentId,errorCauseId],
      );
      continue;
    }
    const replay = replayErrorPattern({
      studentId,
      errorCauseId,
      activeDefinitionRevisionId: definition.error_cause_revision_id,
      facts: facts.map(evidenceFromRow),
      reducerPolicy,
      verificationPolicy: verificationPolicy(definition),
      projectedAt: input.projectedAt,
      projectionVersion: (existingVersion.get(errorCauseId) ?? 0)+1,
      ...(definition.superseded_by_error_cause_revision_id
        ? { supersededByErrorCauseRevisionId: definition.superseded_by_error_cause_revision_id }
        : {}),
    });
    if (!replay.projection) {
      await client.query(
        `delete from science_v3_error_pattern_projection
          where tenant_id=$1 and student_id=$2 and error_cause_id=$3`,
        [input.tenantId,studentId,errorCauseId],
      );
      continue;
    }
    for (const event of replay.recurrenceEvents) {
      await client.query(
        `insert into science_v3_error_recurrence_event(
           recurrence_event_id,tenant_id,student_id,error_cause_id,
           trigger_error_evidence_id,recurrence_number,occurred_at,policy_version
         ) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(recurrence_event_id) do nothing`,
        [event.recurrenceEventId,input.tenantId,event.studentId,event.errorCauseId,
          event.triggerErrorEvidenceId,event.recurrenceNumber,event.occurredAt,event.policyVersion],
      );
    }
    const projection = replay.projection;
    await client.query(
      `insert into science_v3_error_pattern_projection(
         tenant_id,student_id,error_cause_id,active_definition_revision_id,state,
         support_count,counter_count,independent_session_count,recurrence_count,
         verification_due_at,effective_evidence_ids,superseded_by_error_cause_revision_id,
         policy_version,projection_version,projector_version,projected_at
       ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       on conflict(tenant_id,student_id,error_cause_id) do update
         set active_definition_revision_id=excluded.active_definition_revision_id,
             state=excluded.state,support_count=excluded.support_count,
             counter_count=excluded.counter_count,
             independent_session_count=excluded.independent_session_count,
             recurrence_count=excluded.recurrence_count,
             verification_due_at=excluded.verification_due_at,
             effective_evidence_ids=excluded.effective_evidence_ids,
             superseded_by_error_cause_revision_id=excluded.superseded_by_error_cause_revision_id,
             policy_version=excluded.policy_version,
             projection_version=science_v3_error_pattern_projection.projection_version+1,
             projector_version=excluded.projector_version,projected_at=excluded.projected_at`,
      [input.tenantId,projection.studentId,projection.errorCauseId,
        projection.activeDefinitionRevisionId,projection.state,projection.supportCount,
        projection.counterCount,projection.independentSessionCount,projection.recurrenceCount,
        projection.verificationDueAt ?? null,projection.effectiveEvidenceIds,
        projection.supersededByErrorCauseRevisionId ?? null,projection.policyVersion,
        projection.projectionVersion,projection.projectorVersion,projection.projectedAt],
    );
    refs.push(`error-pattern-projection:${studentId}:${errorCauseId}`);
  }
  return refs.sort();
};

export async function compileAndProjectErrors(
  client: pg.PoolClient,
  input: ErrorCommitInput,
  studentId: string,
): Promise<ErrorCommitResult> {
  const session = await client.query<SessionRow>(
    `select source,frozen_measurement_contract from science_v3_question_session
      where tenant_id=$1 and question_session_id=$2 and student_id=$3`,
    [input.tenantId,input.questionSessionId,studentId],
  );
  const row = session.rows[0];
  if (!row) throw new Error("QuestionSession is missing during error-evidence commit");
  await compileErrorFacts(client,input,row);
  const errorPatternProjectionRefs = await projectErrorPatterns(client,input,studentId);
  const evidence = await client.query<{ error_evidence_id: string }>(
    `select error_evidence_id from science_v3_error_evidence
      where tenant_id=$1 and question_session_id=$2
        and not exists(
          select 1 from science_v3_error_evidence newer
           where newer.tenant_id=science_v3_error_evidence.tenant_id
             and newer.supersedes_error_evidence_id=science_v3_error_evidence.error_evidence_id
        )
      order by created_at,error_evidence_id`,
    [input.tenantId,input.questionSessionId],
  );
  return {
    errorEvidenceRefs: evidence.rows.map((item) => `error-evidence://${item.error_evidence_id}`),
    errorPatternProjectionRefs,
  };
}

export async function loadErrorConsumerActions(
  client: pg.PoolClient,
  tenantId: string,
  studentId: string,
  at: string,
): Promise<Array<{ errorCauseId: string; actions: ErrorConsumerAction[] }>> {
  const result = await client.query<{
    error_cause_id: string;
    active_definition_revision_id: string;
    state: ErrorPatternProjection["state"];
    support_count: number;
    counter_count: number;
    independent_session_count: number;
    recurrence_count: number;
    verification_due_at: Date | string | null;
    effective_evidence_ids: string[];
    superseded_by_error_cause_revision_id: string | null;
    policy_version: string;
    projection_version: string;
    projector_version: string;
    projected_at: Date | string;
  }>(
    `select * from science_v3_error_pattern_projection
      where tenant_id=$1 and student_id=$2 order by error_cause_id`,
    [tenantId,studentId],
  );
  return result.rows.map((row) => {
    const projection: ErrorPatternProjection = {
      studentId,
      errorCauseId: row.error_cause_id,
      activeDefinitionRevisionId: row.active_definition_revision_id,
      state: row.state,
      supportCount: row.support_count,
      counterCount: row.counter_count,
      independentSessionCount: row.independent_session_count,
      recurrenceCount: row.recurrence_count,
      ...(row.verification_due_at ? { verificationDueAt: iso(row.verification_due_at) } : {}),
      effectiveEvidenceIds: row.effective_evidence_ids,
      ...(row.superseded_by_error_cause_revision_id
        ? { supersededByErrorCauseRevisionId: row.superseded_by_error_cause_revision_id }
        : {}),
      policyVersion: row.policy_version,
      projectionVersion: Number(row.projection_version),
      projectorVersion: row.projector_version,
      projectedAt: iso(row.projected_at),
    };
    return { errorCauseId: row.error_cause_id,actions: deriveErrorConsumerActions(projection,at) };
  });
}

export async function loadErrorEvidenceForLight(
  client: pg.PoolClient,
  tenantId: string,
  questionSessionId: string,
): Promise<ErrorEvidence[]> {
  const result = await client.query<EvidenceRow>(
    `select evidence.*,entity.entity_id as error_cause_id
       from science_v3_error_evidence evidence
       join content_entity_revision revision
         on revision.tenant_id=evidence.tenant_id
        and revision.revision_id=evidence.error_cause_revision_id
       join content_entity entity
         on entity.tenant_id=revision.tenant_id and entity.entity_id=revision.entity_id
      where evidence.tenant_id=$1 and evidence.question_session_id=$2
      order by evidence.created_at,evidence.error_evidence_id`,
    [tenantId,questionSessionId],
  );
  return result.rows.map(evidenceFromRow);
}
