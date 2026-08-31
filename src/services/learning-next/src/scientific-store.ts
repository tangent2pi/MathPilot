import type pg from "pg";
import {
  EVIDENCE_POLICY_REF,
  MASTERY_PARAMETER_SET_ID,
  RETENTION_PARAMETER_SET_ID,
  SCIENTIFIC_PROJECTOR_VERSION,
  compileDelayedReview,
  compileJudgment,
  replayMastery,
  replayRetention,
  type BktParameters,
  type CompiledObservation,
  type EvidencePolicy,
  type JudgmentCompilationContext,
  type MeasurementTarget,
  type RetentionParameters,
  type RetentionReview,
  type RubricResult,
  type DimensionProposal,
} from "./scientific-core.ts";

export interface ScientificCommitInput {
  tenantId: string;
  questionSessionId: string;
  frozenAttemptSequence: number;
  projectedAt: string;
}

export interface ScientificCommitResult {
  observationRefs: string[];
  masteryProjectionRefs: string[];
  retentionProjectionRefs: string[];
}

interface SessionRow {
  student_id: string;
  question_revision_id: string | null;
  source: JudgmentCompilationContext["source"];
  frozen_measurement_contract: Record<string, unknown>;
}

interface JudgmentRow {
  judgment_id: string;
  verdict: JudgmentCompilationContext["judgment"]["verdict"];
  rubric_results: unknown;
  dimension_proposals: unknown;
  uncertainty: JudgmentCompilationContext["judgment"]["uncertainty"];
  evidence_refs: string[];
  judgment_fact_version: string;
  supersedes_judgment_id: string | null;
  attempt_id: string;
  kind: JudgmentCompilationContext["attempt"]["kind"];
  hint_level: number;
  content_refs: string[];
  submitted_at: Date | string;
  supersedes_attempt_id: string | null;
}

interface TargetRow {
  measurement_rule_id: string;
  dimension_revision_id: string;
  evidence_rule: string;
}

interface ActiveObservationRow {
  observation_id: string;
  student_id: string;
  dimension_revision_id: string;
  question_session_id: string;
  question_revision_id: string;
  judgment_id: string;
  outcome: "success" | "failure";
  measurement_rule_id: string;
  evidence_refs: string[];
  occurred_at: Date | string;
  policy_version: string;
}

interface ActiveLearningRow {
  learning_opportunity_id: string;
  dimension_revision_ids: string[];
  question_revision_id: string;
  occurred_at: Date | string;
}

interface UnitRow {
  retention_unit_revision_id: string;
  dimension_revision_id: string;
  scope_facets: Record<string, string>;
  question_revision_id: string;
  measurement_rule_id: string;
}

interface MasteryFactRow {
  observation_id: string;
  outcome: "success" | "failure";
  occurred_at: Date | string;
  dimension_id: string;
  lineage_version: string;
}

interface DelayedEventRow {
  delayed_review_event_id: string;
  retention_unit_revision_id: string;
  rating: "again" | "good";
  occurred_at: Date | string;
}

const record = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
};

const array = (value: unknown, name: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
};

const text = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value) throw new Error(`${name} must be a non-empty string`);
  return value;
};

const numberValue = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
};

const booleanValue = (value: unknown, name: string): boolean => {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
};

const trueValue = (value: unknown, name: string): true => {
  if (booleanValue(value,name) !== true) throw new Error(`${name} must remain true`);
  return true;
};

const iso = (value: Date | string): string => new Date(value).toISOString();
const unique = (values: readonly string[]): string[] => [...new Set(values)];
const groupingKey = (...values: Array<string | number>): string => values.join("\0");

const parseRubricResults = (value: unknown): RubricResult[] => array(value, "rubric_results").map((item, index) => {
  const entry = record(item, `rubric_results[${index}]`);
  const status = text(entry.status, "rubric status");
  if (status !== "met" && status !== "not_met" && status !== "unclear") throw new Error("invalid rubric status");
  return {
    rubricItemId: text(entry.rubric_item_id, "rubric item ID"),
    status,
    evidenceRefs: array(entry.evidence_refs, "rubric evidence refs").map((ref) => text(ref, "rubric evidence ref")),
  };
});

