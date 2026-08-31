import { createHash } from "node:crypto";
import pg from "pg";
import { EVIDENCE_POLICY_REF } from "./scientific-core.ts";
import {
  decodeCatalogCursor,
  encodeCatalogCursor,
  estimatedBurden,
  parseHardSelectionConstraints,
  parseSelectionDecision,
  sha256Json,
  type HardSelectionConstraints,
  type MeasurementEligibility,
  type QuestionCatalogCandidate,
  type QuestionCatalogResult,
  type SelectionDecision,
} from "./selection-core.ts";
import type { CommitSelectionDecisionInput, SelectionCommitResult } from "./runtime-types.ts";

const idFrom = (prefix: string, value: string, length = 24): string =>
  `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, length)}`;

const pageRef = (pageId: string): string => `catalog-page://${pageId}`;
const pageIdFromRef = (ref: string): string | undefined => /^catalog-page:\/\/(cpg_[A-Za-z0-9]{8,})$/.exec(ref)?.[1];
const artifactIdFromRef = (ref: string): string => {
  const match = /^agent-artifact:(art_[A-Za-z0-9]{8,})$/.exec(ref);
  if (!match) throw new Error("selection outputRef must identify an Agent artifact");
  return match[1]!;
};

interface SelectionContextRow {
  operation_id: string;
  event_id: string;
  selection_intent_id: string;
  conversation_thread_id: string;
  student_id: string;
  student_user_id: string;
  revision: string;
  activity_constraints: Record<string, unknown>;
  agent_attempt_id: string;
}

interface CatalogRow {
  question_revision_id: string;
  entity_id: string;
  origin: "official" | "teacher";
  revision_no: number;
  stem_markdown: string;
  stem_format: QuestionCatalogCandidate["representation"];
  difficulty: number;
  measurement_eligibility: MeasurementEligibility;
  dimensions: QuestionCatalogCandidate["dimensions"];
  error_roles: QuestionCatalogCandidate["error_roles"];
}

interface DecisionSourceRow extends SelectionContextRow {
  idempotency_key: string;
  output_payload: unknown;
  output_ref: string;
  resolved_model_id: string;
  prompt_version: string;
  skill_ref: string;
}

interface QuestionCommitRow {
  entity_id: string;
  origin: "official" | "teacher";
  revision_no: number;
  chapter_id: string;
  stem_format: QuestionCatalogCandidate["representation"];
  stem_markdown: string;
  difficulty: number;
  rubric_count: string;
  dimensions: Array<{ dimension_revision_id: string; target_role: string }>;
  diagnosis_rule_revision_ids: string[];
  options: Array<{ option_key: string; option_text: string }>;
  assets: Array<{ asset_ref: string; asset_role: string; mime_type: string | null }>;
}

export interface QuestionCatalogSearchInput {
  tenantId: string;
  operationId: string;
  agentAttemptId: string;
  toolCallId: string;
  query: string;
  cursor?: string;
  limit?: number;
}

export interface SelectionStore {
  searchCatalog(input: QuestionCatalogSearchInput): Promise<QuestionCatalogResult>;
  commitDecision(input: CommitSelectionDecisionInput): Promise<SelectionCommitResult>;
  markSuperseded(input: { tenantId: string; operationId: string; replacementOperationId: string }): Promise<void>;
  close(): Promise<void>;
}

const constraintValues = (constraints: HardSelectionConstraints) => [
  constraints.chapterId ?? null,
  constraints.measurementEligibility ?? null,
  constraints.minimumDifficulty ?? null,
  constraints.maximumDifficulty ?? null,
  constraints.requiredDimensionRevisionId ?? null,
  constraints.requiredErrorCauseRevisionId ?? null,
  constraints.representation ?? null,
  constraints.allowRecentRevisit,
] as const;

