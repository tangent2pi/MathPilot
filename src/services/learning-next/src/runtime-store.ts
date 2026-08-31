import { createHash } from "node:crypto";
import pg from "pg";
import type {
  CommitOperationResultInput,
  PersistedOperationResult,
  PiTaskActivityInput,
  PiTaskActivityResult,
  TaskSpec,
  WorkspaceProjection,
} from "./runtime-types.ts";
import { compileWorkspaceProjection } from "./workspace-projection.ts";

export interface AttemptStart {
  agentAttemptId: string;
  input: PiTaskActivityInput;
  taskSpec: TaskSpec;
  workflowRunId: string;
  temporalActivityId: string;
  temporalAttempt: number;
}

export interface AttemptCompletion {
  outputRef: string;
  resolvedModelId: string;
  inputTokens: number;
  outputTokens: number;
}

export interface RuntimeStore {
  findOperationResult(input: PiTaskActivityInput): Promise<PiTaskActivityResult | undefined>;
  loadInputBundle(input: PiTaskActivityInput, taskSpec: TaskSpec): Promise<unknown>;
  loadWorkspaceProjection(input: PiTaskActivityInput, taskSpec: TaskSpec, inputBundle: unknown): Promise<WorkspaceProjection>;
  startAttempt(value: AttemptStart): Promise<void>;
  storeStructuredOutput(value: AttemptStart, output: unknown, schemaUri: string): Promise<string>;
  completeAttempt(agentAttemptId: string, tenantId: string, completion: AttemptCompletion): Promise<void>;
  failAttempt(agentAttemptId: string, tenantId: string, error: { code: string; detail: string; cancelled: boolean }): Promise<void>;
  commitOperationResult(input: CommitOperationResultInput): Promise<PersistedOperationResult>;
  markOperationFailed(input: { tenantId: string; operationId: string; cancelled: boolean; message: string }): Promise<void>;
  close(): Promise<void>;
}

const idFrom = (prefix: string, value: string, length = 24): string =>
  `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, length)}`;

const artifactIdFromRef = (ref: string): string => {
  const match = /^agent-artifact:(art_[A-Za-z0-9]{8,})$/.exec(ref);
  if (!match) throw new Error("inputRef must be an agent-artifact reference");
  return match[1]!;
};

const safeJson = (value: unknown): string => {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("task artifact must be JSON serializable");
  if (Buffer.byteLength(json, "utf8") > 1024 * 1024) throw new Error("task artifact exceeds 1 MiB");
  return json;
};