const parseDimensionProposals = (value: unknown): DimensionProposal[] => array(value, "dimension_proposals").map((item, index) => {
  const entry = record(item, `dimension_proposals[${index}]`);
  const outcome = text(entry.outcome, "dimension outcome");
  if (outcome !== "success" && outcome !== "failure" && outcome !== "unresolved") throw new Error("invalid dimension outcome");
  return {
    dimensionRevisionId: text(entry.dimension_revision_id, "dimension revision ID"),
    rubricItemId: text(entry.rubric_item_id, "rubric item ID"),
    outcome,
  };
});

const parsePolicy = (configuration: unknown, expectedRef: string): EvidencePolicy => {
  const root = record(configuration, "EvidencePolicy");
  const independent = record(root.independent_measurement, "independent_measurement");
  const delayed = record(root.delayed_review, "delayed_review");
  const external = record(root.external_content, "external_content");
  const policyId = text(root.policy_id, "policy_id");
  const policyVersion = numberValue(root.policy_version, "policy_version");
  if (`${policyId}@${policyVersion}` !== expectedRef
      || numberValue(independent.required_hint_level, "required_hint_level") !== 0
      || delayed.success_rating !== "good" || delayed.failure_rating !== "again"
      || external.unverified_measurement !== "reject") {
    throw new Error("unsupported EvidencePolicy configuration");
  }
  return {
    policyId,
    policyVersion,
    requiredHintLevel: 0,
    requireFrozenQuestionRevision: trueValue(independent.require_frozen_question_revision, "require_frozen_question_revision"),
    requireReliableRubric: trueValue(independent.require_reliable_rubric, "require_reliable_rubric"),
    rejectSameQuestionCorrection: trueValue(independent.reject_same_question_correction, "reject_same_question_correction"),
    rejectPriorSolutionExposure: trueValue(independent.reject_prior_solution_exposure, "reject_prior_solution_exposure"),
    excludeSuperseded: trueValue(independent.exclude_superseded, "exclude_superseded"),
    minimumDelayMinutes: numberValue(delayed.minimum_delay_minutes, "minimum_delay_minutes"),
    successRating: "good",
    failureRating: "again",
    unverifiedMeasurement: "reject",
  };
};

const loadPolicy = async (client: pg.PoolClient, policyRef: string): Promise<EvidencePolicy> => {
  const result = await client.query<{ configuration: unknown }>(
    "select configuration from science_v3_evidence_policy where policy_ref=$1",
    [policyRef],
  );
  if (!result.rows[0]) throw new Error(`EvidencePolicy ${policyRef} is not published`);
  return parsePolicy(result.rows[0].configuration, policyRef);
};

const loadMasteryParameters = async (client: pg.PoolClient): Promise<BktParameters> => {
  const result = await client.query<{
    parameters: unknown;
    calibration_status: "prior_only" | "calibrated";
    state_thresholds: unknown;
  }>(
    "select parameters,calibration_status,state_thresholds from science_v3_mastery_parameter_set where parameter_set_id=$1",
    [MASTERY_PARAMETER_SET_ID],
  );
  const row = result.rows[0];
  if (!row) throw new Error("mastery parameter set is not published");
  const parameters = record(row.parameters, "BKT parameters");
  const thresholds = record(row.state_thresholds, "BKT thresholds");
  return {
    parameterSetId: MASTERY_PARAMETER_SET_ID,
    prior: numberValue(parameters.prior, "BKT prior"),
    learn: numberValue(parameters.learn, "BKT learn"),
    slip: numberValue(parameters.slip, "BKT slip"),
    guess: numberValue(parameters.guess, "BKT guess"),
    calibrationStatus: row.calibration_status,
    thresholds: {
      minimumIndependentCount: numberValue(thresholds.minimum_independent_count, "minimum independent count"),
      weak: numberValue(thresholds.weak, "weak threshold"),
      learning: numberValue(thresholds.learning, "learning threshold"),
      mastered: numberValue(thresholds.mastered, "mastered threshold"),
    },
  };
};