const catalogSql = `
  with latest as (
    select distinct on (entity.entity_id)
           entity.entity_id,entity.origin,revision.revision_id,revision.revision_no
      from content_entity entity
      join content_entity_revision revision
        on revision.tenant_id=entity.tenant_id and revision.entity_id=entity.entity_id
     where entity.tenant_id=$1 and entity.entity_kind='question'
       and revision.lifecycle_status='ready'
     order by entity.entity_id,revision.revision_no desc
  ), qualified as (
    select latest.entity_id,latest.origin,latest.revision_id as question_revision_id,
           latest.revision_no,question.chapter_id,question.stem_markdown,
           question.stem_format,question.difficulty,
           case when exists (
                  select 1 from content_revision_item rubric_item
                  join content_question_rubric_item rubric using(item_id)
                 where rubric_item.tenant_id=$1 and rubric_item.revision_id=question.revision_id
                ) and exists (
                  select 1 from content_revision_item target_item
                  join content_question_measurement_target target using(item_id)
                 where target_item.tenant_id=$1 and target_item.revision_id=question.revision_id
                ) then 'formal' else 'teaching_only' end as measurement_eligibility,
           coalesce((
             select jsonb_agg(jsonb_build_object(
                      'dimension_revision_id',target.dimension_revision_id,
                      'name',coalesce(knowledge.name,question_type.name,target.dimension_revision_id),
                      'target_role',target.target_role
                    ) order by target_item.position)
               from content_revision_item target_item
               join content_question_measurement_target target using(item_id)
               left join content_knowledge_revision knowledge
                 on knowledge.tenant_id=target.tenant_id and knowledge.revision_id=target.dimension_revision_id
               left join content_question_type_revision question_type
                 on question_type.tenant_id=target.tenant_id and question_type.revision_id=target.dimension_revision_id
              where target_item.tenant_id=$1 and target_item.revision_id=question.revision_id
           ),'[]'::jsonb) as dimensions,
           coalesce((
             select jsonb_agg(jsonb_build_object(
                      'error_cause_revision_id',role.error_cause_revision_id,
                      'name',cause.name,'role',role.role
                    ) order by role.role,role.error_cause_revision_id)
               from science_v3_question_error_role role
               join content_error_cause_revision cause
                 on cause.tenant_id=role.tenant_id and cause.revision_id=role.error_cause_revision_id
              where role.tenant_id=$1 and role.question_revision_id=question.revision_id
           ),'[]'::jsonb) as error_roles,
           coalesce(question_type.name,'') as question_type_name
      from latest
      join content_question_revision question
        on question.tenant_id=$1 and question.revision_id=latest.revision_id
      left join content_question_type_revision question_type
        on question_type.tenant_id=question.tenant_id
       and question_type.revision_id=question.question_type_revision_id
     where mathpilot_content_entity_visible($1,$2,array['student']::text[],'question',latest.entity_id,false)
       and ($3::text is null or question.chapter_id=$3)
       and ($5::double precision is null or question.difficulty >= $5)
       and ($6::double precision is null or question.difficulty <= $6)
       and ($9::text is null or question.stem_format=$9)
       and ($7::text is null or exists (
         select 1 from content_revision_item required_target_item
         join content_question_measurement_target required_target using(item_id)
          where required_target_item.tenant_id=$1
            and required_target_item.revision_id=question.revision_id
            and required_target.dimension_revision_id=$7
       ))
       and ($8::text is null or exists (
         select 1 from science_v3_question_error_role required_role
          where required_role.tenant_id=$1
            and required_role.question_revision_id=question.revision_id
            and required_role.error_cause_revision_id=$8
       ))
       and ($10::boolean or not exists (
         select 1 from (
           select recent.question_revision_id
             from science_v3_question_session recent
            where recent.tenant_id=$1 and recent.conversation_thread_id=$11
              and recent.question_revision_id is not null
            order by recent.opened_at desc limit 10
         ) recent_questions where recent_questions.question_revision_id=question.revision_id
       ))
  )
  select qualified.entity_id,qualified.origin,qualified.question_revision_id,
         qualified.revision_no,qualified.stem_markdown,qualified.stem_format,
         qualified.difficulty,qualified.measurement_eligibility,
         qualified.dimensions,qualified.error_roles
    from qualified
   where ($4::text is null or qualified.measurement_eligibility=$4)
     and ($12::text='' or concat_ws(' ',qualified.entity_id,qualified.question_revision_id,
           qualified.chapter_id,qualified.stem_markdown,qualified.question_type_name,
           qualified.dimensions::text,qualified.error_roles::text) ilike $13)
   order by qualified.question_revision_id
   limit $14 offset $15`;

