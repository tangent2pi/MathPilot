import { createHash } from "node:crypto";
import { canonicalJson } from "@mathpilot/content-integrity/node";
import type pg from "pg";
import type { Principal } from "./auth.ts";
import { newId, withTenant } from "./lib.ts";

const SELECTOR_INPUT_SCHEMA = "https://schemas.mathpilot.dev/science-v3/selector-input/v1";
const ID = {
  thread: /^thr_[A-Za-z0-9]{8,}$/,
  intent: /^int_[A-Za-z0-9]{8,}$/,
  idempotency: /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/,
};

interface ReviseSelectionIntentCommand {
  schema_version: 3;
  command_type: "revise_selection_intent";
  idempotency_key: string;
  expected_version: number;
  requested_at: string;
  conversation_thread_id: string;
  supersedes_intent_id?: string;
  natural_language_request: string;
}

interface ExistingSelection {
  command_sha256: string;
  requested_by_user_id: string;
  operation_id: string;
  operation_status: string;
  user_message: string;
  selection_intent_id: string;
  conversation_thread_id: string;
  student_id: string;
  revision: string;
  natural_language_request: string;
  context_snapshot_ref: string;
  supersedes_intent_id: string | null;
  created_at: Date | string;
}

export interface ReviseSelectionIntentResult {
  created: boolean;
  operation: {
    operation_id: string;
    status: string;
    user_message: string;
  };
  selection_intent: {
    selection_intent_id: string;
    conversation_thread_id: string;
    student_id: string;
    revision: number;
    source: "student";
    natural_language_request: string;
    context_snapshot_ref: string;
    supersedes_intent_id?: string;
    created_at: string;
  };
}

export class SelectionCommandError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const objectValue = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SelectionCommandError(422, "command body must be an object");
  }
  return value as Record<string, unknown>;
};