const loadRetentionParameters = async (client: pg.PoolClient): Promise<RetentionParameters> => {
  const result = await client.query<{ engine_version: string; parameters: unknown }>(
    "select engine_version,parameters from science_v3_retention_parameter_set where parameter_set_id=$1",
    [RETENTION_PARAMETER_SET_ID],
  );
  const row = result.rows[0];
  if (!row || row.engine_version !== "5.4.1") throw new Error("retention parameter set is not published or uses an unsupported engine");
  const parameters = record(row.parameters, "FSRS parameters");
  const weights = array(parameters.w, "FSRS weights").map((value) => numberValue(value, "FSRS weight"));
  return {
    parameterSetId: RETENTION_PARAMETER_SET_ID,
    engineVersion: "5.4.1",
    parameters: {
      request_retention: numberValue(parameters.request_retention, "request retention"),
      maximum_interval: numberValue(parameters.maximum_interval, "maximum interval"),
      w: weights,
      enable_fuzz: booleanValue(parameters.enable_fuzz, "enable fuzz"),
      enable_short_term: booleanValue(parameters.enable_short_term, "enable short term"),
      learning_steps: array(parameters.learning_steps, "learning steps").map((value) => text(value, "learning step")) as `${number}${"m" | "h" | "d"}`[],
      relearning_steps: array(parameters.relearning_steps, "relearning steps").map((value) => text(value, "relearning step")) as `${number}${"m" | "h" | "d"}`[],
    },
  };
};

const activeObservationSql = `
  not exists (
    select 1 from science_v3_observation newer_o
     where newer_o.tenant_id=o.tenant_id and newer_o.supersedes_observation_id=o.observation_id
  )
  and not exists (
    select 1 from science_v3_judgment newer_j
     where newer_j.tenant_id=j.tenant_id and newer_j.supersedes_judgment_id=j.judgment_id
  )
  and not exists (
    select 1 from science_v3_attempt newer_a
     where newer_a.tenant_id=a.tenant_id and newer_a.supersedes_attempt_id=a.attempt_id
  )`;

const loadActiveObservations = async (client: pg.PoolClient, tenantId: string, studentId: string): Promise<ActiveObservationRow[]> => {
  const result = await client.query<ActiveObservationRow>(
    `select o.observation_id,o.student_id,o.dimension_revision_id,o.question_session_id,
            o.question_revision_id,o.judgment_id,o.outcome,o.measurement_rule_id,
            o.evidence_refs,o.occurred_at,o.policy_version
       from science_v3_observation o
       join science_v3_judgment j on j.tenant_id=o.tenant_id and j.judgment_id=o.judgment_id
       join science_v3_attempt a on a.tenant_id=j.tenant_id and a.attempt_id=j.attempt_id
      where o.tenant_id=$1 and o.student_id=$2 and ${activeObservationSql}
      order by o.occurred_at,o.observation_id`,
    [tenantId, studentId],
  );
  return result.rows;
};