export class PostgresSelectionStore implements SelectionStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 6 });
  }

  private async withTenant<T>(tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select set_config('app.current_tenant',$1,true),set_config('app.current_user','',true),set_config('app.current_roles','',true)",
        [tenantId],
      );
      const value = await fn(client);
      await client.query("commit");
      return value;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async searchCatalog(input: QuestionCatalogSearchInput): Promise<QuestionCatalogResult> {
    if (typeof input.query !== "string" || input.query.length > 500) throw new Error("question_catalog query is invalid");
    const limit = input.limit ?? 12;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("question_catalog limit must be between 1 and 50");
    return this.withTenant(input.tenantId, async (client) => {
      const context = await client.query<SelectionContextRow>(
        `select request.operation_id,request.event_id,request.selection_intent_id,intent.conversation_thread_id,intent.student_id,
                student.user_id as student_user_id,intent.revision,intent.activity_constraints,
                attempt.agent_attempt_id
           from science_v3_selection_request request
           join science_v3_selection_intent intent
             on intent.tenant_id=request.tenant_id and intent.selection_intent_id=request.selection_intent_id
           join science_v3_student student
             on student.tenant_id=intent.tenant_id and student.student_id=intent.student_id
           join science_v3_agent_attempt attempt
             on attempt.tenant_id=request.tenant_id and attempt.operation_id=request.operation_id
          where request.tenant_id=$1 and request.operation_id=$2
            and attempt.agent_attempt_id=$3 and attempt.task_type='select_question'`,
        [input.tenantId,input.operationId,input.agentAttemptId],
      );
      const row = context.rows[0];
      if (!row) throw new Error("question_catalog is not authorized for this Selector attempt");
      const constraints = parseHardSelectionConstraints(row.activity_constraints);
      const constraintsDigest = sha256Json(row.activity_constraints);
      const cursorScope = sha256Json({
        tenant_id: input.tenantId,
        selection_intent_id: row.selection_intent_id,
        intent_revision: Number(row.revision),
        constraints_digest: constraintsDigest,
      });
      const offset = decodeCatalogCursor(input.cursor,cursorScope);
      const [chapterId,measurementEligibility,minimumDifficulty,maximumDifficulty,
        requiredDimensionRevisionId,requiredErrorCauseRevisionId,representation,allowRecentRevisit] = constraintValues(constraints);
      const result = await client.query<CatalogRow>(catalogSql, [
        input.tenantId,row.student_user_id,chapterId,measurementEligibility,minimumDifficulty,
        maximumDifficulty,requiredDimensionRevisionId,requiredErrorCauseRevisionId,representation,
        allowRecentRevisit,row.conversation_thread_id,input.query,input.query ? `%${input.query}%` : "",limit+1,offset,
      ]);
      const hasMore = result.rows.length > limit;
      const selected = result.rows.slice(0,limit);
      const nextCursor = hasMore ? encodeCatalogCursor(cursorScope,offset+limit) : undefined;
      const catalogPageId = idFrom("cpg",`${input.agentAttemptId}\0${input.toolCallId}`);
      const candidateRevisionIds = selected.map((candidate) => candidate.question_revision_id);
      await client.query(
        `insert into science_v3_selection_catalog_page(
           catalog_page_id,tenant_id,operation_id,agent_attempt_id,tool_call_id,
           selection_intent_id,intent_revision,query_text,input_cursor,next_cursor,
           candidate_revision_ids,constraints_digest
         ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         on conflict(tenant_id,agent_attempt_id,tool_call_id) do nothing`,
        [catalogPageId,input.tenantId,input.operationId,input.agentAttemptId,input.toolCallId,
          row.selection_intent_id,Number(row.revision),input.query,input.cursor ?? null,nextCursor ?? null,
          candidateRevisionIds,constraintsDigest],
      );
      const stored = await client.query<{
        catalog_page_id: string;
        query_text: string;
        input_cursor: string | null;
        next_cursor: string | null;
        candidate_revision_ids: string[];
      }>(
        `select catalog_page_id,query_text,input_cursor,next_cursor,candidate_revision_ids
           from science_v3_selection_catalog_page
          where tenant_id=$1 and agent_attempt_id=$2 and tool_call_id=$3`,
        [input.tenantId,input.agentAttemptId,input.toolCallId],
      );
      const frozen = stored.rows[0];
      if (!frozen || frozen.catalog_page_id !== catalogPageId || frozen.query_text !== input.query
        || frozen.input_cursor !== (input.cursor ?? null) || frozen.next_cursor !== (nextCursor ?? null)
        || JSON.stringify(frozen.candidate_revision_ids) !== JSON.stringify(candidateRevisionIds)) {
        throw new Error("question_catalog tool call ID is already bound to a different page");
      }
      const candidates: QuestionCatalogCandidate[] = selected.map((candidate) => ({
        question_revision_id: candidate.question_revision_id,
        stem: candidate.stem_markdown,
        dimensions: candidate.dimensions,
        difficulty: candidate.difficulty,
        representation: candidate.stem_format,
        estimated_burden: estimatedBurden(candidate.difficulty,candidate.stem_markdown.length),
        error_roles: candidate.error_roles,
        measurement_eligibility: candidate.measurement_eligibility,
        provenance: {
          origin: candidate.origin,
          entity_id: candidate.entity_id,
          revision_no: Number(candidate.revision_no),
        },
      }));
      return {
        candidates,
        ...(nextCursor ? { next_cursor: nextCursor } : {}),
        page_ref: pageRef(catalogPageId),
      };
    });
  }

  private async decisionSource(client: pg.PoolClient, input: CommitSelectionDecisionInput): Promise<DecisionSourceRow> {
    const artifactId = artifactIdFromRef(input.outputRef);
    const result = await client.query<DecisionSourceRow>(
      `select request.operation_id,request.event_id,request.idempotency_key,request.selection_intent_id,
              intent.conversation_thread_id,intent.student_id,student.user_id as student_user_id,
              intent.revision,intent.activity_constraints,artifact.payload as output_payload,
              'agent-artifact:' || artifact.artifact_id as output_ref,
              attempt.agent_attempt_id,attempt.resolved_model_id,attempt.prompt_version,attempt.skill_ref
         from science_v3_selection_request request
         join science_v3_selection_intent intent
           on intent.tenant_id=request.tenant_id and intent.selection_intent_id=request.selection_intent_id
         join science_v3_student student
           on student.tenant_id=intent.tenant_id and student.student_id=intent.student_id
         join science_v3_agent_artifact artifact
           on artifact.tenant_id=request.tenant_id and artifact.operation_id=request.operation_id
          and artifact.artifact_id=$3 and artifact.artifact_kind='structured_output'
         join science_v3_agent_attempt attempt
           on attempt.tenant_id=request.tenant_id and attempt.operation_id=request.operation_id
          and attempt.output_ref='agent-artifact:' || artifact.artifact_id
          and attempt.status='succeeded' and attempt.task_type='select_question'
        where request.tenant_id=$1 and request.operation_id=$2
        order by attempt.completed_at desc limit 1`,
      [input.tenantId,input.operationId,artifactId],
    );
    const row = result.rows[0];
    if (!row || !row.resolved_model_id || row.event_id !== input.eventId) {
      throw new Error("Selector output is not authorized for this operation");
    }
    return row;
  }

  private async existingResult(
    client: pg.PoolClient,
    tenantId: string,
    operationId: string,
    idempotencyKey: string,
  ): Promise<SelectionCommitResult | undefined> {
    const result = await client.query<{
      result_status: "committed" | "rejected" | "already_committed";
      rejection_code: "stale_intent" | "candidate_invalid" | null;
      result_resource_refs: string[];
      aggregate_version: string;
    }>(
      `select result_status,rejection_code,result_resource_refs,aggregate_version
         from science_v3_operation_result
        where tenant_id=$1 and operation_id=$2 and idempotency_key=$3`,
      [tenantId,operationId,idempotencyKey],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const questionSessionRef = row.result_resource_refs.find((ref) => ref.startsWith("question-session:"));
    const decisionRef = row.result_resource_refs.find((ref) => ref.startsWith("selection-decision:"));
    const messageRef = row.result_resource_refs.find((ref) => ref.startsWith("message:"));
    if (row.result_status === "rejected") {
      return { status: row.rejection_code === "candidate_invalid" ? "candidate_invalid" : "stale_intent", latestIntentRevision: Number(row.aggregate_version) };
    }
    if (row.result_status === "already_committed") {
      return {
        status: "already_committed",
        ...(questionSessionRef ? { questionSessionId: questionSessionRef.slice("question-session:".length) } : {}),
      };
    }
    return {
      status: questionSessionRef ? "selected" : "no_candidate",
      ...(questionSessionRef ? { questionSessionId: questionSessionRef.slice("question-session:".length) } : {}),
      ...(decisionRef ? { selectionDecisionId: decisionRef.slice("selection-decision:".length) } : {}),
      ...(messageRef ? { messageId: messageRef.slice("message:".length) } : {}),
    };
  }

  private async finishRejected(
    client: pg.PoolClient,
    source: DecisionSourceRow,
    input: CommitSelectionDecisionInput,
    code: "stale_intent",
    latestRevision: number,
  ): Promise<SelectionCommitResult> {
    await client.query(
      `insert into science_v3_operation_result(
         tenant_id,operation_id,idempotency_key,result_status,aggregate_ref,
         aggregate_version,result_resource_refs,rejection_code
       ) values($1,$2,$3,'rejected',$4,$5,$6,$7)
       on conflict(operation_id,idempotency_key) do nothing`,
      [input.tenantId,input.operationId,source.idempotency_key,
        `selection-intent:${source.selection_intent_id}`,Math.max(latestRevision,1),
        [`selection-intent:${source.selection_intent_id}`],code],
    );
    await client.query(
      `update science_v3_operation
          set status='succeeded',user_message='选题需求已更新，旧结果未提交',retryable=false,
              related_resource_refs=$3,updated_at=clock_timestamp(),version=version+1
        where tenant_id=$1 and operation_id=$2 and status='running'`,
      [input.tenantId,input.operationId,[`selection-intent:${source.selection_intent_id}`]],
    );
    return { status: "stale_intent", latestIntentRevision: latestRevision };
  }

  private async verifiedPages(
    client: pg.PoolClient,
    source: DecisionSourceRow,
    decision: SelectionDecision,
    tenantId: string,
  ): Promise<Array<{ catalog_page_id: string; candidate_revision_ids: string[] }>> {
    const pageIds = decision.evidence_refs.map(pageIdFromRef).filter((value): value is string => Boolean(value));
    if (!pageIds.length) throw new Error("SelectionDecision must cite at least one question_catalog page");
    const pages = await client.query<{ catalog_page_id: string; candidate_revision_ids: string[] }>(
      `select catalog_page_id,candidate_revision_ids
         from science_v3_selection_catalog_page
        where tenant_id=$1 and operation_id=$2 and agent_attempt_id=$3
          and selection_intent_id=$4 and intent_revision=$5
          and catalog_page_id=any($6::text[])`,
      [tenantId,source.operation_id,source.agent_attempt_id,source.selection_intent_id,Number(source.revision),pageIds],
    );
    if (pages.rows.length !== new Set(pageIds).size) throw new Error("SelectionDecision cites a catalog page outside its AgentAttempt");
    return pages.rows;
  }

  private async questionForCommit(
    client: pg.PoolClient,
    source: DecisionSourceRow,
    decision: Extract<SelectionDecision,{ decision_type: "selected" }>,
    constraints: HardSelectionConstraints,
    tenantId: string,
  ): Promise<QuestionCommitRow | undefined> {
    const result = await client.query<QuestionCommitRow>(
      `with target_question as (
         select entity.entity_id,entity.origin,revision.revision_no,question.*
           from content_question_revision question
           join content_entity_revision revision
             on revision.tenant_id=question.tenant_id and revision.revision_id=question.revision_id
           join content_entity entity
             on entity.tenant_id=revision.tenant_id and entity.entity_id=revision.entity_id
          where question.tenant_id=$1 and question.revision_id=$2
            and revision.lifecycle_status='ready'
            and not exists (
              select 1 from content_entity_revision newer
               where newer.tenant_id=revision.tenant_id and newer.entity_id=revision.entity_id
                 and newer.lifecycle_status='ready' and newer.revision_no>revision.revision_no
            )
            and mathpilot_content_entity_visible($1,$3,array['student']::text[],'question',entity.entity_id,false)
       )
       select question.entity_id,question.origin,question.revision_no,question.chapter_id,
              question.stem_format,question.stem_markdown,question.difficulty,
              (select count(*) from content_revision_item item
                join content_question_rubric_item rubric using(item_id)
               where item.tenant_id=$1 and item.revision_id=question.revision_id) as rubric_count,
              coalesce((select jsonb_agg(jsonb_build_object(
                         'dimension_revision_id',target.dimension_revision_id,'target_role',target.target_role
                       ) order by item.position)
                from content_revision_item item
                join content_question_measurement_target target using(item_id)
               where item.tenant_id=$1 and item.revision_id=question.revision_id),'[]'::jsonb) as dimensions,
              coalesce((select array_agg(distinct rule.revision_id order by rule.revision_id)
                from science_v3_question_error_role role
                join content_diagnosis_rule_error_cause relation
                  on relation.tenant_id=role.tenant_id
                 and relation.error_cause_revision_id=role.error_cause_revision_id
                join content_revision_item rule_item
                  on rule_item.tenant_id=relation.tenant_id and rule_item.item_id=relation.item_id
                join content_entity_revision rule
                  on rule.tenant_id=rule_item.tenant_id and rule.revision_id=rule_item.revision_id
               where role.tenant_id=$1 and role.question_revision_id=question.revision_id
                 and rule.lifecycle_status='ready'),'{}'::text[]) as diagnosis_rule_revision_ids,
              coalesce((select jsonb_agg(jsonb_build_object(
                         'option_key',option.option_key,'option_text',option.option_text
                       ) order by item.position)
                from content_revision_item item
                join content_question_option option using(item_id)
               where item.tenant_id=$1 and item.revision_id=question.revision_id),'[]'::jsonb) as options,
              coalesce((select jsonb_agg(jsonb_build_object(
                         'asset_ref','storage-object:' || asset.storage_object_id,
                         'asset_role',asset.asset_role,'mime_type',asset.mime_type
                       ) order by item.position)
                from content_revision_item item
                join content_question_asset_revision asset using(item_id)
               where item.tenant_id=$1 and item.revision_id=question.revision_id
                 and asset.storage_object_id is not null),'[]'::jsonb) as assets
         from target_question question
        where ($4::text is null or question.chapter_id=$4)
          and ($5::double precision is null or question.difficulty >= $5)
          and ($6::double precision is null or question.difficulty <= $6)
          and ($7::text is null or question.stem_format=$7)
          and ($8::text is null or exists (
            select 1 from content_revision_item required_item
            join content_question_measurement_target required_target using(item_id)
             where required_item.tenant_id=$1 and required_item.revision_id=question.revision_id
               and required_target.dimension_revision_id=$8
          ))
          and ($9::text is null or exists (
            select 1 from science_v3_question_error_role required_role
             where required_role.tenant_id=$1 and required_role.question_revision_id=question.revision_id
               and required_role.error_cause_revision_id=$9
          ))`,
      [tenantId,decision.chosen_question_revision_id,source.student_user_id,
        constraints.chapterId ?? null,constraints.minimumDifficulty ?? null,constraints.maximumDifficulty ?? null,
        constraints.representation ?? null,constraints.requiredDimensionRevisionId ?? null,
        constraints.requiredErrorCauseRevisionId ?? null],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const eligibility: MeasurementEligibility = Number(row.rubric_count)>0 && row.dimensions.length>0 ? "formal" : "teaching_only";
    if (constraints.measurementEligibility && eligibility !== constraints.measurementEligibility) return undefined;
    const dimensions = new Set(row.dimensions.map((item) => item.dimension_revision_id));
    if (decision.target_dimensions.some((id) => !dimensions.has(id))) return undefined;
    const errors = await client.query<{ error_cause_revision_id: string }>(
      `select error_cause_revision_id from science_v3_question_error_role
        where tenant_id=$1 and question_revision_id=$2`,
      [tenantId,decision.chosen_question_revision_id],
    );
    const errorIds = new Set(errors.rows.map((item) => item.error_cause_revision_id));
    if (decision.target_error_causes.some((id) => !errorIds.has(id))) return undefined;
    return row;
  }

  async commitDecision(input: CommitSelectionDecisionInput): Promise<SelectionCommitResult> {
    return this.withTenant(input.tenantId, async (client) => {
      const source = await this.decisionSource(client,input);
      const existing = await this.existingResult(client,input.tenantId,input.operationId,source.idempotency_key);
      if (existing) return existing;
      const decision = parseSelectionDecision(source.output_payload,{
        intentId: source.selection_intent_id,
        intentRevision: Number(source.revision),
      });
      await client.query(
        `select 1 from science_v3_conversation_thread
          where tenant_id=$1 and conversation_thread_id=$2 for update`,
        [input.tenantId,source.conversation_thread_id],
      );
      const latest = await client.query<{ selection_intent_id: string; revision: string }>(
        `select selection_intent_id,revision from science_v3_selection_intent
          where tenant_id=$1 and conversation_thread_id=$2
          order by revision desc limit 1`,
        [input.tenantId,source.conversation_thread_id],
      );
      const latestIntent = latest.rows[0];
      if (!latestIntent || latestIntent.selection_intent_id !== source.selection_intent_id
        || Number(latestIntent.revision) !== Number(source.revision)) {
        return this.finishRejected(client,source,input,"stale_intent",Number(latestIntent?.revision ?? source.revision));
      }
      const active = await client.query<{ question_session_id: string }>(
        `select question_session_id from science_v3_question_session
          where tenant_id=$1 and conversation_thread_id=$2
            and lifecycle in('active','finalizing') limit 1`,
        [input.tenantId,source.conversation_thread_id],
      );
      if (active.rows[0]) {
        const resource = `question-session:${active.rows[0].question_session_id}`;
        await client.query(
          `insert into science_v3_operation_result(
             tenant_id,operation_id,idempotency_key,result_status,aggregate_ref,
             aggregate_version,result_resource_refs
           ) values($1,$2,$3,'already_committed',$4,$5,$6)
           on conflict(operation_id,idempotency_key) do nothing`,
          [input.tenantId,input.operationId,source.idempotency_key,
            `selection-intent:${source.selection_intent_id}`,Number(source.revision),[resource]],
        );
        await client.query(
          `update science_v3_operation
              set status='succeeded',user_message='当前已有进行中的题目',retryable=false,
                  related_resource_refs=$3,updated_at=clock_timestamp(),version=version+1
            where tenant_id=$1 and operation_id=$2 and status='running'`,
          [input.tenantId,input.operationId,[resource]],
        );
        return { status: "already_committed", questionSessionId: active.rows[0].question_session_id };
      }
      const pages = await this.verifiedPages(client,source,decision,input.tenantId);
      if (decision.decision_type === "selected"
        && !pages.some((page) => page.candidate_revision_ids.includes(decision.chosen_question_revision_id))) {
        throw new Error("chosen question was not returned to this Selector attempt");
      }
      const constraints = parseHardSelectionConstraints(source.activity_constraints);
      const now = new Date();
      const decisionId = idFrom("sdec",`${input.operationId}\0${input.outputRef}`);
      const messageId = idFrom("msg",`${input.operationId}\0selection-message`);
      const decisionValues = [
        decisionId,input.tenantId,input.operationId,source.selection_intent_id,Number(source.revision),
        decision.decision_type,decision.decision_type === "selected" ? decision.chosen_question_revision_id : null,
        decision.decision_type === "selected" ? decision.satisfied_requirements : [],decision.unsatisfied_preferences,
        decision.decision_type === "selected" ? decision.scientific_purpose : null,
        decision.decision_type === "selected" ? decision.target_dimensions : [],
        decision.decision_type === "selected" ? decision.target_error_causes : [],decision.evidence_refs,
        decision.decision_summary,decision.decision_type === "no_candidate" ? decision.search_summary : null,
        source.agent_attempt_id,source.output_ref,source.resolved_model_id,source.prompt_version,source.skill_ref,now,
      ];

      if (decision.decision_type === "no_candidate") {
        await client.query(
          `insert into science_v3_selection_decision(
             selection_decision_id,tenant_id,operation_id,selection_intent_id,intent_revision,
             decision_status,chosen_question_revision_id,satisfied_requirements,unsatisfied_preferences,
             scientific_purpose,target_dimension_revision_ids,target_error_cause_revision_ids,
             evidence_refs,decision_summary,search_summary,agent_attempt_id,output_ref,
             model_id,prompt_version,skill_ref,created_at
           ) values(${decisionValues.map((_,index) => `$${index+1}`).join(",")})`,
          decisionValues,
        );
        const thread = await client.query<{ next_message_sequence: string }>(
          `select next_message_sequence from science_v3_conversation_thread
            where tenant_id=$1 and conversation_thread_id=$2`,
          [input.tenantId,source.conversation_thread_id],
        );
        const sequence = Number(thread.rows[0]?.next_message_sequence);
        await client.query(
          `insert into science_v3_canonical_message(
             message_id,tenant_id,conversation_thread_id,sequence,author_kind,lifecycle,
             parts,editable,lock_reason,created_at,version
           ) values($1,$2,$3,$4,'assistant','committed',$5::jsonb,false,'domain_event',$6,1)`,
          [messageId,input.tenantId,source.conversation_thread_id,sequence,
            JSON.stringify([{ type: "text", text: decision.decision_summary }]),now],
        );
        await client.query(
          `update science_v3_conversation_thread
              set next_message_sequence=next_message_sequence+1,updated_at=clock_timestamp(),version=version+1
            where tenant_id=$1 and conversation_thread_id=$2`,
          [input.tenantId,source.conversation_thread_id],
        );
        const refs = [`selection-decision:${decisionId}`,`message:${messageId}`];
        await client.query(
          `insert into science_v3_operation_result(
             tenant_id,operation_id,idempotency_key,result_status,aggregate_ref,
             aggregate_version,result_resource_refs
           ) values($1,$2,$3,'committed',$4,$5,$6)`,
          [input.tenantId,input.operationId,source.idempotency_key,
            `selection-intent:${source.selection_intent_id}`,Number(source.revision),refs],
        );
        await client.query(
          `update science_v3_operation
              set status='succeeded',user_message='暂未找到符合要求的题目',retryable=false,
                  related_resource_refs=$3,updated_at=clock_timestamp(),version=version+1
            where tenant_id=$1 and operation_id=$2 and status='running'`,
          [input.tenantId,input.operationId,refs],
        );
        return { status: "no_candidate", selectionDecisionId: decisionId, messageId };
      }

      const question = await this.questionForCommit(client,source,decision,constraints,input.tenantId);
      if (!question) return { status: "candidate_invalid" };
      if (constraints.learningActivityId) {
        const activity = await client.query(
          `select 1 from science_v3_learning_activity
            where tenant_id=$1 and learning_activity_id=$2 and student_id=$3 and status='active'`,
          [input.tenantId,constraints.learningActivityId,source.student_id],
        );
        if (!activity.rowCount) return { status: "candidate_invalid" };
      }
      await client.query(
        `insert into science_v3_selection_decision(
           selection_decision_id,tenant_id,operation_id,selection_intent_id,intent_revision,
           decision_status,chosen_question_revision_id,satisfied_requirements,unsatisfied_preferences,
           scientific_purpose,target_dimension_revision_ids,target_error_cause_revision_ids,
           evidence_refs,decision_summary,search_summary,agent_attempt_id,output_ref,
           model_id,prompt_version,skill_ref,created_at
         ) values(${decisionValues.map((_,index) => `$${index+1}`).join(",")})`,
        decisionValues,
      );
      const measurementEligibility: MeasurementEligibility = Number(question.rubric_count)>0 && question.dimensions.length>0
        ? "formal" : "teaching_only";
      const questionSessionId = idFrom("qsn",`${source.selection_intent_id}\0${decision.chosen_question_revision_id}`);
      const foregroundEpochId = idFrom("fge",`${questionSessionId}\0foreground`);
      const questionOpenedId = idFrom("qopen",questionSessionId);
      const partId = idFrom("part",questionOpenedId);
      const revisit = await client.query<{ question_session_id: string }>(
        `select question_session_id from science_v3_question_session
          where tenant_id=$1 and conversation_thread_id=$2 and question_revision_id=$3
            and lifecycle in('closed','abandoned')
          order by opened_at desc limit 1`,
        [input.tenantId,source.conversation_thread_id,decision.chosen_question_revision_id],
      );
      const frozenContract = {
        contract_version: 1,
        measurement_eligibility: measurementEligibility,
        rubric_revision_id: measurementEligibility === "formal" ? decision.chosen_question_revision_id : null,
        dimension_revision_ids: question.dimensions.map((item) => item.dimension_revision_id),
        diagnosis_rule_revision_ids: question.diagnosis_rule_revision_ids,
        evidence_policy_version: EVIDENCE_POLICY_REF,
        ...(measurementEligibility === "formal" ? { frozen_at: now.toISOString() } : {}),
      };
      await client.query(
        `update science_v3_foreground_agent_epoch
            set ended_at=$3,version=version+1
          where tenant_id=$1 and conversation_thread_id=$2 and ended_at is null`,
        [input.tenantId,source.conversation_thread_id,now],
      );
      await client.query(
        `insert into science_v3_question_session(
           question_session_id,tenant_id,conversation_thread_id,student_id,learning_activity_id,
           selection_intent_id,selection_intent_revision,question_revision_id,source,
           frozen_measurement_contract,lifecycle,opened_at,revisit_of_question_session_id,version
         ) values($1,$2,$3,$4,$5,$6,$7,$8,'catalog',$9::jsonb,'active',$10,$11,1)`,
        [questionSessionId,input.tenantId,source.conversation_thread_id,source.student_id,
          constraints.learningActivityId ?? null,source.selection_intent_id,Number(source.revision),
          decision.chosen_question_revision_id,JSON.stringify(frozenContract),now,
          revisit.rows[0]?.question_session_id ?? null],
      );
      await client.query(
        `insert into science_v3_foreground_agent_epoch(
           foreground_epoch_id,tenant_id,conversation_thread_id,student_id,
           active_question_session_id,context_snapshot_ref,workspace_snapshot_version,started_at,version
         ) values($1,$2,$3,$4,$5,$6,1,$7,1)`,
        [foregroundEpochId,input.tenantId,source.conversation_thread_id,source.student_id,
          questionSessionId,`snapshot:foreground/${foregroundEpochId}/v1`,now],
      );
      const thread = await client.query<{ next_message_sequence: string }>(
        `select next_message_sequence from science_v3_conversation_thread
          where tenant_id=$1 and conversation_thread_id=$2`,
        [input.tenantId,source.conversation_thread_id],
      );
      const sequence = Number(thread.rows[0]?.next_message_sequence);
      const messageParts = [{
        type: "domain_ui",
        part: {
          schema: "mathpilot.message-part/domain-ui/v1",
          part_id: partId,
          view_kind: "question",
          resource_ref: `question-session:${questionSessionId}`,
          resource_version: 1,
          snapshot: {
            schema: "mathpilot.view/question/v1",
            title: "下一题",
            summary: decision.decision_summary,
            data: {
              question_session_id: questionSessionId,
              question_revision_id: decision.chosen_question_revision_id,
              stem_markdown: question.stem_markdown,
              stem_format: question.stem_format,
              difficulty: question.difficulty,
              options: question.options,
              assets: question.assets,
              source: question.origin,
              measurement_eligibility: measurementEligibility,
              selection_intent_id: source.selection_intent_id,
              selection_intent_revision: Number(source.revision),
              satisfied_requirements: decision.satisfied_requirements,
              unsatisfied_preferences: decision.unsatisfied_preferences,
              scientific_purpose: decision.scientific_purpose,
            },
            redactions: ["answer","analysis","private_rubric"],
          },
          // Mutable authorization is returned by QuestionInteractionView.
          // The immutable event snapshot must not retain stale command slots.
          action_slots: [],
          occurred_at: now.toISOString(),
          origin: "domain_projector",
          domain_event_ref: `event://question-opened/${questionOpenedId}`,
        },
      }];
      await client.query(
        `insert into science_v3_canonical_message(
           message_id,tenant_id,conversation_thread_id,sequence,author_kind,foreground_epoch_id,
           lifecycle,parts,question_session_id,editable,lock_reason,created_at,version
         ) values($1,$2,$3,$4,'system',$5,'committed',$6::jsonb,$7,false,'domain_event',$8,1)`,
        [messageId,input.tenantId,source.conversation_thread_id,sequence,foregroundEpochId,
          JSON.stringify(messageParts),questionSessionId,now],
      );
      await client.query(
        `insert into science_v3_question_opened(
           question_opened_id,tenant_id,question_session_id,selection_decision_id,
           question_revision_id,message_id,occurred_at,event_version
         ) values($1,$2,$3,$4,$5,$6,$7,1)`,
        [questionOpenedId,input.tenantId,questionSessionId,decisionId,
          decision.chosen_question_revision_id,messageId,now],
      );
      await client.query(
        `update science_v3_conversation_thread
            set next_message_sequence=next_message_sequence+1,updated_at=clock_timestamp(),version=version+1
          where tenant_id=$1 and conversation_thread_id=$2`,
        [input.tenantId,source.conversation_thread_id],
      );
      const refs = [
        `selection-decision:${decisionId}`,`question-session:${questionSessionId}`,
        `question-opened:${questionOpenedId}`,`message:${messageId}`,
      ];
      await client.query(
        `insert into science_v3_operation_result(
           tenant_id,operation_id,idempotency_key,result_status,aggregate_ref,
           aggregate_version,result_resource_refs
         ) values($1,$2,$3,'committed',$4,$5,$6)`,
        [input.tenantId,input.operationId,source.idempotency_key,
          `selection-intent:${source.selection_intent_id}`,Number(source.revision),refs],
      );
      await client.query(
        `update science_v3_operation
            set status='succeeded',user_message='已按最新要求选出下一题',retryable=false,
                related_resource_refs=$3,updated_at=clock_timestamp(),version=version+1
          where tenant_id=$1 and operation_id=$2 and status='running'`,
        [input.tenantId,input.operationId,refs],
      );
      return { status: "selected", selectionDecisionId: decisionId, questionSessionId, messageId };
    });
  }

  async markSuperseded(input: { tenantId: string; operationId: string; replacementOperationId: string }): Promise<void> {
    await this.withTenant(input.tenantId, async (client) => {
      await client.query(
        `update science_v3_operation
            set status='cancelled',user_message='已使用更新后的选题要求',retryable=false,
                related_resource_refs=array[$3]::text[],updated_at=clock_timestamp(),version=version+1
          where tenant_id=$1 and operation_id=$2 and status in('accepted','running')`,
        [input.tenantId,input.operationId,`operation:${input.replacementOperationId}`],
      );
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
