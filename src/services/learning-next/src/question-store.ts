import { createHash } from "node:crypto";
import pg from "pg";
import { encodeArtifact, verifiedArtifactPayload } from "./artifact-integrity.ts";
import { compileAndProjectQuestion } from "./scientific-store.ts";
import { DEEP_GATE_POLICY_VERSION, LIGHT_COMPILER_VERSION } from "./dream-core.ts";
import type {
  AgentTaskWorkflowInput,
  CommitQuestionClosureInput,
  FinalizeQuestionWorkflowInput,
  PreparedQuestionFinalization,
  QuestionClosureResult,
  RecordFinalJudgmentInput,
  RecordUnresolvedJudgmentInput,
  ScientificReplayResult,
  ScientificReplayWorkflowInput,
} from "./runtime-types.ts";

const idFrom = (prefix: string, value: string, length = 24): string =>
  `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, length)}`;

const toIso = (value: Date | string): string => new Date(value).toISOString();

const artifactIdFromRef = (ref: string): string => {
  const match = /^agent-artifact:(art_[A-Za-z0-9]{8,})$/.exec(ref);
  if (!match) throw new Error("outputRef must be an agent-artifact reference");
  return match[1]!;
};

const projectionEvidenceRef = (ref: string): string => {
  const [kind,...parts] = ref.split(":");
  if (!kind || !parts.length) throw new Error("scientific projection reference is invalid");
  return `${kind}://${parts.join("/")}`;
};

const recordValue = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
};

const stringValue = (value: unknown, name: string, maximum = 2000): string => {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`${name} is invalid`);
  return value;
};

const stringArray = (value: unknown, name: string, minimum = 0): string[] => {
  if (!Array.isArray(value) || value.length < minimum || !value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new Error(`${name} is invalid`);
  }
  return [...new Set(value as string[])];
};

const enumValue = <T extends string>(value: unknown, name: string, choices: readonly T[]): T => {
  if (typeof value !== "string" || !choices.includes(value as T)) throw new Error(`${name} is invalid`);
  return value as T;
};

const publicRubricResults = (value: unknown): Array<{ rubric_item_id: string; status: string }> => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const item = candidate as Record<string, unknown>;
    return typeof item.rubric_item_id === "string" && typeof item.status === "string"
      ? [{ rubric_item_id: item.rubric_item_id, status: item.status }]
      : [];
  });
};

const verdictTitle = (value: string): string => ({
  correct: "回答正确",
  partially_correct: "部分正确",
  incorrect: "需要调整",
  unresolved: "尚不能形成正式判定",
})[value] ?? "判定结果";

const closureSummary = (reason: string, judgmentCount: number, observationCount: number): string => {
  if (reason === "skipped") return "本题已按跳过处理，没有把跳过伪装成答错。";
  if (reason === "abandoned") return "本题已结束；未完成内容只保留教学连续性。";
  if (!judgmentCount) return "本题已结束，暂未形成正式判定。";
  return `本题已结束，形成 ${judgmentCount} 条判定与 ${observationCount} 条可用学习证据。`;
};

interface PreparedRow {
  operation_id: string;
  operation_status: string;
  event_id: string;
  cut_request_id: string;
  question_session_id: string;
  question_session_version: string;
  payload_ref: string;
  frozen_attempt_sequence: string;
  question_revision_id: string | null;
  external_question_ref: string | null;
  frozen_measurement_contract: Record<string, unknown>;
  lifecycle: string;
}

interface AttemptRow {
  attempt_id: string;
  question_revision_id: string;
  student_id: string;
  kind: "answer" | "probe" | "correction" | "explanation";
  content_refs: string[];
  hint_level: number;
  submitted_at: Date;
  parts: unknown;
}

interface QuestionMaterialRow {
  stem_markdown: string | null;
  analysis_markdown: string | null;
  answer_items: unknown;
  rubric_items: unknown;
  measurement_targets: unknown;
}

export interface QuestionStore {
  prepareFinalization(input: FinalizeQuestionWorkflowInput): Promise<PreparedQuestionFinalization>;
  recordFinalJudgment(input: RecordFinalJudgmentInput): Promise<void>;
  recordUnresolvedJudgment(input: RecordUnresolvedJudgmentInput): Promise<void>;
  commitClosure(input: CommitQuestionClosureInput): Promise<QuestionClosureResult>;
  replayCorrection(input: ScientificReplayWorkflowInput): Promise<ScientificReplayResult>;
  close(): Promise<void>;
}

