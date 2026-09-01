import {
  MATH_DERIVATION_ARTIFACT_SCHEMA,
  MATH_DERIVATION_ARTIFACT_SCHEMA_URI,
} from "@mathpilot/contracts";
import type {
  CanonicalMessagePart,
  MathDerivationTeachingArtifact,
} from "@mathpilot/contracts";
import { verifyCanonicalJson } from "@mathpilot/content-integrity/node";
import type pg from "pg";

export interface TeachingArtifactSourceMessage {
  message_id: string;
  parts: CanonicalMessagePart[];
}

export interface TeachingArtifactReadBinding {
  tenantId: string;
  threadId: string;
  studentId: string;
  studentUserId: string;
}

export interface MaterializedTeachingArtifact {
  schema: typeof MATH_DERIVATION_ARTIFACT_SCHEMA;
  summary: string;
  presentation: MathDerivationTeachingArtifact;
}

interface TeachingArtifactRow {
  message_id: string;
  artifact_ref: string;
  artifact_schema: string;
  summary: string;
  payload: unknown;
  sha256: string;
}

export const teachingArtifactKey = (messageId: string, artifactRef: string): string =>
  `${messageId}\u0000${artifactRef}`;

/**
 * Hydrates only artifacts proved to belong to the authorized Thread response,
 * its successful foreground request/attempt, and the accepted action that
 * published the reference. Canonical message JSON remains reference-only.
 */
export async function materializeTeachingArtifacts(
  client: pg.PoolClient,
  binding: TeachingArtifactReadBinding,
  messages: readonly TeachingArtifactSourceMessage[],
): Promise<Map<string, MaterializedTeachingArtifact>> {
  const messageIds = messages
    .filter((message) => message.parts.some((part) =>
      part.type === "teaching_artifact"
      && part.artifact_schema === MATH_DERIVATION_ARTIFACT_SCHEMA))
    .map((message) => message.message_id);
  if (messageIds.length === 0) return new Map();

  const rows = (await client.query<TeachingArtifactRow>(
    `select message.message_id,
            part->>'artifact_ref' as artifact_ref,
            part->>'artifact_schema' as artifact_schema,
            part->>'summary' as summary,
            artifact.payload,
            artifact.sha256
       from science_v3_canonical_message message
       join science_v3_foreground_request request
         on request.tenant_id=message.tenant_id
        and request.response_message_id=message.message_id
        and request.conversation_thread_id=message.conversation_thread_id
        and request.foreground_epoch_id=message.foreground_epoch_id
        and request.triggering_message_id=message.reply_to_message_id
        and request.status='succeeded'
       join science_v3_operation operation
         on operation.tenant_id=request.tenant_id
        and operation.operation_id=request.operation_id
        and operation.kind='foreground_teaching'
        and operation.status='succeeded'
        and operation.requested_by_user_id=$4
       cross join lateral jsonb_array_elements(message.parts) part
       join science_v3_learning_action action
         on action.tenant_id=request.tenant_id
        and action.foreground_request_id=request.foreground_request_id
        and action.operation_id=request.operation_id
        and action.action_type='present_validated_artifact'
        and action.accepted
        and action.result_resource_ref=part->>'artifact_ref'
        and action.action_payload->>'action'=action.action_type
        and action.action_payload->>'artifact_schema'=part->>'artifact_schema'
        and action.action_payload->>'summary'=part->>'summary'
       join science_v3_agent_attempt attempt
         on attempt.tenant_id=action.tenant_id
        and attempt.operation_id=action.operation_id
        and attempt.agent_attempt_id=action.agent_attempt_id
        and attempt.task_type='foreground_teaching'
        and attempt.status='succeeded'
        and attempt.output_ref=request.output_ref
       join science_v3_agent_artifact artifact
         on artifact.tenant_id=request.tenant_id
        and artifact.operation_id=request.operation_id
        and 'agent-artifact:' || artifact.artifact_id=part->>'artifact_ref'
        and artifact.artifact_kind='structured_output'
        and artifact.schema_uri=$5
        and (artifact.expires_at is null or artifact.expires_at>now())
      where message.tenant_id=$1
        and message.conversation_thread_id=$2
        and request.student_id=$3
        and message.message_id=any($6::text[])
        and message.author_kind='assistant'
        and message.lifecycle='committed'
        and part->>'type'='teaching_artifact'
        and part->>'artifact_schema'=$7
        and artifact.payload->>'schema_version'='3'
        and artifact.payload->>'artifact_schema'=$7
        and artifact.payload->>'summary'=part->>'summary'
        and artifact.payload->'content'=action.action_payload->'content'`,
    [
      binding.tenantId,
      binding.threadId,
      binding.studentId,
      binding.studentUserId,
      MATH_DERIVATION_ARTIFACT_SCHEMA_URI,
      messageIds,
      MATH_DERIVATION_ARTIFACT_SCHEMA,
    ],
  )).rows;

  const result = new Map<string, MaterializedTeachingArtifact>();
  for (const row of rows) {
    if (row.artifact_schema !== MATH_DERIVATION_ARTIFACT_SCHEMA) continue;
    verifyCanonicalJson(row.payload,row.sha256);
    const payload=recordValue(row.payload);
    const summary = boundedString(row.summary, 1000);
    const presentation = projectMathDerivation(payload.content);
    if (!summary || !presentation) continue;
    result.set(teachingArtifactKey(row.message_id, row.artifact_ref), {
      schema: MATH_DERIVATION_ARTIFACT_SCHEMA,
      summary,
      presentation,
    });
  }
  return result;
}

function projectMathDerivation(value: unknown): MathDerivationTeachingArtifact | undefined {
  const content = recordValue(value);
  if (content.schema !== MATH_DERIVATION_ARTIFACT_SCHEMA || !Array.isArray(content.steps)
    || content.steps.length < 1 || content.steps.length > 16) return undefined;
  const label = content.label === undefined ? undefined : boundedString(content.label, 120);
  if (content.label !== undefined && !label) return undefined;
  const steps: MathDerivationTeachingArtifact["steps"] = [];
  for (const value of content.steps) {
    const step = recordValue(value);
    const expression = boundedString(step.expression, 2000);
    const note = step.note === undefined ? undefined : boundedString(step.note, 500);
    if (!expression || (step.note !== undefined && !note)) return undefined;
    steps.push({ expression, ...(note ? { note } : {}) });
  }
  return {
    schema: MATH_DERIVATION_ARTIFACT_SCHEMA,
    ...(label ? { label } : {}),
    steps,
  };
}

const recordValue = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const boundedString = (value: unknown, maximum: number): string | undefined =>
  typeof value === "string" && Boolean(value.trim()) && value.length <= maximum ? value : undefined;