const compileFacts = async (
  client: pg.PoolClient,
  input: ScientificCommitInput,
  session: SessionRow,
  policy: EvidencePolicy,
): Promise<void> => {
  const judgments = await client.query<JudgmentRow>(
    `select j.judgment_id,j.verdict,j.rubric_results,j.dimension_proposals,j.uncertainty,
            j.evidence_refs,j.fact_version as judgment_fact_version,j.supersedes_judgment_id,
            a.attempt_id,a.kind,a.hint_level,a.content_refs,a.submitted_at,a.supersedes_attempt_id
       from science_v3_judgment j
       join science_v3_attempt a on a.tenant_id=j.tenant_id and a.attempt_id=j.attempt_id
      where j.tenant_id=$1 and a.question_session_id=$2 and a.session_sequence <= $3
        and not exists (
          select 1 from science_v3_judgment newer_j
           where newer_j.tenant_id=j.tenant_id and newer_j.supersedes_judgment_id=j.judgment_id
        )
        and not exists (
          select 1 from science_v3_attempt newer_a
           where newer_a.tenant_id=a.tenant_id and newer_a.supersedes_attempt_id=a.attempt_id
        )
      order by a.session_sequence,j.fact_version`,
    [input.tenantId, input.questionSessionId, input.frozenAttemptSequence],
  );
  const targets = session.question_revision_id
    ? await client.query<TargetRow>(
      `select i.item_id as measurement_rule_id,t.dimension_revision_id,t.evidence_rule
         from content_revision_item i
         join content_question_measurement_target t on t.item_id=i.item_id
        where i.tenant_id=$1 and i.revision_id=$2
        order by i.position,i.item_id`,
      [input.tenantId, session.question_revision_id],
    )
    : { rows: [] as TargetRow[] };
  const measurementTargets: MeasurementTarget[] = targets.rows.map((row) => ({
    measurementRuleId: row.measurement_rule_id,
    dimensionRevisionId: row.dimension_revision_id,
    evidenceRule: row.evidence_rule,
  }));
  const frozenDimensions = array(session.frozen_measurement_contract.dimension_revision_ids, "frozen dimensions")
    .map((value) => text(value, "frozen dimension"));
  const measurementEligibility = text(session.frozen_measurement_contract.measurement_eligibility, "measurement eligibility");
  const policyRef = text(session.frozen_measurement_contract.evidence_policy_version, "EvidencePolicy ref");

  for (const row of judgments.rows) {
    const context: JudgmentCompilationContext = {
      tenantId: input.tenantId,
      studentId: session.student_id,
      questionSessionId: input.questionSessionId,
      questionRevisionId: session.question_revision_id,
      source: session.source,
      measurementEligibility,
      frozenDimensionRevisionIds: frozenDimensions,
      evidencePolicyRef: policyRef,
      attempt: {
        attemptId: row.attempt_id,
        kind: row.kind,
        hintLevel: row.hint_level,
        contentRefs: row.content_refs,
        submittedAt: iso(row.submitted_at),
        supersedesAttemptId: row.supersedes_attempt_id,
      },
      judgment: {
        judgmentId: row.judgment_id,
        verdict: row.verdict,
        rubricResults: parseRubricResults(row.rubric_results),
        dimensionProposals: parseDimensionProposals(row.dimension_proposals),
        uncertainty: row.uncertainty,
        evidenceRefs: row.evidence_refs,
        factVersion: Number(row.judgment_fact_version),
        supersedesJudgmentId: row.supersedes_judgment_id,
      },
      measurementTargets,
    };
    const compilation = compileJudgment(context, policy);
    for (const reject of compilation.rejects) {
      await client.query(
        `insert into science_v3_evidence_rejection (
           rejection_id,tenant_id,judgment_id,attempt_id,dimension_revision_id,
           rejection_code,policy_version,detail
         ) values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (rejection_id) do nothing`,
        [reject.rejectionId,input.tenantId,reject.judgmentId,reject.attemptId,
          reject.dimensionRevisionId,reject.code,reject.policyVersion,reject.detail],
      );
    }
    for (const opportunity of compilation.learningOpportunities) {
      await client.query(
        `insert into science_v3_learning_opportunity (
           learning_opportunity_id,tenant_id,student_id,judgment_id,dimension_revision_ids,
           question_session_id,intervention_kind,hint_level,evidence_refs,occurred_at,fact_version
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1)
         on conflict (tenant_id,judgment_id) do nothing`,
        [opportunity.learningOpportunityId,input.tenantId,opportunity.studentId,row.judgment_id,
          opportunity.dimensionRevisionIds,opportunity.questionSessionId,opportunity.interventionKind,
          opportunity.hintLevel,opportunity.evidenceRefs,opportunity.occurredAt],
      );
    }
    for (const observation of compilation.observations) {
      const predecessor = row.supersedes_judgment_id
        ? await client.query<{ observation_id: string; fact_version: string }>(
          `select observation_id,fact_version from science_v3_observation
            where tenant_id=$1 and judgment_id=$2 and dimension_revision_id=$3 and measurement_rule_id=$4
            order by fact_version desc limit 1`,
          [input.tenantId,row.supersedes_judgment_id,observation.dimensionRevisionId,observation.measurementRuleId],
        )
        : { rows: [] as Array<{ observation_id: string; fact_version: string }> };
      const previous = predecessor.rows[0];
      await client.query(
        `insert into science_v3_observation (
           observation_id,tenant_id,student_id,dimension_revision_id,question_session_id,
           question_revision_id,judgment_id,outcome,eligibility,measurement_rule_id,
           hint_level,evidence_refs,occurred_at,policy_version,supersedes_observation_id,fact_version
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,'independent_measurement',$9,0,$10,$11,$12,$13,$14)
         on conflict (observation_id) do nothing`,
        [observation.observationId,input.tenantId,observation.studentId,observation.dimensionRevisionId,
          observation.questionSessionId,observation.questionRevisionId,observation.judgmentId,
          observation.outcome,observation.measurementRuleId,observation.evidenceRefs,
          observation.occurredAt,observation.policyVersion,previous?.observation_id ?? null,
          previous ? Number(previous.fact_version) + 1 : 1],
      );
    }
  }
};