function parseCommand(value: unknown): ReviseSelectionIntentCommand {
  const raw = objectValue(value);
  const allowed = new Set([
    "schema_version", "command_type", "idempotency_key", "expected_version", "requested_at",
    "conversation_thread_id", "supersedes_intent_id", "natural_language_request",
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) {
    throw new SelectionCommandError(422, "command contains unsupported fields");
  }
  if (raw.schema_version !== 3 || raw.command_type !== "revise_selection_intent") {
    throw new SelectionCommandError(422, "unsupported learning command");
  }
  if (typeof raw.idempotency_key !== "string" || !ID.idempotency.test(raw.idempotency_key)) {
    throw new SelectionCommandError(422, "idempotency_key is invalid");
  }
  if (!Number.isSafeInteger(raw.expected_version) || Number(raw.expected_version) < 0) {
    throw new SelectionCommandError(422, "expected_version must be a non-negative integer");
  }
  if (typeof raw.requested_at !== "string" || !Number.isFinite(Date.parse(raw.requested_at))) {
    throw new SelectionCommandError(422, "requested_at must be an ISO date-time");
  }
  if (typeof raw.conversation_thread_id !== "string" || !ID.thread.test(raw.conversation_thread_id)) {
    throw new SelectionCommandError(422, "conversation_thread_id is invalid");
  }
  if (raw.supersedes_intent_id !== undefined
    && (typeof raw.supersedes_intent_id !== "string" || !ID.intent.test(raw.supersedes_intent_id))) {
    throw new SelectionCommandError(422, "supersedes_intent_id is invalid");
  }
  if (typeof raw.natural_language_request !== "string"
    || !raw.natural_language_request.trim()
    || raw.natural_language_request.length > 4000) {
    throw new SelectionCommandError(422, "natural_language_request must contain 1..4000 characters");
  }
  return {
    schema_version: 3,
    command_type: "revise_selection_intent",
    idempotency_key: raw.idempotency_key,
    expected_version: Number(raw.expected_version),
    requested_at: new Date(raw.requested_at).toISOString(),
    conversation_thread_id: raw.conversation_thread_id,
    ...(typeof raw.supersedes_intent_id === "string" ? { supersedes_intent_id: raw.supersedes_intent_id } : {}),
    natural_language_request: raw.natural_language_request,
  };
}

const commandDigest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const toIso = (value: Date | string): string => new Date(value).toISOString();

const resultFromExisting = (row: ExistingSelection): ReviseSelectionIntentResult => ({
  created: false,
  operation: {
    operation_id: row.operation_id,
    status: row.operation_status,
    user_message: row.user_message,
  },
  selection_intent: {
    selection_intent_id: row.selection_intent_id,
    conversation_thread_id: row.conversation_thread_id,
    student_id: row.student_id,
    revision: Number(row.revision),
    source: "student",
    natural_language_request: row.natural_language_request,
    context_snapshot_ref: row.context_snapshot_ref,
    ...(row.supersedes_intent_id ? { supersedes_intent_id: row.supersedes_intent_id } : {}),
    created_at: toIso(row.created_at),
  },
});

async function findExisting(
  client: pg.PoolClient,
  tenantId: string,
  idempotencyKey: string,
): Promise<ExistingSelection | undefined> {
  return (await client.query<ExistingSelection>(
    `select request.command_sha256,operation.requested_by_user_id,
            operation.operation_id,operation.status as operation_status,operation.user_message,
            intent.selection_intent_id,intent.conversation_thread_id,intent.student_id,intent.revision,
            intent.natural_language_request,intent.context_snapshot_ref,intent.supersedes_intent_id,intent.created_at
       from science_v3_selection_request request
       join science_v3_operation operation
         on operation.tenant_id=request.tenant_id and operation.operation_id=request.operation_id
       join science_v3_selection_intent intent
         on intent.tenant_id=request.tenant_id and intent.selection_intent_id=request.selection_intent_id
      where request.tenant_id=$1 and request.idempotency_key=$2`,
    [tenantId,idempotencyKey],
  )).rows[0];
}

function acceptExisting(
  row: ExistingSelection | undefined,
  principal: Principal,
  commandSha256: string,
): ReviseSelectionIntentResult | undefined {
  if (!row) return undefined;
  if (row.requested_by_user_id !== principal.userId || row.command_sha256 !== commandSha256) {
    throw new SelectionCommandError(409, "idempotency_key is already bound to another command");
  }
  return resultFromExisting(row);
}

export async function reviseSelectionIntent(
  pool: pg.Pool,
  principal: Principal,
  value: unknown,
): Promise<ReviseSelectionIntentResult> {
  const command = parseCommand(value);
  const commandSha256 = commandDigest(command);
  return withTenant(pool,principal.tenantId,async (client) => {
    const prior = acceptExisting(
      await findExisting(client,principal.tenantId,command.idempotency_key),
      principal,
      commandSha256,
    );
    if (prior) return prior;

    const thread = (await client.query<{
      student_id: string;
      student_user_id: string;
      status: "active" | "archived";
      version: string;
    }>(
      `select thread.student_id,student.user_id as student_user_id,thread.status,thread.version
         from science_v3_conversation_thread thread
         join science_v3_student student
           on student.tenant_id=thread.tenant_id and student.student_id=thread.student_id
        where thread.tenant_id=$1 and thread.conversation_thread_id=$2
        for update of thread`,
      [principal.tenantId,command.conversation_thread_id],
    )).rows[0];
    if (!thread || thread.student_user_id !== principal.userId) {
      throw new SelectionCommandError(404, "conversation thread not found");
    }
    if (thread.status !== "active") throw new SelectionCommandError(409, "conversation thread is archived");

    const raced = acceptExisting(
      await findExisting(client,principal.tenantId,command.idempotency_key),
      principal,
      commandSha256,
    );
    if (raced) return raced;
    if (Number(thread.version) !== command.expected_version) {
      throw new SelectionCommandError(409, `thread version is ${thread.version}`);
    }

    const latest = (await client.query<{ selection_intent_id: string; revision: string }>(
      `select selection_intent_id,revision from science_v3_selection_intent
        where tenant_id=$1 and conversation_thread_id=$2
        order by revision desc limit 1`,
      [principal.tenantId,command.conversation_thread_id],
    )).rows[0];
    if (!latest && command.supersedes_intent_id) {
      throw new SelectionCommandError(409, "the first intent cannot supersede another intent");
    }
    if (latest && command.supersedes_intent_id && command.supersedes_intent_id !== latest.selection_intent_id) {
      throw new SelectionCommandError(409, "supersedes_intent_id is stale");
    }

    const revision = Number(latest?.revision ?? 0)+1;
    const selectionIntentId = newId("int");
    const operationId = newId("op");
    const artifactId = newId("art");
    const eventId = newId("evt");
    const contextSnapshotRef = `agent-artifact:${artifactId}`;
    const supersedesIntentId = latest?.selection_intent_id;
    const activityConstraints: Record<string,string> = {};

    const mastery = (await client.query<{
      dimension_id: string;
      lineage_version: string;
      p_mastery: string;
      state: string;
      independent_count: number;
      transfer_evidence: number;
    }>(
      `select distinct on(dimension_id) dimension_id,lineage_version,p_mastery,state,
              independent_count,transfer_evidence
         from science_v3_mastery_projection
        where tenant_id=$1 and student_id=$2
        order by dimension_id,lineage_version desc limit 128`,
      [principal.tenantId,thread.student_id],
    )).rows.map((row) => ({
      resource_ref: `mastery-projection://${thread.student_id}/${row.dimension_id}/${row.lineage_version}`,
      state: row.state,
      summary: `掌握概率 ${Number(row.p_mastery).toFixed(3)}；独立证据 ${row.independent_count}；迁移证据 ${row.transfer_evidence}`,
    }));
    const retention = (await client.query<{
      retention_unit_revision_id: string;
      card_state: string;
      due_at: Date | string;
      retrievability: string;
      stability: string;
    }>(
      `select retention_unit_revision_id,card_state,due_at,retrievability,stability
         from science_v3_retention_projection
        where tenant_id=$1 and student_id=$2
        order by due_at limit 128`,
      [principal.tenantId,thread.student_id],
    )).rows.map((row) => ({
      resource_ref: `retention-projection://${thread.student_id}/${row.retention_unit_revision_id}`,
      state: row.card_state,
      summary: `到期 ${toIso(row.due_at)}；可提取性 ${Number(row.retrievability).toFixed(3)}；稳定度 ${Number(row.stability).toFixed(3)}`,
    }));
    const errorPatterns = (await client.query<{
      error_cause_id: string;
      state: string;
      support_count: number;
      counter_count: number;
      recurrence_count: number;
      verification_due_at: Date | string | null;
    }>(
      `select error_cause_id,state,support_count,counter_count,recurrence_count,verification_due_at
         from science_v3_error_pattern_projection
        where tenant_id=$1 and student_id=$2 and state<>'superseded'
        order by verification_due_at nulls last,error_cause_id limit 128`,
      [principal.tenantId,thread.student_id],
    )).rows.map((row) => ({
      resource_ref: `error-pattern-projection://${thread.student_id}/${row.error_cause_id}`,
      state: row.state,
      summary: `支持 ${row.support_count}；反证 ${row.counter_count}；复发 ${row.recurrence_count}${row.verification_due_at ? `；复核 ${toIso(row.verification_due_at)}` : ""}`,
    }));
    const relevantAnnotations = (await client.query<{
      annotation_id: string;
      target_kind: string;
      target_ref: string;
      claim: string;
      scope: Record<string,string>;
      support_count: number;
      counter_count: number;
    }>(
      `select annotation.annotation_id,annotation.target_kind,annotation.target_ref,
              annotation.claim,annotation.scope,cardinality(annotation.support_refs) as support_count,
              cardinality(annotation.counter_refs) as counter_count
         from science_v3_semantic_annotation annotation
        where annotation.tenant_id=$1 and annotation.student_id=$2
          and not exists(select 1 from science_v3_annotation_supersession supersession
                          where supersession.tenant_id=annotation.tenant_id
                            and supersession.superseded_annotation_id=annotation.annotation_id)
          and not exists(select 1 from science_v3_annotation_stale_fact stale
                          where stale.tenant_id=annotation.tenant_id and stale.annotation_id=annotation.annotation_id)
          and (annotation.review_due_at is null or annotation.review_due_at>now())
          and coalesce((select preference.enabled from science_v3_annotation_usage_preference_event preference
                         where preference.tenant_id=annotation.tenant_id and preference.student_id=annotation.student_id
                           and preference.annotation_id=annotation.annotation_id
                         order by preference.created_at desc,preference.preference_event_id desc limit 1),true)
          and coalesce((select preference.enabled from science_v3_annotation_usage_preference_event preference
                         where preference.tenant_id=annotation.tenant_id and preference.student_id=annotation.student_id
                           and preference.annotation_id is null
                         order by preference.created_at desc,preference.preference_event_id desc limit 1),true)
          and (
            annotation.target_kind='student_trait'
            or annotation.target_ref in(
              select 'dimension:' || lineage.dimension_revision_id
                from science_v3_dimension_lineage lineage join science_v3_mastery_projection mastery
                  on mastery.tenant_id=lineage.tenant_id and mastery.dimension_id=lineage.dimension_id
                 and mastery.lineage_version=lineage.lineage_version
               where mastery.tenant_id=$1 and mastery.student_id=$2
            )
            or annotation.target_ref in(
              select 'error-cause:' || pattern.active_definition_revision_id
                from science_v3_error_pattern_projection pattern
               where pattern.tenant_id=$1 and pattern.student_id=$2 and pattern.state<>'superseded'
            )
          )
        order by annotation.set_version desc,annotation.annotation_id limit 32`,
      [principal.tenantId,thread.student_id],
    )).rows.map((row) => ({
      annotation_ref: `annotation://${row.annotation_id}`,
      summary: `${row.claim}；范围 ${JSON.stringify(row.scope)}；支持 ${row.support_count}，反证 ${row.counter_count}`.slice(0,1000),
    }));
    const recentQuestions = (await client.query<{
      question_session_id: string;
      question_revision_id: string;
      close_reason: string | null;
      opened_at: Date | string;
    }>(
      `select question_session_id,question_revision_id,close_reason,opened_at
         from science_v3_question_session
        where tenant_id=$1 and conversation_thread_id=$2 and question_revision_id is not null
        order by opened_at desc limit 20`,
      [principal.tenantId,command.conversation_thread_id],
    )).rows.map((row) => ({
      question_session_id: row.question_session_id,
      question_revision_id: row.question_revision_id,
      ...(row.close_reason ? { close_reason: row.close_reason } : {}),
      opened_at: toIso(row.opened_at),
    }));
    const evidenceRefs = [...mastery,...retention,...errorPatterns].map((row) => row.resource_ref);
    const inputBundle = {
      schema_version: 3,
      task_type: "select_question",
      intent: {
        selection_intent_id: selectionIntentId,
        conversation_thread_id: command.conversation_thread_id,
        student_id: thread.student_id,
        revision,
        source: "student",
        natural_language_request: command.natural_language_request,
        activity_constraints: activityConstraints,
        context_snapshot_ref: contextSnapshotRef,
        ...(supersedesIntentId ? { supersedes_intent_id: supersedesIntentId } : {}),
        created_at: command.requested_at,
      },
      student_context: {
        mastery,
        retention,
        error_patterns: errorPatterns,
        evidence_refs: evidenceRefs,
      },
      recent_questions: recentQuestions,
      relevant_annotations: relevantAnnotations,
      catalog_policy: {
        tool: "question_catalog",
        source: "normalized_content_next",
        maximum_page_size: 50,
        constraints_digest: canonicalJson(activityConstraints).sha256,
      },
      output_requirements: {
        intent_id: selectionIntentId,
        intent_revision: revision,
        allowed_scientific_purposes: ["measure","discriminate","remediate","verify","practice"],
        catalog_page_evidence_required: true,
      },
      history_is_untrusted_data: true,
    };
    let inputArtifact:ReturnType<typeof canonicalJson>;
    try { inputArtifact=canonicalJson(inputBundle); }
    catch { throw new SelectionCommandError(422,"selector context snapshot exceeds 1 MiB"); }

    await client.query(
      `insert into science_v3_operation(
         operation_id,tenant_id,requested_by_user_id,kind,status,user_message,related_resource_refs
       ) values($1,$2,$3,'select_question','accepted','正在理解你的选题要求',$4)`,
      [operationId,principal.tenantId,principal.userId,[`selection-intent:${selectionIntentId}`]],
    );
    await client.query(
      `insert into science_v3_selection_intent(
         selection_intent_id,tenant_id,conversation_thread_id,student_id,revision,source,
         natural_language_request,activity_constraints,context_snapshot_ref,supersedes_intent_id,created_at
       ) values($1,$2,$3,$4,$5,'student',$6,$7::jsonb,$8,$9,$10)`,
      [selectionIntentId,principal.tenantId,command.conversation_thread_id,thread.student_id,revision,
        command.natural_language_request,JSON.stringify(activityConstraints),contextSnapshotRef,
        supersedesIntentId ?? null,command.requested_at],
    );
    await client.query(
      `insert into science_v3_agent_artifact(
         artifact_id,tenant_id,operation_id,artifact_kind,schema_uri,payload,sha256
       ) values($1,$2,$3,'input_bundle',$4,$5::jsonb,$6)`,
      [artifactId,principal.tenantId,operationId,SELECTOR_INPUT_SCHEMA,inputArtifact.json,inputArtifact.sha256],
    );
    await client.query(
      `insert into infra_outbox(
         event_id,tenant_id,aggregate_type,aggregate_id,event_type,payload,correlation_id,
         causation_id,occurred_at,aggregate_version,payload_ref,operation_id
       ) values($1,$2,'conversation-thread',$3,'selection.intent_revised','{}'::jsonb,$4,$5,$6,$7,$8,$4)`,
      [eventId,principal.tenantId,command.conversation_thread_id,operationId,
        command.idempotency_key,command.requested_at,revision,`agent-artifact:${artifactId}`],
    );
    await client.query(
      `insert into science_v3_selection_request(
         tenant_id,operation_id,idempotency_key,command_sha256,event_id,selection_intent_id,
         intent_revision,input_artifact_id,requested_at
       ) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [principal.tenantId,operationId,command.idempotency_key,commandSha256,eventId,
        selectionIntentId,revision,artifactId,command.requested_at],
    );
    await client.query(
      `update science_v3_conversation_thread
          set updated_at=clock_timestamp(),version=version+1
        where tenant_id=$1 and conversation_thread_id=$2 and version=$3`,
      [principal.tenantId,command.conversation_thread_id,command.expected_version],
    );
    return {
      created: true,
      operation: {
        operation_id: operationId,
        status: "accepted",
        user_message: "正在理解你的选题要求",
      },
      selection_intent: {
        selection_intent_id: selectionIntentId,
        conversation_thread_id: command.conversation_thread_id,
        student_id: thread.student_id,
        revision,
        source: "student",
        natural_language_request: command.natural_language_request,
        context_snapshot_ref: contextSnapshotRef,
        ...(supersedesIntentId ? { supersedes_intent_id: supersedesIntentId } : {}),
        created_at: command.requested_at,
      },
    };
  });
}
