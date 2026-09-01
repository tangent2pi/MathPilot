import { createHash } from "node:crypto";
import { MATH_DERIVATION_ARTIFACT_SCHEMA_URI } from "@mathpilot/contracts";
import pg from "pg";
import { digestJson, encodeArtifact, verifiedArtifactPayload } from "./artifact-integrity.ts";
import { parseForegroundTeachingOutput } from "./foreground-core.ts";
import type {
  CommitForegroundResponseInput,
  ExecuteLearningActionInput,
  ForegroundResponseCommitResult,
  LearningActionResult,
} from "./runtime-types.ts";

const idFrom = (prefix: string, value: string): string =>
  `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
const asIso = (value: Date | string): string => new Date(value).toISOString();

interface ForegroundContext {
  foreground_request_id: string;
  request_status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  conversation_thread_id: string;
  foreground_epoch_id: string;
  triggering_message_id: string;
  student_id: string;
  user_id: string;
  thread_status: "active" | "archived";
  thread_version: string;
  active_question_session_id: string | null;
  attempt_status: string;
}

interface StoredAction {
  action_type: LearningActionResult["action"];
  payload_sha256: string;
  accepted: boolean;
  result_resource_ref: string | null;
  rejection_code: LearningActionResult["rejection_code"] | null;
}

export interface ForegroundStore {
  executeAction(input: ExecuteLearningActionInput): Promise<LearningActionResult>;
  commitResponse(input: CommitForegroundResponseInput): Promise<ForegroundResponseCommitResult>;
  close(): Promise<void>;
}

export class PostgresForegroundStore implements ForegroundStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 4 });
  }

  private async withTenant<T>(tenantId: string, run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select set_config('app.current_tenant',$1,true),set_config('app.current_user','',true),set_config('app.current_roles','',true)",
        [tenantId],
      );
      const result = await run(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async executeAction(input: ExecuteLearningActionInput): Promise<LearningActionResult> {
    if (!input.toolCallId || input.toolCallId.length > 255) throw new Error("learning_action tool call ID is invalid");
    const payloadHash = digestJson(input.action);
    const actionId = idFrom("lna", `${input.agentAttemptId}\0${input.toolCallId}`);
    return this.withTenant(input.tenantId, async (client) => {
      const context = await this.context(client, input, true);
      const existing = (await client.query<StoredAction>(
        `select action_type,payload_sha256,accepted,result_resource_ref,rejection_code
           from science_v3_learning_action
          where tenant_id=$1 and agent_attempt_id=$2 and tool_call_id=$3`,
        [input.tenantId, input.agentAttemptId, input.toolCallId],
      )).rows[0];
      if (existing) {
        if (existing.payload_sha256 !== payloadHash || existing.action_type !== input.action.action) {
          throw new Error("learning_action tool call ID is already bound to another payload");
        }
        return actionResult(existing.action_type, existing.accepted, existing.result_resource_ref, existing.rejection_code);
      }
      if (context.request_status !== "running" || context.attempt_status !== "started") {
        throw new Error("foreground request is no longer writable");
      }

      if (input.action.action === "present_validated_artifact") {
        const artifactId = idFrom("art", `${actionId}\0${payloadHash}`);
        const artifactRef = `agent-artifact:${artifactId}`;
        const payload = {
          schema_version: 3,
          artifact_schema: input.action.artifact_schema,
          summary: input.action.summary,
          content: input.action.content,
        };
        let artifact: ReturnType<typeof encodeArtifact>;
        try {
          artifact = encodeArtifact(payload);
        } catch {
          return this.recordAction(client, input, context, actionId, payloadHash, false, null, "invalid");
        }
        await client.query(
          `insert into science_v3_agent_artifact(
             artifact_id,tenant_id,operation_id,artifact_kind,schema_uri,payload,sha256
          ) values($1,$2,$3,'structured_output',$4,$5::jsonb,$6)`,
          [artifactId, input.tenantId, input.operationId,
            MATH_DERIVATION_ARTIFACT_SCHEMA_URI,
            artifact.json, artifact.sha256],
        );
        return this.recordAction(client, input, context, actionId, payloadHash, true, artifactRef, null);
      }

      if (input.action.action === "request_cut") {
        if (!context.active_question_session_id) {
          return this.recordAction(client, input, context, actionId, payloadHash, false, null, "no_active_question");
        }
        const session = (await client.query<{ lifecycle: string; version: string }>(
          `select lifecycle,version from science_v3_question_session
            where tenant_id=$1 and question_session_id=$2 and conversation_thread_id=$3 and student_id=$4`,
          [input.tenantId, context.active_question_session_id, context.conversation_thread_id, context.student_id],
        )).rows[0];
        if (!session || session.lifecycle !== "active") {
          return this.recordAction(client, input, context, actionId, payloadHash, false, null, "stale");
        }
        const operationId = idFrom("op", `${actionId}\0cut`);
        const cutRequestId = idFrom("cut", actionId);
        const eventId = idFrom("evt", `${actionId}\0cut`);
        const artifactId = idFrom("art", `${actionId}\0cut-input`);
        const requestedAt = new Date().toISOString();
        const finalizeInput = {
          schema_version: 3,
          cut_request_ref: `cut-request:${cutRequestId}`,
          question_session_ref: `question-session:${context.active_question_session_id}`,
          reason: input.action.reason,
          ...(input.action.next_natural_language_request
            ? { next_natural_language_request: input.action.next_natural_language_request } : {}),
          requested_at: requestedAt,
        };
        const finalizeArtifact = encodeArtifact(finalizeInput);
        const cut = (await client.query<{
          accepted_cut_request_id: string | null;
          result_status: string;
          rejection_code: string | null;
        }>(
          `select * from mathpilot_science_v3_request_cut(
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15
          )`,
          [input.tenantId, context.user_id, operationId, `learning-action:${actionId}`,
            cutRequestId, eventId, artifactId, context.conversation_thread_id,
            context.active_question_session_id, Number(session.version), input.action.reason,
            input.action.next_natural_language_request ? `learning-action:${actionId}` : null,
            finalizeArtifact.json, finalizeArtifact.sha256, requestedAt],
        )).rows[0]!;
        if (cut.result_status === "rejected" || !cut.accepted_cut_request_id) {
          return this.recordAction(client, input, context, actionId, payloadHash, false, null,
            cut.rejection_code === "permission_denied" ? "permission_denied" : cut.rejection_code === "version_conflict" ? "stale" : "conflict");
        }
        return this.recordAction(client, input, context, actionId, payloadHash, true,
          `cut-request:${cut.accepted_cut_request_id}`, null);
      }

      if (context.active_question_session_id) {
        return this.recordAction(client, input, context, actionId, payloadHash, false, null, "conflict");
      }
      if (input.action.action !== "revise_selection_intent") throw new Error("unsupported bounded learning action");
      return this.createSelectionIntent(client, { ...input, action: input.action }, context, actionId, payloadHash);
    });
  }

  async commitResponse(input: CommitForegroundResponseInput): Promise<ForegroundResponseCommitResult> {
    return this.withTenant(input.tenantId, async (client) => {
      const request = (await client.query<{
        foreground_request_id: string; conversation_thread_id: string; foreground_epoch_id: string;
        triggering_message_id: string; status: string;
      }>(
        `select foreground_request_id,conversation_thread_id,foreground_epoch_id,triggering_message_id,status
           from science_v3_foreground_request
          where tenant_id=$1 and operation_id=$2 and event_id=$3 for update`,
        [input.tenantId, input.operationId, input.eventId],
      )).rows[0];
      if (!request) throw new Error("foreground request does not match its Workflow envelope");
      const artifactId = /^agent-artifact:(art_[A-Za-z0-9]{8,})$/.exec(input.outputRef)?.[1];
      if (!artifactId) throw new Error("foreground outputRef is invalid");
      const artifact = (await client.query<{ payload: unknown; schema_uri: string; sha256: string }>(
        `select payload,schema_uri,sha256 from science_v3_agent_artifact
          where tenant_id=$1 and operation_id=$2 and artifact_id=$3 and artifact_kind='structured_output'`,
        [input.tenantId, input.operationId, artifactId],
      )).rows[0];
      if (!artifact || artifact.schema_uri !== "https://schemas.mathpilot.dev/science-v3/foreground-teaching-output/v1") {
        throw new Error("foreground output artifact is missing or has the wrong schema");
      }
      const producingAttempt = (await client.query<{ agent_attempt_id: string }>(
        `select agent_attempt_id from science_v3_agent_attempt
          where tenant_id=$1 and operation_id=$2 and output_ref=$3 and status='succeeded'`,
        [input.tenantId, input.operationId, input.outputRef],
      )).rows[0];
      if (!producingAttempt) throw new Error("foreground output is not owned by a completed AgentAttempt");
      const output = parseForegroundTeachingOutput(verifiedArtifactPayload(artifact, "foreground output"), {
        conversationThreadId: request.conversation_thread_id,
        foregroundEpochId: request.foreground_epoch_id,
        replyToMessageId: request.triggering_message_id,
      });
      const presented = (await client.query<{
        result_resource_ref: string; action_payload: Record<string, unknown>;
      }>(
        `select result_resource_ref,action_payload
           from science_v3_learning_action
          where tenant_id=$1 and foreground_request_id=$2 and agent_attempt_id=$3
            and action_type='present_validated_artifact' and accepted`,
        [input.tenantId, request.foreground_request_id, producingAttempt.agent_attempt_id],
      )).rows;
      for (const part of output.parts) {
        if (part.type !== "teaching_artifact") continue;
        const action = presented.find((candidate) => candidate.result_resource_ref === part.artifact_ref);
        if (!action || action.action_payload.artifact_schema !== part.artifact_schema
          || action.action_payload.summary !== part.summary) {
          throw new Error("foreground output references an artifact that this AgentAttempt did not present");
        }
      }
      const responseMessageId = idFrom("msg", `${request.foreground_request_id}\0response`);
      const committed = (await client.query<{ canonical_message_id: string; thread_version: string; created: boolean }>(
        `select * from mathpilot_science_v3_commit_foreground_response($1,$2,$3,$4::jsonb,$5,$6)`,
        [input.tenantId, request.foreground_request_id, responseMessageId,
          JSON.stringify(output.parts), input.outputRef, new Date().toISOString()],
      )).rows[0]!;
      return {
        responseMessageId: committed.canonical_message_id,
        threadVersion: Number(committed.thread_version),
        created: committed.created,
      };
    });
  }

  private async context(
    client: pg.PoolClient,
    input: ExecuteLearningActionInput,
    lock: boolean,
  ): Promise<ForegroundContext> {
    const row = (await client.query<ForegroundContext>(
      `select request.foreground_request_id,request.status request_status,
              request.conversation_thread_id,request.foreground_epoch_id,
              request.triggering_message_id,request.student_id,student.user_id,
              thread.status thread_status,thread.version thread_version,
              epoch.active_question_session_id,attempt.status attempt_status
         from science_v3_foreground_request request
         join science_v3_student student
           on student.tenant_id=request.tenant_id and student.student_id=request.student_id
         join science_v3_conversation_thread thread
           on thread.tenant_id=request.tenant_id and thread.conversation_thread_id=request.conversation_thread_id
         join science_v3_foreground_agent_epoch epoch
           on epoch.tenant_id=request.tenant_id and epoch.foreground_epoch_id=request.foreground_epoch_id
         join science_v3_agent_attempt attempt
           on attempt.tenant_id=request.tenant_id and attempt.operation_id=request.operation_id
          and attempt.agent_attempt_id=$3 and attempt.task_type='foreground_teaching'
        where request.tenant_id=$1 and request.operation_id=$2
        ${lock ? "for update of request,thread" : ""}`,
      [input.tenantId, input.operationId, input.agentAttemptId],
    )).rows[0];
    if (!row || row.thread_status !== "active") throw new Error("foreground action authorization is no longer valid");
    return row;
  }

  private async recordAction(
    client: pg.PoolClient,
    input: ExecuteLearningActionInput,
    context: ForegroundContext,
    actionId: string,
    payloadHash: string,
    accepted: boolean,
    resultRef: string | null,
    rejectionCode: LearningActionResult["rejection_code"] | null,
  ): Promise<LearningActionResult> {
    await client.query(
      `insert into science_v3_learning_action(
         learning_action_id,tenant_id,foreground_request_id,operation_id,agent_attempt_id,
         tool_call_id,action_type,action_payload,payload_sha256,accepted,result_resource_ref,rejection_code
       ) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)`,
      [actionId, input.tenantId, context.foreground_request_id, input.operationId,
        input.agentAttemptId, input.toolCallId, input.action.action, encodeArtifact(input.action).json,
        payloadHash, accepted, resultRef, rejectionCode],
    );
    return actionResult(input.action.action, accepted, resultRef, rejectionCode);
  }

  private async createSelectionIntent(
    client: pg.PoolClient,
    input: ExecuteLearningActionInput & { action: Extract<ExecuteLearningActionInput["action"], { action: "revise_selection_intent" }> },
    context: ForegroundContext,
    actionId: string,
    payloadHash: string,
  ): Promise<LearningActionResult> {
    const latest = (await client.query<{ selection_intent_id: string; revision: string }>(
      `select selection_intent_id,revision from science_v3_selection_intent
        where tenant_id=$1 and conversation_thread_id=$2 order by revision desc limit 1`,
      [input.tenantId, context.conversation_thread_id],
    )).rows[0];
    const revision = Number(latest?.revision ?? 0) + 1;
    const intentId = idFrom("int", actionId);
    const operationId = idFrom("op", `${actionId}\0selection`);
    const artifactId = idFrom("art", `${actionId}\0selector-input`);
    const eventId = idFrom("evt", `${actionId}\0selection`);
    const requestedAt = new Date().toISOString();
    const contextSnapshotRef = `agent-artifact:${artifactId}`;
    const activityConstraints: Record<string, string> = {};

    const mastery = (await client.query<{
      dimension_id: string; lineage_version: string; p_mastery: string; state: string;
      independent_count: number; transfer_evidence: number;
    }>(
      `select distinct on(dimension_id) dimension_id,lineage_version,p_mastery,state,independent_count,transfer_evidence
         from science_v3_mastery_projection where tenant_id=$1 and student_id=$2
        order by dimension_id,lineage_version desc limit 128`,
      [input.tenantId, context.student_id],
    )).rows.map((row) => ({
      resource_ref: `mastery-projection://${context.student_id}/${row.dimension_id}/${row.lineage_version}`,
      state: row.state,
      summary: `掌握概率 ${Number(row.p_mastery).toFixed(3)}；独立证据 ${row.independent_count}；迁移证据 ${row.transfer_evidence}`,
    }));
    const retention = (await client.query<{
      retention_unit_revision_id: string; card_state: string; due_at: Date | string;
      retrievability: string; stability: string;
    }>(
      `select retention_unit_revision_id,card_state,due_at,retrievability,stability
         from science_v3_retention_projection where tenant_id=$1 and student_id=$2
        order by due_at limit 128`,
      [input.tenantId, context.student_id],
    )).rows.map((row) => ({
      resource_ref: `retention-projection://${context.student_id}/${row.retention_unit_revision_id}`,
      state: row.card_state,
      summary: `到期 ${asIso(row.due_at)}；可提取性 ${Number(row.retrievability).toFixed(3)}；稳定度 ${Number(row.stability).toFixed(3)}`,
    }));
    const errorPatterns = (await client.query<{
      error_cause_id: string; state: string; support_count: number; counter_count: number; recurrence_count: number;
    }>(
      `select error_cause_id,state,support_count,counter_count,recurrence_count
         from science_v3_error_pattern_projection
        where tenant_id=$1 and student_id=$2 and state<>'superseded'
        order by verification_due_at nulls last,error_cause_id limit 128`,
      [input.tenantId, context.student_id],
    )).rows.map((row) => ({
      resource_ref: `error-pattern-projection://${context.student_id}/${row.error_cause_id}`,
      state: row.state,
      summary: `支持 ${row.support_count}；反证 ${row.counter_count}；复发 ${row.recurrence_count}`,
    }));
    const recentQuestions = (await client.query<{
      question_session_id: string; question_revision_id: string; close_reason: string | null; opened_at: Date | string;
    }>(
      `select question_session_id,question_revision_id,close_reason,opened_at
         from science_v3_question_session
        where tenant_id=$1 and conversation_thread_id=$2 and question_revision_id is not null
        order by opened_at desc limit 20`,
      [input.tenantId, context.conversation_thread_id],
    )).rows.map((row) => ({
      question_session_id: row.question_session_id,
      question_revision_id: row.question_revision_id,
      ...(row.close_reason ? { close_reason: row.close_reason } : {}),
      opened_at: asIso(row.opened_at),
    }));
    const relevantAnnotations = (await client.query<{
      annotation_id: string; claim: string; scope: Record<string, unknown>; support_count: number; counter_count: number;
    }>(
      `select annotation.annotation_id,annotation.claim,annotation.scope,
              cardinality(annotation.support_refs) support_count,cardinality(annotation.counter_refs) counter_count
         from science_v3_semantic_annotation annotation
        where annotation.tenant_id=$1 and annotation.student_id=$2
          and not exists(select 1 from science_v3_annotation_supersession supersession
                          where supersession.tenant_id=annotation.tenant_id
                            and supersession.superseded_annotation_id=annotation.annotation_id)
          and not exists(select 1 from science_v3_annotation_stale_fact stale
                          where stale.tenant_id=annotation.tenant_id and stale.annotation_id=annotation.annotation_id)
          and (annotation.review_due_at is null or annotation.review_due_at>now())
        order by annotation.set_version desc,annotation.annotation_id limit 32`,
      [input.tenantId, context.student_id],
    )).rows.map((row) => ({
      annotation_ref: `annotation://${row.annotation_id}`,
      summary: `${row.claim}；范围 ${JSON.stringify(row.scope)}；支持 ${row.support_count}，反证 ${row.counter_count}`.slice(0, 1000),
    }));
    const evidenceRefs = [...mastery, ...retention, ...errorPatterns].map((item) => item.resource_ref);
    const bundle = {
      schema_version: 3,
      task_type: "select_question",
      intent: {
        selection_intent_id: intentId,
        conversation_thread_id: context.conversation_thread_id,
        student_id: context.student_id,
        revision,
        source: "student",
        natural_language_request: input.action.natural_language_request,
        activity_constraints: activityConstraints,
        context_snapshot_ref: contextSnapshotRef,
        ...(latest ? { supersedes_intent_id: latest.selection_intent_id } : {}),
        created_at: requestedAt,
      },
      student_context: { mastery, retention, error_patterns: errorPatterns, evidence_refs: evidenceRefs },
      recent_questions: recentQuestions,
      relevant_annotations: relevantAnnotations,
      catalog_policy: {
        tool: "question_catalog", source: "normalized_content_next", maximum_page_size: 50,
        constraints_digest: digestJson(activityConstraints),
      },
      output_requirements: {
        intent_id: intentId, intent_revision: revision,
        allowed_scientific_purposes: ["measure", "discriminate", "remediate", "verify", "practice"],
        catalog_page_evidence_required: true,
      },
      history_is_untrusted_data: true,
    };
    let bundleArtifact: ReturnType<typeof encodeArtifact>;
    try {
      bundleArtifact = encodeArtifact(bundle);
    } catch {
      return this.recordAction(client, input, context, actionId, payloadHash, false, null, "invalid");
    }
    await client.query(
      `insert into science_v3_operation(
         operation_id,tenant_id,requested_by_user_id,kind,status,user_message,related_resource_refs
       ) values($1,$2,$3,'select_question','accepted','正在理解你的选题要求',array[$4])`,
      [operationId, input.tenantId, context.user_id, `selection-intent:${intentId}`],
    );
    await client.query(
      `insert into science_v3_selection_intent(
         selection_intent_id,tenant_id,conversation_thread_id,student_id,revision,source,
         natural_language_request,activity_constraints,context_snapshot_ref,supersedes_intent_id,created_at
       ) values($1,$2,$3,$4,$5,'student',$6,$7::jsonb,$8,$9,$10)`,
      [intentId, input.tenantId, context.conversation_thread_id, context.student_id, revision,
        input.action.natural_language_request, JSON.stringify(activityConstraints), contextSnapshotRef,
        latest?.selection_intent_id ?? null, requestedAt],
    );
    await client.query(
      `insert into science_v3_agent_artifact(
         artifact_id,tenant_id,operation_id,artifact_kind,schema_uri,payload,sha256
       ) values($1,$2,$3,'input_bundle',$4,$5::jsonb,$6)`,
      [artifactId, input.tenantId, operationId,
        "https://schemas.mathpilot.dev/science-v3/selector-input/v1", bundleArtifact.json, bundleArtifact.sha256],
    );
    await client.query(
      `insert into infra_outbox(
         event_id,tenant_id,aggregate_type,aggregate_id,event_type,payload,correlation_id,
         causation_id,occurred_at,aggregate_version,payload_ref,operation_id
       ) values($1,$2,'conversation-thread',$3,'selection.intent_revised','{}'::jsonb,$4,$5,$6,$7,$8,$4)`,
      [eventId, input.tenantId, context.conversation_thread_id, operationId,
        `learning-action:${actionId}`, requestedAt, revision, contextSnapshotRef],
    );
    await client.query(
      `insert into science_v3_selection_request(
         tenant_id,operation_id,idempotency_key,command_sha256,event_id,selection_intent_id,
         intent_revision,input_artifact_id,requested_at
       ) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [input.tenantId, operationId, `learning-action:${actionId}`, payloadHash,
        eventId, intentId, revision, artifactId, requestedAt],
    );
    const advanced = await client.query(
      `update science_v3_conversation_thread
          set updated_at=clock_timestamp(),version=version+1
        where tenant_id=$1 and conversation_thread_id=$2 and version=$3`,
      [input.tenantId, context.conversation_thread_id, Number(context.thread_version)],
    );
    if (!advanced.rowCount) throw new Error("foreground Thread changed while revising selection intent");
    return this.recordAction(client, input, context, actionId, payloadHash, true, `selection-intent:${intentId}`, null);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

const actionResult = (
  action: LearningActionResult["action"],
  accepted: boolean,
  resultRef: string | null,
  rejectionCode: LearningActionResult["rejection_code"] | null,
): LearningActionResult => ({
  accepted,
  action,
  ...(resultRef ? { result_ref: resultRef } : {}),
  ...(rejectionCode ? { rejection_code: rejectionCode } : {}),
  message: accepted
    ? `学习动作已接纳：${resultRef}`
    : `学习动作未接纳：${rejectionCode ?? "invalid"}`,
});