const compileDelayedReviews = async (
  client: pg.PoolClient,
  input: ScientificCommitInput,
  studentId: string,
): Promise<Set<string>> => {
  const observations = await loadActiveObservations(client,input.tenantId,studentId);
  const opportunities = await client.query<ActiveLearningRow>(
      `select l.learning_opportunity_id,l.dimension_revision_ids,q.question_revision_id,l.occurred_at
         from science_v3_learning_opportunity l
         join science_v3_judgment j on j.tenant_id=l.tenant_id and j.judgment_id=l.judgment_id
         join science_v3_attempt a on a.tenant_id=j.tenant_id and a.attempt_id=j.attempt_id
         join science_v3_question_session q on q.tenant_id=l.tenant_id and q.question_session_id=l.question_session_id
        where l.tenant_id=$1 and l.student_id=$2
          and q.question_revision_id is not null
          and not exists (
            select 1 from science_v3_judgment newer_j
             where newer_j.tenant_id=j.tenant_id and newer_j.supersedes_judgment_id=j.judgment_id
          )
          and not exists (
            select 1 from science_v3_attempt newer_a
             where newer_a.tenant_id=a.tenant_id and newer_a.supersedes_attempt_id=a.attempt_id
          )`,
      [input.tenantId,studentId],
    );
  const units = await client.query<UnitRow>(
      `select u.retention_unit_revision_id,u.dimension_revision_id,u.scope_facets,
              m.question_revision_id,m.measurement_rule_id
         from science_v3_retention_unit_revision u
         join science_v3_retention_unit_measurement_rule m
           on m.tenant_id=u.tenant_id and m.retention_unit_revision_id=u.retention_unit_revision_id
        where u.tenant_id=$1`,
      [input.tenantId],
    );
  const unitByMeasurement = new Map(units.rows.map((unit) => [
    groupingKey(unit.question_revision_id,unit.measurement_rule_id),unit,
  ]));
  const anchors = new Map<string, Array<{
    id: string;
    kind: "observation" | "learning_opportunity";
    occurredAt: string;
    observation?: ActiveObservationRow;
  }>>();
  for (const observation of observations) {
    const unit = unitByMeasurement.get(groupingKey(observation.question_revision_id,observation.measurement_rule_id));
    if (!unit) continue;
    const values = anchors.get(unit.retention_unit_revision_id) ?? [];
    values.push({ id: observation.observation_id,kind: "observation",occurredAt: iso(observation.occurred_at),observation });
    anchors.set(unit.retention_unit_revision_id,values);
  }
  for (const opportunity of opportunities.rows) {
    for (const unit of units.rows) {
      if (unit.question_revision_id !== opportunity.question_revision_id
          || !opportunity.dimension_revision_ids.includes(unit.dimension_revision_id)) continue;
      const values = anchors.get(unit.retention_unit_revision_id) ?? [];
      values.push({
        id: opportunity.learning_opportunity_id,
        kind: "learning_opportunity",
        occurredAt: iso(opportunity.occurred_at),
      });
      anchors.set(unit.retention_unit_revision_id,values);
    }
  }

  const expectedEventIds = new Set<string>();
  const policies = new Map<string,EvidencePolicy>();
  for (const [unitId, values] of anchors) {
    values.sort((left,right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id));
    for (let index = 1; index < values.length; index += 1) {
      const current = values[index]!;
      if (current.kind !== "observation" || !current.observation) continue;
      const previous = values[index - 1]!;
      const observation: CompiledObservation = {
        observationId: current.observation.observation_id,
        studentId: current.observation.student_id,
        dimensionRevisionId: current.observation.dimension_revision_id,
        questionSessionId: current.observation.question_session_id,
        questionRevisionId: current.observation.question_revision_id,
        judgmentId: current.observation.judgment_id,
        outcome: current.observation.outcome,
        measurementRuleId: current.observation.measurement_rule_id,
        hintLevel: 0,
        evidenceRefs: current.observation.evidence_refs,
        occurredAt: current.occurredAt,
        policyVersion: current.observation.policy_version,
      };
      let policy = policies.get(observation.policyVersion);
      if (!policy) {
        policy = await loadPolicy(client,observation.policyVersion);
        policies.set(observation.policyVersion,policy);
      }
      const event = compileDelayedReview({
        tenantId: input.tenantId,
        studentId,
        retentionUnitRevisionId: unitId,
        observation,
        previousEvidenceId: previous.id,
        previousEvidenceKind: previous.kind,
        previousOccurredAt: previous.occurredAt,
      },policy);
      if (!event) continue;
      expectedEventIds.add(event.delayedReviewEventId);
      const latest = await client.query<{
        delayed_review_event_id: string;
        fact_version: string;
      }>(
        `select delayed_review_event_id,fact_version
           from science_v3_delayed_review_event
          where tenant_id=$1 and observation_id=$2 and retention_unit_revision_id=$3
          order by fact_version desc limit 1`,
        [input.tenantId,event.observationId,event.retentionUnitRevisionId],
      );
      const previousEvent = latest.rows[0];
      if (previousEvent?.delayed_review_event_id === event.delayedReviewEventId) continue;
      await client.query(
        `insert into science_v3_delayed_review_event (
           delayed_review_event_id,tenant_id,student_id,retention_unit_revision_id,
           observation_id,previous_observation_id,previous_learning_opportunity_id,
           rating,elapsed_days,independent,occurred_at,policy_version,
           supersedes_delayed_review_event_id,fact_version
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$11,$12,$13)
         on conflict (delayed_review_event_id) do nothing`,
        [event.delayedReviewEventId,input.tenantId,event.studentId,event.retentionUnitRevisionId,
          event.observationId,event.previousObservationId,event.previousLearningOpportunityId,
          event.rating,event.elapsedDays,event.occurredAt,event.policyVersion,
          previousEvent?.delayed_review_event_id ?? null,
          previousEvent ? Number(previousEvent.fact_version) + 1 : 1],
      );
    }
  }
  return expectedEventIds;
};