export class PostgresRuntimeStore implements RuntimeStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 8 });
  }

  private async withTenant<T>(tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select set_config('app.current_tenant',$1,true), set_config('app.current_user','',true), set_config('app.current_roles','',true)",
        [tenantId],
      );
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async findOperationResult(input: PiTaskActivityInput): Promise<PiTaskActivityResult | undefined> {
    if (input.resultOwnership === "parent") return undefined;
    return this.withTenant(input.tenantId, async (client) => {
      const result = await client.query<{ result_resource_refs: string[] }>(
        `select result_resource_refs
           from science_v3_operation_result
          where tenant_id=$1 and operation_id=$2 and idempotency_key=$3
          limit 1`,
        [input.tenantId, input.operationId, input.idempotencyKey],
      );
      const outputRef = result.rows[0]?.result_resource_refs[0];
      return outputRef
        ? { outputRef, resolvedModelId: "operation-result-cache", inputTokens: 0, outputTokens: 0 }
        : undefined;
    });
  }

  async loadInputBundle(input: PiTaskActivityInput, taskSpec: TaskSpec): Promise<unknown> {
    const artifactId = artifactIdFromRef(input.inputRef);
    return this.withTenant(input.tenantId, async (client) => {
      const result = await client.query<{ payload: unknown; schema_uri: string }>(
        `select payload,schema_uri
           from science_v3_agent_artifact
          where tenant_id=$1 and operation_id=$2 and artifact_id=$3
            and artifact_kind='input_bundle'
            and (expires_at is null or expires_at > now())`,
        [input.tenantId, input.operationId, artifactId],
      );
      const artifact = result.rows[0];
      if (!artifact) throw new Error("frozen task input does not exist or has expired");
      if (artifact.schema_uri !== taskSpec.input_schema) throw new Error("frozen task input schema does not match TaskSpec");
      safeJson(artifact.payload);
      return artifact.payload;
    });
  }

  async loadWorkspaceProjection(
    input: PiTaskActivityInput,
    taskSpec: TaskSpec,
    inputBundle: unknown,
  ): Promise<WorkspaceProjection> {
    if (!taskSpec.workspace_projection_policy.enabled) {
      throw new Error("TaskSpec does not authorize a WorkspaceProjection");
    }
    const bundle = inputBundle && typeof inputBundle === "object" && !Array.isArray(inputBundle)
      ? inputBundle as Record<string, unknown>
      : {};
    const context = bundle.context && typeof bundle.context === "object" && !Array.isArray(bundle.context)
      ? bundle.context as Record<string, unknown>
      : {};
    const conversationThreadId = typeof bundle.conversation_thread_id === "string"
      ? bundle.conversation_thread_id
      : typeof context.conversation_thread_id === "string" ? context.conversation_thread_id : undefined;
    const foregroundEpochId = typeof bundle.foreground_epoch_id === "string"
      ? bundle.foreground_epoch_id
      : typeof context.foreground_epoch_id === "string" ? context.foreground_epoch_id : undefined;
    const triggeringMessageId = typeof bundle.triggering_message_id === "string"
      ? bundle.triggering_message_id
      : typeof context.triggering_message_id === "string" ? context.triggering_message_id : undefined;
    if (!conversationThreadId || !/^thr_[A-Za-z0-9]{8,}$/.test(conversationThreadId)) {
      throw new Error("foreground task input is missing a valid conversation_thread_id");
    }
    if (foregroundEpochId && !/^fge_[A-Za-z0-9]{8,}$/.test(foregroundEpochId)) {
      throw new Error("foreground task input has an invalid foreground_epoch_id");
    }
    if (triggeringMessageId && !/^msg_[A-Za-z0-9]{8,}$/.test(triggeringMessageId)) {
      throw new Error("foreground task input has an invalid triggering_message_id");
    }
    return this.withTenant(input.tenantId, (client) => compileWorkspaceProjection(client, {
      tenantId: input.tenantId,
      operationId: input.operationId,
      conversationThreadId,
      ...(foregroundEpochId ? { foregroundEpochId } : {}),
      ...(triggeringMessageId ? { triggeringMessageId } : {}),
      taskSpec,
    }));
  }

  async startAttempt(value: AttemptStart): Promise<void> {
    await this.withTenant(value.input.tenantId, async (client) => {
      await client.query(
        `update science_v3_operation
            set status='running', user_message='正在处理', updated_at=clock_timestamp(), version=version+1
          where tenant_id=$1 and operation_id=$2 and status='accepted'`,
        [value.input.tenantId, value.input.operationId],
      );
      if (value.input.taskType === "foreground_teaching") {
        await client.query(
          `update science_v3_foreground_request
              set status='running',updated_at=clock_timestamp()
            where tenant_id=$1 and operation_id=$2 and status='queued'`,
          [value.input.tenantId, value.input.operationId],
        );
      }
      const operation = await client.query<{ status: string }>(
        `select status from science_v3_operation where tenant_id=$1 and operation_id=$2`,
        [value.input.tenantId, value.input.operationId],
      );
      const runnableStatuses = value.input.resultOwnership === "parent" ? ["running", "succeeded"] : ["running"];
      if (!operation.rows[0] || !runnableStatuses.includes(operation.rows[0].status)) {
        throw new Error("operation is not runnable");
      }
      await client.query(
        `insert into science_v3_agent_attempt (
           agent_attempt_id,tenant_id,operation_id,workflow_id,workflow_run_id,
           temporal_activity_id,task_type,task_spec_version,temporal_attempt,input_ref,
           model_policy_id,prompt_version,skill_ref
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         on conflict (agent_attempt_id) do nothing`,
        [
          value.agentAttemptId,
          value.input.tenantId,
          value.input.operationId,
          value.input.workflowId,
          value.workflowRunId,
          value.temporalActivityId,
          value.input.taskType,
          value.taskSpec.spec_version,
          value.temporalAttempt,
          value.input.inputRef,
          value.taskSpec.model_policy.policy_id,
          `${value.input.taskType}-prompt@${value.taskSpec.spec_version}`,
          value.taskSpec.skill_ref,
        ],
      );
    });
  }

  async storeStructuredOutput(value: AttemptStart, output: unknown, schemaUri: string): Promise<string> {
    const json = safeJson(output);
    const sha256 = createHash("sha256").update(json).digest("hex");
    const artifactId = idFrom("art", `${value.agentAttemptId}\0${sha256}`);
    return this.withTenant(value.input.tenantId, async (client) => {
      await client.query(
        `insert into science_v3_agent_artifact (
           artifact_id,tenant_id,operation_id,artifact_kind,schema_uri,payload,sha256
         ) values ($1,$2,$3,'structured_output',$4,$5::jsonb,$6)
         on conflict (artifact_id) do nothing`,
        [artifactId, value.input.tenantId, value.input.operationId, schemaUri, json, sha256],
      );
      const stored = await client.query<{ sha256: string }>(
        `select sha256 from science_v3_agent_artifact
          where tenant_id=$1 and operation_id=$2 and artifact_id=$3`,
        [value.input.tenantId, value.input.operationId, artifactId],
      );
      if (stored.rows[0]?.sha256 !== sha256) throw new Error("structured output artifact conflicts with an existing value");
      return `agent-artifact:${artifactId}`;
    });
  }

  async completeAttempt(agentAttemptId: string, tenantId: string, completion: AttemptCompletion): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `update science_v3_agent_attempt
            set status='succeeded', output_ref=$3, resolved_model_id=$4,
                input_tokens=$5, output_tokens=$6, completed_at=clock_timestamp()
          where tenant_id=$1 and agent_attempt_id=$2 and status='started'`,
        [tenantId, agentAttemptId, completion.outputRef, completion.resolvedModelId, completion.inputTokens, completion.outputTokens],
      );
    });
  }

  async failAttempt(agentAttemptId: string, tenantId: string, error: { code: string; detail: string; cancelled: boolean }): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `update science_v3_agent_attempt
            set status=$3, error_code=$4, error_detail=$5, completed_at=clock_timestamp()
          where tenant_id=$1 and agent_attempt_id=$2 and status='started'`,
        [tenantId, agentAttemptId, error.cancelled ? "cancelled" : "failed", error.code.slice(0, 160), error.detail.slice(0, 2000)],
      );
    });
  }

  async commitOperationResult(input: CommitOperationResultInput): Promise<PersistedOperationResult> {
    return this.withTenant(input.tenantId, async (client) => {
      const inserted = await client.query(
        `insert into science_v3_operation_result (
           tenant_id,operation_id,idempotency_key,result_status,aggregate_ref,
           aggregate_version,result_resource_refs
         ) values ($1,$2,$3,'committed',$4,$5,array[$6]::text[])
         on conflict (operation_id,idempotency_key) do nothing
         returning 1`,
        [input.tenantId, input.operationId, input.idempotencyKey, input.aggregateRef, input.aggregateVersion, input.outputRef],
      );
      const existing = await client.query<{
        aggregate_ref: string;
        aggregate_version: string;
        result_resource_refs: string[];
      }>(
        `select aggregate_ref,aggregate_version,result_resource_refs
           from science_v3_operation_result
          where tenant_id=$1 and operation_id=$2 and idempotency_key=$3`,
        [input.tenantId, input.operationId, input.idempotencyKey],
      );
      const row = existing.rows[0];
      if (!row || row.aggregate_ref !== input.aggregateRef
        || Number(row.aggregate_version) !== input.aggregateVersion
        || row.result_resource_refs[0] !== input.outputRef) {
        throw new Error("idempotency key is already bound to a different operation result");
      }
      await client.query(
        `update science_v3_operation
            set status='succeeded', user_message='处理完成', retryable=false,
                related_resource_refs=array[$3]::text[], updated_at=clock_timestamp(), version=version+1
          where tenant_id=$1 and operation_id=$2 and status='running'`,
        [input.tenantId, input.operationId, input.outputRef],
      );
      return {
        resultStatus: inserted.rowCount ? "committed" : "already_committed",
        outputRef: input.outputRef,
      };
    });
  }

  async markOperationFailed(input: { tenantId: string; operationId: string; cancelled: boolean; message: string }): Promise<void> {
    await this.withTenant(input.tenantId, async (client) => {
      await client.query(
        `update science_v3_operation
            set status=$3, user_message=$4, retryable=$5,
                updated_at=clock_timestamp(), version=version+1
          where tenant_id=$1 and operation_id=$2
            and status in ('accepted','running','needs_input')`,
        [
          input.tenantId,
          input.operationId,
          input.cancelled ? "cancelled" : "failed",
          input.message.slice(0, 1000) || (input.cancelled ? "已取消" : "处理失败"),
          !input.cancelled,
        ],
      );
      await client.query(
        `update science_v3_foreground_request
            set status=$3,completed_at=clock_timestamp(),updated_at=clock_timestamp()
          where tenant_id=$1 and operation_id=$2 and status in ('queued','running')`,
        [input.tenantId, input.operationId, input.cancelled ? "cancelled" : "failed"],
      );
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function agentAttemptId(workflowId: string, workflowRunId: string, activityId: string, attempt: number): string {
  return idFrom("agt", `${workflowId}\0${workflowRunId}\0${activityId}\0${attempt}`);
}