export class PostgresQuestionStore implements QuestionStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 6 });
  }

  private async withTenant<T>(tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select set_config('app.current_tenant',$1,true), set_config('app.current_user','',true), set_config('app.current_roles','',true)",
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

  async prepareFinalization(input: FinalizeQuestionWorkflowInput): Promise<PreparedQuestionFinalization> {
    return this.withTenant(input.tenantId, async (client) => {
      const prepared = await client.query<PreparedRow>(
        `select c.operation_id,o.status as operation_status,e.event_id,c.cut_request_id,c.question_session_id,
                q.version as question_session_version,c.payload_ref,c.frozen_attempt_sequence,
                q.question_revision_id,q.external_question_ref,q.frozen_measurement_contract,q.lifecycle
           from science_v3_cut_request c
           join science_v3_question_session q
             on q.tenant_id=c.tenant_id and q.question_session_id=c.question_session_id
           join science_v3_operation o
             on o.tenant_id=c.tenant_id and o.operation_id=c.operation_id
           join infra_outbox e
             on e.tenant_id=c.tenant_id and e.operation_id=c.operation_id
            and e.event_type='question.cut_requested'
          where c.tenant_id=$1 and c.operation_id=$2 and c.question_session_id=$3
            and ($4::text is null or c.cut_request_id=$4)
            and e.event_id=$5
          for update of q,o`,
        [input.tenantId, input.operationId, input.questionSessionId, input.cutRequestId ?? null, input.eventId],
      );
      const row = prepared.rows[0];
      if (!row || row.operation_id !== input.operationId) throw new Error("cut request does not match FinalizeQuestion input");
      if (row.payload_ref !== input.inputRef || Number(row.question_session_version) !== input.aggregateVersion) {
        throw new Error("FinalizeQuestion envelope does not match the frozen Cut");
      }
      if (row.lifecycle !== "finalizing") {
        const closed = await client.query("select 1 from science_v3_question_closure where tenant_id=$1 and cut_request_id=$2", [input.tenantId, row.cut_request_id]);
        if (closed.rowCount) return {
          tenantId: input.tenantId,
          operationId: input.operationId,
          cutRequestId: row.cut_request_id,
          questionSessionId: input.questionSessionId,
          gradeTasks: [],
        };
        throw new Error("question session is not finalizing");
      }
      if (row.operation_status === "accepted") {
        await client.query(
          `update science_v3_operation
              set status='running',user_message='正在完成题目结算',updated_at=clock_timestamp(),version=version+1
            where tenant_id=$1 and operation_id=$2 and status='accepted'`,
          [input.tenantId, input.operationId],
        );
      } else if (row.operation_status !== "running") {
        throw new Error("finalize operation is not runnable");
      }

      const attempts = await client.query<AttemptRow>(
        `select a.attempt_id,a.question_revision_id,a.student_id,a.kind,a.content_refs,
                a.hint_level,a.submitted_at,m.parts
           from science_v3_attempt a
           join science_v3_canonical_message m
             on m.tenant_id=a.tenant_id and m.message_id=a.message_id
          where a.tenant_id=$1 and a.question_session_id=$2
            and a.session_sequence <= $3
            and not exists (
              select 1 from science_v3_attempt newer
               where newer.tenant_id=a.tenant_id and newer.supersedes_attempt_id=a.attempt_id
            )
            and not exists (
              select 1 from science_v3_judgment j
               where j.tenant_id=a.tenant_id and j.attempt_id=a.attempt_id
                 and not exists (
                   select 1 from science_v3_judgment newer_j
                    where newer_j.tenant_id=j.tenant_id and newer_j.supersedes_judgment_id=j.judgment_id
                 )
            )
          order by a.session_sequence`,
        [input.tenantId, input.questionSessionId, row.frozen_attempt_sequence],
      );
      const material = await client.query<QuestionMaterialRow>(
        `select q.stem_markdown,q.analysis_markdown,
                coalesce((select jsonb_agg(jsonb_build_object(
                  'item_id',i.item_id,'answer_text',a.answer_text,'equivalence_rule',a.equivalence_rule
                ) order by i.position)
                  from content_revision_item i join content_question_answer_item a using (item_id)
                 where i.tenant_id=q.tenant_id and i.revision_id=q.revision_id),'[]'::jsonb) as answer_items,
                coalesce((select jsonb_agg(jsonb_build_object(
                  'rubric_item_id',i.item_id,'criterion',r.criterion,'score',r.score
                ) order by i.position)
                  from content_revision_item i join content_question_rubric_item r using (item_id)
                 where i.tenant_id=q.tenant_id and i.revision_id=q.revision_id),'[]'::jsonb) as rubric_items,
                coalesce((select jsonb_agg(jsonb_build_object(
                  'measurement_rule_id',i.item_id,'dimension_revision_id',t.dimension_revision_id,
                  'target_role',t.target_role,'evidence_rule',t.evidence_rule
                ) order by i.position)
                  from content_revision_item i join content_question_measurement_target t using (item_id)
                 where i.tenant_id=q.tenant_id and i.revision_id=q.revision_id),'[]'::jsonb) as measurement_targets
           from content_question_revision q
          where q.tenant_id=$1 and q.revision_id=$2`,
        [input.tenantId, row.question_revision_id],
      );
      const question = material.rows[0] ?? {
        stem_markdown: null,
        analysis_markdown: null,
        answer_items: [],
        rubric_items: [],
        measurement_targets: [],
      };

      const gradeTasks: Array<PreparedQuestionFinalization["gradeTasks"][number]> = [];
      for (const attempt of attempts.rows) {
        const judgmentId = idFrom("jdg", `${row.cut_request_id}\0${attempt.attempt_id}`);
        const artifactId = idFrom("art", `${row.cut_request_id}\0${attempt.attempt_id}\0grade-input`);
        const bundle = {
          schema_version: 3,
          task_type: "grade",
          target_judgment_id: judgmentId,
          cut_request_ref: `cut-request:${row.cut_request_id}`,
          question_session: {
            question_session_id: input.questionSessionId,
            question_revision_id: row.question_revision_id,
            external_question_ref: row.external_question_ref,
            frozen_measurement_contract: row.frozen_measurement_contract,
          },
          question: {
            question_revision_id: row.question_revision_id,
            stem_markdown: question.stem_markdown,
            analysis_markdown: question.analysis_markdown,
            answer_items: question.answer_items,
            rubric_items: question.rubric_items,
            measurement_targets: question.measurement_targets,
          },
          attempt: {
            attempt_id: attempt.attempt_id,
            question_revision_id: attempt.question_revision_id,
            student_ref: `student:${attempt.student_id}`,
            kind: attempt.kind,
            content_refs: attempt.content_refs,
            response_parts: attempt.parts,
            hint_level: attempt.hint_level,
            submitted_at: attempt.submitted_at.toISOString(),
          },
          output_requirements: {
            schema_version: 3,
            fact_version: 1,
            fact_type: "judgment",
            judgment_id: judgmentId,
            attempt_id: attempt.attempt_id,
            evidence_refs_must_come_from: attempt.content_refs,
          },
        };
        const artifact = encodeArtifact(bundle);
        await client.query(
          `insert into science_v3_agent_artifact (
             artifact_id,tenant_id,operation_id,artifact_kind,schema_uri,payload,sha256
           ) values ($1,$2,$3,'input_bundle',$4,$5::jsonb,$6)
           on conflict (artifact_id) do nothing`,
          [artifactId, input.tenantId, input.operationId, "https://schemas.mathpilot.dev/science-v3/grade-input/v1", artifact.json, artifact.sha256],
        );
        const workflowInput: AgentTaskWorkflowInput = {
          schemaVersion: 3,
          tenantId: input.tenantId,
          operationId: input.operationId,
          eventId: input.eventId,
          aggregateRef: `question-session:${input.questionSessionId}`,
          aggregateVersion: Number(row.question_session_version),
          taskType: "grade",
          taskSpecVersion: "v1",
          inputRef: `agent-artifact:${artifactId}`,
          idempotencyKey: `${row.cut_request_id}:grade:${attempt.attempt_id}`,
          revision: 1,
          resultOwnership: "parent",
        };
        gradeTasks.push({ attemptId: attempt.attempt_id, judgmentId, workflowInput });
      }
      return {
        tenantId: input.tenantId,
        operationId: input.operationId,
        cutRequestId: row.cut_request_id,
        questionSessionId: input.questionSessionId,
        gradeTasks,
      };
    });
  }

  async recordFinalJudgment(input: RecordFinalJudgmentInput): Promise<void> {
    const artifactId = artifactIdFromRef(input.outputRef);
    await this.withTenant(input.tenantId, async (client) => {
      const existing = await client.query<{ attempt_id: string }>(
        "select attempt_id from science_v3_judgment where tenant_id=$1 and judgment_id=$2",
        [input.tenantId, input.judgmentId],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].attempt_id !== input.attemptId) throw new Error("judgment ID conflicts with another Attempt");
        return;
      }
      const source = await client.query<{
        payload: unknown;
        sha256: string;
        resolved_model_id: string | null;
        prompt_version: string;
        skill_ref: string;
        content_refs: string[];
        frozen_measurement_contract: Record<string, unknown>;
      }>(
        `select art.payload,art.sha256,agt.resolved_model_id,agt.prompt_version,agt.skill_ref,
                a.content_refs,q.frozen_measurement_contract
           from science_v3_agent_artifact art
           join science_v3_agent_attempt agt
             on agt.tenant_id=art.tenant_id and agt.output_ref='agent-artifact:' || art.artifact_id
           join science_v3_attempt a
             on a.tenant_id=art.tenant_id and a.attempt_id=$4
           join science_v3_question_session q
             on q.tenant_id=a.tenant_id and q.question_session_id=a.question_session_id
           join science_v3_cut_request c
             on c.tenant_id=q.tenant_id and c.question_session_id=q.question_session_id
          where art.tenant_id=$1 and art.artifact_id=$2 and art.artifact_kind='structured_output'
            and q.question_session_id=$3 and c.cut_request_id=$5
          order by agt.completed_at desc limit 1`,
        [input.tenantId, artifactId, input.questionSessionId, input.attemptId, input.cutRequestId],
      );
      const row = source.rows[0];
      if (!row) throw new Error("grade output is not authorized for this cut and Attempt");
      const proposal = recordValue(verifiedArtifactPayload(row, "Judgment proposal"), "Judgment proposal");
      if (proposal.schema_version !== 3 || proposal.fact_version !== 1 || proposal.fact_type !== "judgment"
        || proposal.judgment_id !== input.judgmentId || proposal.attempt_id !== input.attemptId) {
        throw new Error("Judgment proposal identity does not match its frozen task");
      }
      const verdict = enumValue(proposal.verdict, "verdict", ["correct", "partially_correct", "incorrect", "unresolved"] as const);
      const uncertainty = enumValue(proposal.uncertainty, "uncertainty", ["low", "medium", "high"] as const);
      const decisionSummary = stringValue(proposal.decision_summary, "decision_summary");
      const evidenceRefs = stringArray(proposal.evidence_refs, "evidence_refs", 1);
      const allowedEvidence = new Set(row.content_refs);
      if (evidenceRefs.some((ref) => !allowedEvidence.has(ref))) throw new Error("Judgment cites evidence outside the frozen Attempt");

      if (!Array.isArray(proposal.rubric_results) || proposal.rubric_results.length < 1) throw new Error("rubric_results is invalid");
      const rubricResults = proposal.rubric_results.map((value, index) => {
        const item = recordValue(value, `rubric_results[${index}]`);
        const itemEvidence = stringArray(item.evidence_refs, `rubric_results[${index}].evidence_refs`, 1);
        if (itemEvidence.some((ref) => !allowedEvidence.has(ref))) throw new Error("rubric result cites evidence outside the frozen Attempt");
        return {
          rubric_item_id: stringValue(item.rubric_item_id, "rubric_item_id", 160),
          status: enumValue(item.status, "rubric status", ["met", "not_met", "unclear"] as const),
          evidence_refs: itemEvidence,
        };
      });
      if (new Set(rubricResults.map((item) => item.rubric_item_id)).size !== rubricResults.length) {
        throw new Error("rubric_results contains duplicate rubric items");
      }
      const rubricById = new Map(rubricResults.map((item) => [item.rubric_item_id, item.status]));
      if (!Array.isArray(proposal.dimension_proposals)) throw new Error("dimension_proposals is invalid");
      const frozenDimensions = new Set(stringArray(row.frozen_measurement_contract.dimension_revision_ids, "frozen dimensions"));
      const dimensionProposals = proposal.dimension_proposals.map((value, index) => {
        const item = recordValue(value, `dimension_proposals[${index}]`);
        const dimension = stringValue(item.dimension_revision_id, "dimension_revision_id", 160);
        const rubricItem = stringValue(item.rubric_item_id, "rubric_item_id", 160);
        const outcome = enumValue(item.outcome, "dimension outcome", ["success", "failure", "unresolved"] as const);
        if (!frozenDimensions.has(dimension)) throw new Error("Judgment proposes an unfrozen dimension");
        const rubricStatus = rubricById.get(rubricItem);
        if (!rubricStatus || outcome === "success" && rubricStatus !== "met" || outcome === "failure" && rubricStatus !== "not_met") {
          throw new Error("dimension proposal contradicts its rubric result");
        }
        return { dimension_revision_id: dimension, rubric_item_id: rubricItem, outcome };
      });
      if (new Set(dimensionProposals.map((item) => item.dimension_revision_id)).size !== dimensionProposals.length) {
        throw new Error("dimension_proposals contains duplicate dimensions");
      }

      await client.query(
        `insert into science_v3_judgment (
           judgment_id,tenant_id,attempt_id,verdict,rubric_results,dimension_proposals,
           uncertainty,decision_summary,evidence_refs,model_id,prompt_version,
           skill_version,created_at,fact_version
         ) values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12,clock_timestamp(),1)`,
        [
          input.judgmentId,
          input.tenantId,
          input.attemptId,
          verdict,
          JSON.stringify(rubricResults),
          JSON.stringify(dimensionProposals),
          uncertainty,
          decisionSummary,
          evidenceRefs,
          row.resolved_model_id ?? "unresolved-model",
          row.prompt_version,
          row.skill_ref,
        ],
      );
    });
  }

  async recordUnresolvedJudgment(input: RecordUnresolvedJudgmentInput): Promise<void> {
    await this.withTenant(input.tenantId, async (client) => {
      const attempt = await client.query<{ content_refs: string[] }>(
        `select a.content_refs from science_v3_attempt a
          join science_v3_cut_request c
            on c.tenant_id=a.tenant_id and c.question_session_id=a.question_session_id
         where a.tenant_id=$1 and a.attempt_id=$2 and a.question_session_id=$3
           and c.cut_request_id=$4 and a.session_sequence <= c.frozen_attempt_sequence`,
        [input.tenantId, input.attemptId, input.questionSessionId, input.cutRequestId],
      );
      const contentRefs = attempt.rows[0]?.content_refs;
      if (!contentRefs) throw new Error("Attempt is not part of the frozen cut window");
      const rubricResults = [{ rubric_item_id: "unresolved", status: "unclear", evidence_refs: contentRefs }];
      await client.query(
        `insert into science_v3_judgment (
           judgment_id,tenant_id,attempt_id,verdict,rubric_results,dimension_proposals,
           uncertainty,decision_summary,evidence_refs,model_id,prompt_version,
           skill_version,created_at,fact_version
         ) values ($1,$2,$3,'unresolved',$4::jsonb,'[]'::jsonb,'high',$5,$6,
                   'mathpilot-host','grade-fallback-v1','question-grade@v1',clock_timestamp(),1)
         on conflict (tenant_id,attempt_id,fact_version) do nothing`,
        [input.judgmentId, input.tenantId, input.attemptId, JSON.stringify(rubricResults), input.reason.slice(0, 2000), contentRefs],
      );
    });
  }

  async commitClosure(input: CommitQuestionClosureInput): Promise<QuestionClosureResult> {
    return this.withTenant(input.tenantId, async (client) => {
      const existing = await client.query<{
        question_closure_id: string;
        question_session_id: string;
        close_reason: string;
        judgment_refs: string[];
        observation_refs: string[];
        session_version: string;
      }>(
        `select c.question_closure_id,c.question_session_id,c.close_reason,
                c.judgment_refs,c.observation_refs,q.version as session_version
           from science_v3_question_closure c
           join science_v3_question_session q
             on q.tenant_id=c.tenant_id and q.question_session_id=c.question_session_id
          where c.tenant_id=$1 and c.cut_request_id=$2`,
        [input.tenantId, input.cutRequestId],
      );
      if (existing.rows[0]) return this.closureResult(existing.rows[0]);

      const locked = await client.query<{
        operation_id: string;
        operation_status: string;
        idempotency_key: string;
        reason: string;
        conversation_thread_id: string;
        frozen_attempt_sequence: string;
        lifecycle: string;
        session_version: string;
        student_id: string;
        question_revision_id: string | null;
        external_question_ref: string | null;
        frozen_measurement_contract: Record<string,unknown>;
        learning_activity_id: string | null;
      }>(
        `select c.operation_id,o.status as operation_status,c.idempotency_key,c.reason,
                q.conversation_thread_id,c.frozen_attempt_sequence,q.lifecycle,q.version as session_version,q.student_id,
                q.question_revision_id,q.external_question_ref,q.frozen_measurement_contract,q.learning_activity_id
           from science_v3_cut_request c
           join science_v3_question_session q
             on q.tenant_id=c.tenant_id and q.question_session_id=c.question_session_id
           join science_v3_operation o
             on o.tenant_id=c.tenant_id and o.operation_id=c.operation_id
          where c.tenant_id=$1 and c.cut_request_id=$2 and c.question_session_id=$3
          for update of q,o`,
        [input.tenantId, input.cutRequestId, input.questionSessionId],
      );
      const cut = locked.rows[0];
      if (!cut || cut.operation_id !== input.operationId || cut.lifecycle !== "finalizing" || cut.operation_status !== "running") {
        throw new Error("question cut is not ready for closure commit");
      }
      const missing = await client.query<{ attempt_id: string }>(
        `select a.attempt_id from science_v3_attempt a
          where a.tenant_id=$1 and a.question_session_id=$2 and a.session_sequence <= $3
            and not exists (
              select 1 from science_v3_attempt newer
               where newer.tenant_id=a.tenant_id and newer.supersedes_attempt_id=a.attempt_id
            )
            and not exists (
              select 1 from science_v3_judgment j
               where j.tenant_id=a.tenant_id and j.attempt_id=a.attempt_id
                 and not exists (
                   select 1 from science_v3_judgment newer_j
                    where newer_j.tenant_id=j.tenant_id and newer_j.supersedes_judgment_id=j.judgment_id
                 )
            )
          order by a.session_sequence limit 1`,
        [input.tenantId, input.questionSessionId, cut.frozen_attempt_sequence],
      );
      if (missing.rows[0]) throw new Error(`Attempt ${missing.rows[0].attempt_id} has no final Judgment`);

      const closedAt = new Date();
      const scientific = await compileAndProjectQuestion(client, {
        tenantId: input.tenantId,
        questionSessionId: input.questionSessionId,
        frozenAttemptSequence: Number(cut.frozen_attempt_sequence),
        projectedAt: closedAt.toISOString(),
      });

      const attempts = await client.query<{
        attempt_id: string;
        kind: string;
        hint_level: number;
        content_refs: string[];
        submitted_at: Date | string;
      }>(
        `select a.attempt_id,a.kind,a.hint_level,a.content_refs,a.submitted_at
           from science_v3_attempt a
          where a.tenant_id=$1 and a.question_session_id=$2 and a.session_sequence <= $3
            and not exists(select 1 from science_v3_attempt newer
                            where newer.tenant_id=a.tenant_id and newer.supersedes_attempt_id=a.attempt_id)
          order by a.session_sequence`,
        [input.tenantId,input.questionSessionId,cut.frozen_attempt_sequence],
      );
      const judgments = await client.query<{
        judgment_id: string;
        ref: string;
        verdict: string;
        rubric_results: unknown;
        uncertainty: string;
        summary: string;
        dimension_revision_ids: string[];
        evidence_refs: string[];
        model_id: string;
        prompt_version: string;
        skill_version: string;
        fact_version: string;
        created_at: Date | string;
      }>(
        `select j.judgment_id,'judgment://' || j.judgment_id as ref,j.verdict,j.rubric_results,
                j.uncertainty,j.decision_summary as summary,j.evidence_refs,j.model_id,
                j.prompt_version,j.skill_version,j.fact_version,j.created_at,
                coalesce(array(
                  select distinct proposal->>'dimension_revision_id'
                    from jsonb_array_elements(j.dimension_proposals) proposal
                   where proposal ? 'dimension_revision_id'
                ),'{}'::text[]) as dimension_revision_ids
           from science_v3_judgment j join science_v3_attempt a
             on a.tenant_id=j.tenant_id and a.attempt_id=j.attempt_id
          where j.tenant_id=$1 and a.question_session_id=$2 and a.session_sequence <= $3
            and not exists (
              select 1 from science_v3_judgment newer
               where newer.tenant_id=j.tenant_id and newer.supersedes_judgment_id=j.judgment_id
            )
            and not exists (
              select 1 from science_v3_attempt newer_a
               where newer_a.tenant_id=a.tenant_id and newer_a.supersedes_attempt_id=a.attempt_id
            )
          order by a.session_sequence,j.fact_version`,
        [input.tenantId, input.questionSessionId, cut.frozen_attempt_sequence],
      );
      const observations = await client.query<{
        ref: string;
        summary: string;
        dimension_revision_ids: string[];
        evidence_refs: string[];
      }>(
        `select 'observation://' || o.observation_id as ref,
                ('Observed ' || o.outcome || ' for ' || o.dimension_revision_id) as summary,
                array[o.dimension_revision_id]::text[] as dimension_revision_ids,o.evidence_refs
           from science_v3_observation o join science_v3_judgment j
             on j.tenant_id=o.tenant_id and j.judgment_id=o.judgment_id
           join science_v3_attempt a on a.tenant_id=j.tenant_id and a.attempt_id=j.attempt_id
          where o.tenant_id=$1 and a.question_session_id=$2 and a.session_sequence <= $3
            and not exists (
              select 1 from science_v3_observation newer
               where newer.tenant_id=o.tenant_id and newer.supersedes_observation_id=o.observation_id
            )
            and not exists (
              select 1 from science_v3_judgment newer_j
               where newer_j.tenant_id=j.tenant_id and newer_j.supersedes_judgment_id=j.judgment_id
            )
            and not exists (
              select 1 from science_v3_attempt newer_a
               where newer_a.tenant_id=a.tenant_id and newer_a.supersedes_attempt_id=a.attempt_id
            )
          order by o.occurred_at,o.observation_id`,
        [input.tenantId, input.questionSessionId, cut.frozen_attempt_sequence],
      );
      const errorEvidence = await client.query<{
        ref: string;
        summary: string;
        error_cause_revision_ids: string[];
        evidence_refs: string[];
      }>(
        `select 'error-evidence://' || evidence.error_evidence_id as ref,
                ('Error evidence ' || evidence.relation || ' (' || evidence.kind || ', ' || evidence.quality || ')') as summary,
                array[evidence.error_cause_revision_id]::text[] as error_cause_revision_ids,
                evidence.evidence_refs
           from science_v3_error_evidence evidence
          where evidence.tenant_id=$1 and evidence.question_session_id=$2
            and not exists(select 1 from science_v3_error_evidence newer
                            where newer.tenant_id=evidence.tenant_id
                              and newer.supersedes_error_evidence_id=evidence.error_evidence_id)
          order by evidence.created_at,evidence.error_evidence_id`,
        [input.tenantId,input.questionSessionId],
      );
      const priorAnnotations = await client.query<{
        annotation_id: string;
        claim: string;
        scope: Record<string,string>;
      }>(
        `select annotation.annotation_id,annotation.claim,annotation.scope
           from science_v3_semantic_annotation annotation
          where annotation.tenant_id=$1 and annotation.student_id=$2
            and not exists(select 1 from science_v3_annotation_supersession supersession
                            where supersession.tenant_id=annotation.tenant_id
                              and supersession.superseded_annotation_id=annotation.annotation_id)
            and not exists(select 1 from science_v3_annotation_stale_fact stale
                            where stale.tenant_id=annotation.tenant_id and stale.annotation_id=annotation.annotation_id)
            and coalesce((select preference.enabled from science_v3_annotation_usage_preference_event preference
                           where preference.tenant_id=annotation.tenant_id and preference.student_id=annotation.student_id
                             and preference.annotation_id=annotation.annotation_id
                           order by preference.created_at desc,preference.preference_event_id desc limit 1),true)
            and coalesce((select preference.enabled from science_v3_annotation_usage_preference_event preference
                           where preference.tenant_id=annotation.tenant_id and preference.student_id=annotation.student_id
                             and preference.annotation_id is null
                           order by preference.created_at desc,preference.preference_event_id desc limit 1),true)
          order by annotation.set_version desc,annotation.annotation_id limit 32`,
        [input.tenantId,cut.student_id],
      );
      const judgmentRefs = judgments.rows.map((row) => row.ref);
      const observationRefs = observations.rows.map((row) => row.ref);
      const closureId = idFrom("qcl", input.cutRequestId);
      const artifactId = idFrom("art", `${input.cutRequestId}\0question-closed`);
      const closedEventId = idFrom("evt", `${input.cutRequestId}\0question-closed`);
      const dreamRunId = idFrom("drm",`${input.questionSessionId}\0${LIGHT_COMPILER_VERSION}`);
      const sessionVersion = Number(cut.session_version) + 1;
      const status = cut.reason === "abandoned" ? "abandoned" : "closed";
      const diagnosticStatus = cut.reason === "skipped" || cut.reason === "abandoned" ? "skipped" : "unclassified";
      const projectionRefs = [
        ...scientific.masteryProjectionRefs,
        ...scientific.retentionProjectionRefs,
        ...scientific.errorPatternProjectionRefs,
      ].map(projectionEvidenceRef);
      const sourceManifest = [...new Set([
        `question-session://${input.questionSessionId}`,
        `question-closure://${closureId}`,
        ...attempts.rows.flatMap((row) => [`attempt://${row.attempt_id}`,...row.content_refs]),
        ...judgments.rows.flatMap((row) => [row.ref,...row.evidence_refs]),
        ...observations.rows.flatMap((row) => [row.ref,...row.evidence_refs]),
        ...errorEvidence.rows.flatMap((row) => [row.ref,...row.evidence_refs]),
        ...projectionRefs,
      ])].slice(0,512);
      const payload = {
        schema_version: 3,
        compiler_version: LIGHT_COMPILER_VERSION,
        dream_run_id: dreamRunId,
        student_id: cut.student_id,
        question_session_id: input.questionSessionId,
        question_closure_ref: `question-closure:${closureId}`,
        frozen_context: {
          ...(cut.question_revision_id ? { question_revision_id: cut.question_revision_id }
            : { external_question_ref: cut.external_question_ref }),
          measurement_contract: cut.frozen_measurement_contract,
          ...(cut.learning_activity_id ? { learning_activity_ref: `learning-activity:${cut.learning_activity_id}` } : {}),
        },
        effective_attempts: attempts.rows.map((row) => ({
          attempt_ref: `attempt://${row.attempt_id}`,
          kind: row.kind,
          hint_level: row.hint_level,
          content_refs: row.content_refs,
          submitted_at: toIso(row.submitted_at),
        })),
        judgments: judgments.rows.map((row) => ({
          fact_ref: row.ref,summary: row.summary,dimension_revision_ids: row.dimension_revision_ids,
        })),
        observations: observations.rows.map((row) => ({
          fact_ref: row.ref,summary: row.summary,dimension_revision_ids: row.dimension_revision_ids,
        })),
        error_evidence: errorEvidence.rows.map((row) => ({
          fact_ref: row.ref,summary: row.summary,error_cause_revision_ids: row.error_cause_revision_ids,
        })),
        projection_refs: projectionRefs,
        source_manifest: sourceManifest,
        prior_annotations: priorAnnotations.rows.map((row) => ({
          annotation_ref: `annotation://${row.annotation_id}`,claim: row.claim,scope: row.scope,freshness: "current",
        })),
        closed_at: closedAt.toISOString(),
        history_is_untrusted_data: true,
      };
      const artifact = encodeArtifact(payload);

      await client.query(
        `insert into science_v3_question_closure (
           question_closure_id,tenant_id,question_session_id,cut_request_id,operation_id,
           close_reason,diagnostic_status,judgment_refs,observation_refs,
           scientific_commit_version,closed_at,version
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,1)`,
        [closureId, input.tenantId, input.questionSessionId, input.cutRequestId, input.operationId, cut.reason, diagnosticStatus, judgmentRefs, observationRefs, closedAt],
      );
      await client.query(
        `update science_v3_question_session
            set lifecycle=$3,closed_at=$4,close_reason=$5,version=$6
          where tenant_id=$1 and question_session_id=$2`,
        [input.tenantId, input.questionSessionId, status, closedAt, cut.reason, sessionVersion],
      );
      await client.query(
        `update science_v3_foreground_agent_epoch
            set ended_at=$3,version=version+1
          where tenant_id=$1 and active_question_session_id=$2 and ended_at is null`,
        [input.tenantId, input.questionSessionId, closedAt],
      );
      const thread = (await client.query<{ next_message_sequence: string }>(
        `select next_message_sequence from science_v3_conversation_thread
          where tenant_id=$1 and conversation_thread_id=$2 for update`,
        [input.tenantId, cut.conversation_thread_id],
      )).rows[0];
      if (!thread) throw new Error("question closure lost its ConversationThread");
      const closureMessageId = idFrom("msg", `${closureId}\0domain-presentation`);
      const judgmentParts = judgments.rows.map((judgment) => ({
        type: "domain_ui",
        part: {
          schema: "mathpilot.message-part/domain-ui/v1",
          part_id: idFrom("part", `${judgment.judgment_id}\0presentation`),
          view_kind: "judgment",
          resource_ref: `judgment:${judgment.judgment_id}`,
          resource_version: Number(judgment.fact_version),
          snapshot: {
            schema: "mathpilot.view/judgment/v1",
            title: verdictTitle(judgment.verdict),
            summary: judgment.summary,
            data: {
              judgment_id: judgment.judgment_id,
              verdict: judgment.verdict,
              rubric_results: publicRubricResults(judgment.rubric_results),
              uncertainty: judgment.uncertainty,
              evidence_count: judgment.evidence_refs.length,
              model_id: judgment.model_id,
              prompt_version: judgment.prompt_version,
              skill_version: judgment.skill_version,
            },
          },
          action_slots: ["view_evidence"],
          occurred_at: toIso(judgment.created_at),
          origin: "domain_projector",
          domain_event_ref: `fact://judgment/${judgment.judgment_id}`,
        },
      }));
      const closurePart = {
        type: "domain_ui",
        part: {
          schema: "mathpilot.message-part/domain-ui/v1",
          part_id: idFrom("part", `${closureId}\0presentation`),
          view_kind: "question_closure",
          resource_ref: `question-closure:${closureId}`,
          resource_version: 1,
          snapshot: {
            schema: "mathpilot.view/question_closure/v1",
            title: "本题已结束",
            summary: closureSummary(cut.reason, judgmentRefs.length, observationRefs.length),
            data: {
              question_closure_id: closureId,
              question_session_id: input.questionSessionId,
              close_reason: cut.reason,
              diagnostic_status: diagnosticStatus,
              judgment_count: judgmentRefs.length,
              observation_count: observationRefs.length,
            },
          },
          action_slots: [],
          occurred_at: closedAt.toISOString(),
          origin: "domain_projector",
          domain_event_ref: `event://question-closed/${closedEventId}`,
        },
      };
      const insertedMessage = await client.query(
        `insert into science_v3_canonical_message(
           message_id,tenant_id,conversation_thread_id,sequence,author_kind,lifecycle,
           parts,question_session_id,editable,lock_reason,created_at,version
         ) values($1,$2,$3,$4,'system','committed',$5::jsonb,$6,false,'domain_event',$7,1)
         on conflict (tenant_id,message_id) do nothing returning 1`,
        [closureMessageId,input.tenantId,cut.conversation_thread_id,Number(thread.next_message_sequence),
          JSON.stringify([...judgmentParts,closurePart]),input.questionSessionId,closedAt],
      );
      if (insertedMessage.rowCount) {
        await client.query(
          `update science_v3_conversation_thread
              set next_message_sequence=next_message_sequence+1,
                  updated_at=clock_timestamp(),version=version+1
            where tenant_id=$1 and conversation_thread_id=$2`,
          [input.tenantId,cut.conversation_thread_id],
        );
      }
      await client.query(
        `insert into science_v3_agent_artifact (
           artifact_id,tenant_id,operation_id,artifact_kind,schema_uri,payload,sha256
         ) values ($1,$2,$3,'input_bundle',$4,$5::jsonb,$6)`,
        [artifactId, input.tenantId, input.operationId, "https://schemas.mathpilot.dev/science-v3/light-input/v1", artifact.json, artifact.sha256],
      );
      await client.query(
        `insert into science_v3_operation_result (
           tenant_id,operation_id,idempotency_key,result_status,aggregate_ref,
           aggregate_version,result_resource_refs
         ) values ($1,$2,$3,'committed',$4,$5,$6)`,
        [input.tenantId, input.operationId, cut.idempotency_key, `question-session:${input.questionSessionId}`, sessionVersion, [`question-closure:${closureId}`, `question-session:${input.questionSessionId}`]],
      );
      await client.query(
        `update science_v3_operation
            set status='succeeded',user_message='当前题目已结算',retryable=false,
                related_resource_refs=$3,updated_at=clock_timestamp(),version=version+1
          where tenant_id=$1 and operation_id=$2 and status='running'`,
        [input.tenantId, input.operationId, [`question-closure:${closureId}`, `question-session:${input.questionSessionId}`]],
      );
      await client.query(
        `insert into infra_outbox (
           event_id,tenant_id,aggregate_type,aggregate_id,event_type,payload,
           correlation_id,causation_id,occurred_at,aggregate_version,payload_ref,operation_id
         ) values ($1,$2,'question-session',$3,'question.closed','{}'::jsonb,
                   $4,$5,$6,$7,$8,$4)`,
        [closedEventId, input.tenantId, input.questionSessionId, input.operationId, input.eventId, closedAt, sessionVersion, `agent-artifact:${artifactId}`],
      );
      await client.query(
        `insert into science_v3_dream_run(
           dream_run_id,tenant_id,student_id,operation_id,source_event_id,phase,window_ref,
           compiler_version,policy_version,input_artifact_id
         ) values($1,$2,$3,$4,$5,'light',$6,$7,$8,$9)
         on conflict (tenant_id,phase,window_ref,compiler_version) do nothing`,
        [dreamRunId,input.tenantId,cut.student_id,input.operationId,closedEventId,
          `question-session:${input.questionSessionId}`,LIGHT_COMPILER_VERSION,DEEP_GATE_POLICY_VERSION,artifactId],
      );
      return {
        questionClosureId: closureId,
        questionSessionId: input.questionSessionId,
        status,
        sessionVersion,
        judgmentRefs,
        observationRefs,
      };
    });
  }

  async replayCorrection(input: ScientificReplayWorkflowInput): Promise<ScientificReplayResult> {
    return this.withTenant(input.tenantId, async (client) => {
      const correction = await client.query<{
        teacher_correction_id: string;
        operation_id: string;
        operation_status: string;
        idempotency_key: string;
        student_id: string;
        question_session_id: string;
        conversation_thread_id: string;
        teacher_user_id: string;
        target_judgment_id: string;
        replacement_judgment_id: string;
        reason: string;
        fact_version: string;
        requested_at: Date | string;
        frozen_attempt_sequence: string;
        event_id: string;
        payload_ref: string;
      }>(
        `select c.teacher_correction_id,c.operation_id,o.status as operation_status,
                c.idempotency_key,c.student_id,c.question_session_id,q.conversation_thread_id,
                c.teacher_user_id,c.target_judgment_id,c.replacement_judgment_id,c.reason,
                c.fact_version,c.requested_at,q.frozen_attempt_sequence,e.event_id,e.payload_ref
           from science_v3_teacher_correction c
           join science_v3_operation o
             on o.tenant_id=c.tenant_id and o.operation_id=c.operation_id
           join science_v3_question_session q
             on q.tenant_id=c.tenant_id and q.question_session_id=c.question_session_id
           join infra_outbox e
             on e.tenant_id=c.tenant_id and e.operation_id=c.operation_id
            and e.event_type='teacher.correction_recorded'
          where c.tenant_id=$1 and c.teacher_correction_id=$2 and c.operation_id=$3
            and e.event_id=$4
          for update of o`,
        [input.tenantId,input.teacherCorrectionId,input.operationId,input.eventId],
      );
      const row = correction.rows[0];
      if (!row || row.student_id !== input.studentId
          || Number(row.fact_version) !== input.aggregateVersion
          || row.payload_ref !== input.inputRef
          || row.event_id !== input.eventId
          || row.frozen_attempt_sequence === null) {
        throw new Error("teacher correction replay envelope does not match its fact");
      }
      const existing = await client.query<{ result_resource_refs: string[] }>(
        `select result_resource_refs from science_v3_operation_result
          where tenant_id=$1 and operation_id=$2 and idempotency_key=$3`,
        [input.tenantId,input.operationId,row.idempotency_key],
      );
      if (existing.rows[0]) {
        return {
          teacherCorrectionId: row.teacher_correction_id,
          questionSessionId: row.question_session_id,
          masteryProjectionRefs: existing.rows[0].result_resource_refs.filter((ref) => ref.startsWith("mastery-projection:")),
          retentionProjectionRefs: existing.rows[0].result_resource_refs.filter((ref) => ref.startsWith("retention-projection:")),
          errorPatternProjectionRefs: existing.rows[0].result_resource_refs.filter((ref) => ref.startsWith("error-pattern-projection:")),
        };
      }
      if (row.operation_status === "accepted") {
        await client.query(
          `update science_v3_operation
              set status='running',user_message='正在重放科学状态',updated_at=clock_timestamp(),version=version+1
            where tenant_id=$1 and operation_id=$2 and status='accepted'`,
          [input.tenantId,input.operationId],
        );
      } else if (row.operation_status !== "running") {
        throw new Error("teacher correction operation is not replayable");
      }
      const scientific = await compileAndProjectQuestion(client, {
        tenantId: input.tenantId,
        questionSessionId: row.question_session_id,
        frozenAttemptSequence: Number(row.frozen_attempt_sequence),
        projectedAt: new Date(row.requested_at).toISOString(),
      });
      const sessionRefs = (await client.query<{ ref: string }>(
        `select 'attempt://' || attempt.attempt_id as ref
           from science_v3_attempt attempt where attempt.tenant_id=$1 and attempt.question_session_id=$2
         union
         select unnest(attempt.content_refs) as ref
           from science_v3_attempt attempt where attempt.tenant_id=$1 and attempt.question_session_id=$2
         union
         select 'judgment://' || judgment.judgment_id as ref
           from science_v3_judgment judgment join science_v3_attempt attempt
             on attempt.tenant_id=judgment.tenant_id and attempt.attempt_id=judgment.attempt_id
          where judgment.tenant_id=$1 and attempt.question_session_id=$2
         union
         select 'observation://' || observation.observation_id as ref
           from science_v3_observation observation where observation.tenant_id=$1 and observation.question_session_id=$2
         union
         select 'error-evidence://' || evidence.error_evidence_id as ref
           from science_v3_error_evidence evidence where evidence.tenant_id=$1 and evidence.question_session_id=$2`,
        [input.tenantId,row.question_session_id],
      )).rows.map((item) => item.ref);
      const affectedAnnotations = sessionRefs.length ? (await client.query<{ annotation_id: string }>(
        `select annotation.annotation_id from science_v3_semantic_annotation annotation
          where annotation.tenant_id=$1 and annotation.student_id=$2
            and (annotation.support_refs && $3::text[] or annotation.counter_refs && $3::text[])
            and not exists(select 1 from science_v3_annotation_supersession supersession
                            where supersession.tenant_id=annotation.tenant_id
                              and supersession.superseded_annotation_id=annotation.annotation_id)
            and not exists(select 1 from science_v3_annotation_stale_fact stale
                            where stale.tenant_id=annotation.tenant_id and stale.annotation_id=annotation.annotation_id)
          order by annotation.annotation_id`,
        [input.tenantId,row.student_id,sessionRefs],
      )).rows : [];
      let staleInserted = 0;
      for (const annotation of affectedAnnotations) {
        const inserted = await client.query(
          `insert into science_v3_annotation_stale_fact(
             annotation_stale_id,tenant_id,student_id,annotation_id,caused_by_ref,reason
           ) values($1,$2,$3,$4,$5,$6)
           on conflict (tenant_id,annotation_id) do nothing returning 1`,
          [idFrom("ast",`${row.teacher_correction_id}\0${annotation.annotation_id}`),input.tenantId,row.student_id,
            annotation.annotation_id,`teacher-correction:${row.teacher_correction_id}`,
            "Teacher correction superseded a QuestionSession fact used by this annotation."],
        );
        staleInserted += inserted.rowCount ?? 0;
      }
      if (staleInserted) {
        await client.query(
          `insert into science_v3_annotation_set_head(tenant_id,student_id,version)
           values($1,$2,0) on conflict (tenant_id,student_id) do nothing`,
          [input.tenantId,row.student_id],
        );
        await client.query(
          `update science_v3_annotation_set_head
              set version=version+1,updated_at=clock_timestamp()
            where tenant_id=$1 and student_id=$2`,
          [input.tenantId,row.student_id],
        );
      }
      const resourceRefs = [
        `teacher-correction:${row.teacher_correction_id}`,
        ...scientific.masteryProjectionRefs,
        ...scientific.errorPatternProjectionRefs,
        ...scientific.retentionProjectionRefs,
      ].slice(0,32);
      await client.query(
        `insert into science_v3_operation_result (
           tenant_id,operation_id,idempotency_key,result_status,aggregate_ref,
           aggregate_version,result_resource_refs
         ) values ($1,$2,$3,'committed',$4,$5,$6)`,
        [input.tenantId,input.operationId,row.idempotency_key,
          `student:${row.student_id}`,input.aggregateVersion,resourceRefs],
      );
      await client.query(
        `update science_v3_operation
            set status='succeeded',user_message='教师纠正已重放',retryable=false,
                related_resource_refs=$3,updated_at=clock_timestamp(),version=version+1
          where tenant_id=$1 and operation_id=$2 and status='running'`,
        [input.tenantId,input.operationId,resourceRefs],
      );
      const replacement = (await client.query<{
        verdict: string; rubric_results: unknown; uncertainty: string; decision_summary: string;
        evidence_refs: string[]; model_id: string; prompt_version: string; skill_version: string;
        fact_version: string; created_at: Date | string;
      }>(
        `select verdict,rubric_results,uncertainty,decision_summary,evidence_refs,
                model_id,prompt_version,skill_version,fact_version,created_at
           from science_v3_judgment
          where tenant_id=$1 and judgment_id=$2`,
        [input.tenantId,row.replacement_judgment_id],
      )).rows[0];
      if (!replacement) throw new Error("teacher correction replacement Judgment is missing");
      const thread = (await client.query<{ next_message_sequence: string }>(
        `select next_message_sequence from science_v3_conversation_thread
          where tenant_id=$1 and conversation_thread_id=$2 for update`,
        [input.tenantId,row.conversation_thread_id],
      )).rows[0];
      if (!thread) throw new Error("teacher correction lost its ConversationThread");
      const messageId = idFrom("msg", `${row.teacher_correction_id}\0domain-presentation`);
      const part = {
        type: "domain_ui",
        part: {
          schema: "mathpilot.message-part/domain-ui/v1",
          part_id: idFrom("part", `${row.replacement_judgment_id}\0presentation`),
          view_kind: "judgment",
          resource_ref: `judgment:${row.replacement_judgment_id}`,
          resource_version: Number(replacement.fact_version),
          snapshot: {
            schema: "mathpilot.view/judgment/v1",
            title: `判定已更正 · ${verdictTitle(replacement.verdict)}`,
            summary: replacement.decision_summary,
            data: {
              judgment_id: row.replacement_judgment_id,
              verdict: replacement.verdict,
              rubric_results: publicRubricResults(replacement.rubric_results),
              uncertainty: replacement.uncertainty,
              evidence_count: replacement.evidence_refs.length,
              model_id: replacement.model_id,
              prompt_version: replacement.prompt_version,
              skill_version: replacement.skill_version,
              supersedes_judgment_id: row.target_judgment_id,
              teacher_correction_id: row.teacher_correction_id,
              correction_reason: row.reason,
              corrected_by: row.teacher_user_id,
            },
          },
          action_slots: ["view_evidence"],
          occurred_at: toIso(replacement.created_at),
          origin: "domain_projector",
          domain_event_ref: `event://teacher-correction/${row.teacher_correction_id}`,
        },
      };
      const insertedMessage = await client.query(
        `insert into science_v3_canonical_message(
           message_id,tenant_id,conversation_thread_id,sequence,author_kind,lifecycle,
           parts,question_session_id,editable,lock_reason,created_at,version
         ) values($1,$2,$3,$4,'system','committed',$5::jsonb,$6,false,'domain_event',$7,1)
         on conflict (tenant_id,message_id) do nothing returning 1`,
        [messageId,input.tenantId,row.conversation_thread_id,Number(thread.next_message_sequence),
          JSON.stringify([part]),row.question_session_id,replacement.created_at],
      );
      if (insertedMessage.rowCount) {
        await client.query(
          `update science_v3_conversation_thread
              set next_message_sequence=next_message_sequence+1,
                  updated_at=clock_timestamp(),version=version+1
            where tenant_id=$1 and conversation_thread_id=$2`,
          [input.tenantId,row.conversation_thread_id],
        );
      }
      return {
        teacherCorrectionId: row.teacher_correction_id,
        questionSessionId: row.question_session_id,
        masteryProjectionRefs: resourceRefs.filter((ref) => ref.startsWith("mastery-projection:")),
        retentionProjectionRefs: resourceRefs.filter((ref) => ref.startsWith("retention-projection:")),
        errorPatternProjectionRefs: resourceRefs.filter((ref) => ref.startsWith("error-pattern-projection:")),
      };
    });
  }

  private closureResult(row: {
    question_closure_id: string;
    question_session_id: string;
    close_reason: string;
    judgment_refs: string[];
    observation_refs: string[];
    session_version: string;
  }): QuestionClosureResult {
    return {
      questionClosureId: row.question_closure_id,
      questionSessionId: row.question_session_id,
      status: row.close_reason === "abandoned" ? "abandoned" : "closed",
      sessionVersion: Number(row.session_version),
      judgmentRefs: row.judgment_refs,
      observationRefs: row.observation_refs,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