const projectMastery = async (
  client: pg.PoolClient,
  input: ScientificCommitInput,
  studentId: string,
): Promise<string[]> => {
  const parameters = await loadMasteryParameters(client);
  const facts = await client.query<MasteryFactRow>(
    `select o.observation_id,o.outcome,o.occurred_at,
            coalesce(dl.dimension_id,e.entity_id) as dimension_id,
            coalesce(dl.lineage_version,r.revision_no) as lineage_version
       from science_v3_observation o
       join science_v3_judgment j on j.tenant_id=o.tenant_id and j.judgment_id=o.judgment_id
       join science_v3_attempt a on a.tenant_id=j.tenant_id and a.attempt_id=j.attempt_id
       join content_entity_revision r on r.tenant_id=o.tenant_id and r.revision_id=o.dimension_revision_id
       join content_entity e on e.tenant_id=r.tenant_id and e.entity_id=r.entity_id
       left join science_v3_dimension_lineage dl
         on dl.tenant_id=o.tenant_id and dl.dimension_revision_id=o.dimension_revision_id
      where o.tenant_id=$1 and o.student_id=$2 and ${activeObservationSql}
      order by o.occurred_at,o.observation_id`,
    [input.tenantId,studentId],
  );
  const grouped = new Map<string,{ dimensionId: string; lineageVersion: number; facts: MasteryFactRow[] }>();
  for (const fact of facts.rows) {
    const lineageVersion = Number(fact.lineage_version);
    const key = groupingKey(fact.dimension_id,lineageVersion);
    const group = grouped.get(key) ?? { dimensionId: fact.dimension_id,lineageVersion,facts: [] };
    group.facts.push(fact);
    grouped.set(key,group);
  }
  const existing = await client.query<{ dimension_id: string; lineage_version: string }>(
    "select dimension_id,lineage_version from science_v3_mastery_projection where tenant_id=$1 and student_id=$2",
    [input.tenantId,studentId],
  );
  for (const row of existing.rows) {
    const lineageVersion = Number(row.lineage_version);
    const key = groupingKey(row.dimension_id,lineageVersion);
    if (!grouped.has(key)) grouped.set(key,{ dimensionId: row.dimension_id,lineageVersion,facts: [] });
  }

  const refs: string[] = [];
  for (const group of grouped.values()) {
    const replay = replayMastery(group.facts.map((fact) => ({
      observationId: fact.observation_id,
      outcome: fact.outcome,
      occurredAt: iso(fact.occurred_at),
      transferEvidence: false,
    })),parameters);
    await client.query(
      `insert into science_v3_mastery_projection (
         tenant_id,student_id,dimension_id,lineage_version,p_mastery,state,
         independent_count,transfer_evidence,parameter_set_id,calibration_status,
         input_observation_ids,projection_version,projector_version,projected_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12,$13)
       on conflict (tenant_id,student_id,dimension_id,lineage_version) do update
         set p_mastery=excluded.p_mastery,state=excluded.state,
             independent_count=excluded.independent_count,transfer_evidence=excluded.transfer_evidence,
             parameter_set_id=excluded.parameter_set_id,calibration_status=excluded.calibration_status,
             input_observation_ids=excluded.input_observation_ids,
             projection_version=science_v3_mastery_projection.projection_version+1,
             projector_version=excluded.projector_version,projected_at=excluded.projected_at`,
      [input.tenantId,studentId,group.dimensionId,group.lineageVersion,replay.pMastery,replay.state,
        replay.independentCount,replay.transferEvidence,parameters.parameterSetId,
        parameters.calibrationStatus,replay.inputObservationIds,SCIENTIFIC_PROJECTOR_VERSION,input.projectedAt],
    );
    refs.push(`mastery-projection:${studentId}:${group.dimensionId}:${group.lineageVersion}`);
  }
  return refs.sort();
};

const projectRetention = async (
  client: pg.PoolClient,
  input: ScientificCommitInput,
  studentId: string,
  expectedEventIds: Set<string>,
): Promise<string[]> => {
  const parameters = await loadRetentionParameters(client);
  const events = await client.query<DelayedEventRow>(
    `select d.delayed_review_event_id,d.retention_unit_revision_id,d.rating,d.occurred_at
       from science_v3_delayed_review_event d
      where d.tenant_id=$1 and d.student_id=$2
        and not exists (
          select 1 from science_v3_delayed_review_event newer
           where newer.tenant_id=d.tenant_id
             and newer.supersedes_delayed_review_event_id=d.delayed_review_event_id
        )
      order by d.occurred_at,d.delayed_review_event_id`,
    [input.tenantId,studentId],
  );
  const grouped = new Map<string,RetentionReview[]>();
  for (const event of events.rows) {
    if (!expectedEventIds.has(event.delayed_review_event_id)) continue;
    const reviews = grouped.get(event.retention_unit_revision_id) ?? [];
    reviews.push({
      delayedReviewEventId: event.delayed_review_event_id,
      rating: event.rating,
      occurredAt: iso(event.occurred_at),
    });
    grouped.set(event.retention_unit_revision_id,reviews);
  }
  const existing = await client.query<{ retention_unit_revision_id: string }>(
    "select retention_unit_revision_id from science_v3_retention_projection where tenant_id=$1 and student_id=$2",
    [input.tenantId,studentId],
  );
  for (const row of existing.rows) {
    if (grouped.has(row.retention_unit_revision_id)) continue;
    await client.query(
      "delete from science_v3_retention_projection where tenant_id=$1 and student_id=$2 and retention_unit_revision_id=$3",
      [input.tenantId,studentId,row.retention_unit_revision_id],
    );
  }

  const refs: string[] = [];
  for (const [unitId,reviews] of grouped) {
    const unit = await client.query<{
      dimension_revision_id: string;
      scope_facets: Record<string,string>;
    }>(
      `select dimension_revision_id,scope_facets from science_v3_retention_unit_revision
        where tenant_id=$1 and retention_unit_revision_id=$2`,
      [input.tenantId,unitId],
    );
    const definition = unit.rows[0];
    if (!definition) throw new Error(`RetentionUnit ${unitId} is missing`);
    const replay = replayRetention(reviews,parameters,input.projectedAt);
    await client.query(
      `insert into science_v3_retention_projection (
         tenant_id,student_id,retention_unit_revision_id,dimension_revision_id,scope_facets,
         due_at,stability,difficulty,retrievability,card_state,fsrs_card,last_review_event_id,
         review_count,parameter_set_id,input_review_event_ids,projection_version,
         projector_version,projected_at
       ) values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,1,$16,$17)
       on conflict (tenant_id,student_id,retention_unit_revision_id) do update
         set dimension_revision_id=excluded.dimension_revision_id,scope_facets=excluded.scope_facets,
             due_at=excluded.due_at,stability=excluded.stability,difficulty=excluded.difficulty,
             retrievability=excluded.retrievability,card_state=excluded.card_state,
             fsrs_card=excluded.fsrs_card,last_review_event_id=excluded.last_review_event_id,
             review_count=excluded.review_count,parameter_set_id=excluded.parameter_set_id,
             input_review_event_ids=excluded.input_review_event_ids,
             projection_version=science_v3_retention_projection.projection_version+1,
             projector_version=excluded.projector_version,projected_at=excluded.projected_at`,
      [input.tenantId,studentId,unitId,definition.dimension_revision_id,
        JSON.stringify(definition.scope_facets),replay.dueAt,replay.stability,replay.difficulty,
        replay.retrievability,replay.cardState,JSON.stringify(replay.card),replay.lastReviewEventId,
        replay.reviewCount,parameters.parameterSetId,replay.inputReviewEventIds,
        SCIENTIFIC_PROJECTOR_VERSION,input.projectedAt],
    );
    refs.push(`retention-projection:${studentId}:${unitId}`);
  }
  return refs.sort();
};

export async function compileAndProjectQuestion(
  client: pg.PoolClient,
  input: ScientificCommitInput,
): Promise<ScientificCommitResult> {
  if (!Number.isSafeInteger(input.frozenAttemptSequence) || input.frozenAttemptSequence < 0) {
    throw new Error("invalid frozen Attempt sequence");
  }
  const session = await client.query<SessionRow>(
    `select student_id,question_revision_id,source,frozen_measurement_contract
       from science_v3_question_session
      where tenant_id=$1 and question_session_id=$2`,
    [input.tenantId,input.questionSessionId],
  );
  const row = session.rows[0];
  if (!row) throw new Error("QuestionSession is missing during scientific commit");
  await client.query(
    "select pg_advisory_xact_lock(hashtextextended($1,0))",
    [`science-v3-project:${input.tenantId}:${row.student_id}`],
  );
  const policyRef = text(row.frozen_measurement_contract.evidence_policy_version, "EvidencePolicy ref");
  const policy = await loadPolicy(client,policyRef);
  await compileFacts(client,input,row,policy);
  const expectedEventIds = await compileDelayedReviews(client,input,row.student_id);
  const masteryProjectionRefs = await projectMastery(client,input,row.student_id);
  const retentionProjectionRefs = await projectRetention(client,input,row.student_id,expectedEventIds);
  const observations = await loadActiveObservations(client,input.tenantId,row.student_id);
  const observationRefs = observations
    .filter((observation) => observation.question_session_id === input.questionSessionId)
    .map((observation) => `observation://${observation.observation_id}`);
  return { observationRefs,masteryProjectionRefs,retentionProjectionRefs };
}
