import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const operationId = Type.String({ pattern: "^op_[A-Za-z0-9]{8,}$" });
const foregroundRequestId = Type.String({ pattern: "^fgr_[A-Za-z0-9]{8,}$" });
const conversationThreadId = Type.String({ pattern: "^thr_[A-Za-z0-9]{8,}$" });
const foregroundEpochId = Type.String({ pattern: "^fge_[A-Za-z0-9]{8,}$" });
const messageId = Type.String({ pattern: "^msg_[A-Za-z0-9]{8,}$" });
const eventId = Type.String({ pattern: "^evt_[A-Za-z0-9]{8,}$" });
const agentAttemptId = Type.String({ pattern: "^agt_[A-Za-z0-9]{8,}$" });
const inputRef = Type.String({ pattern: "^agent-artifact:art_[A-Za-z0-9]{8,}$" });
const driverExecutionId = Type.String({
  pattern: "^interactive-epoch:fge_[A-Za-z0-9]{8,}:fgr_[A-Za-z0-9]{8,}$",
});

export const MAXIMUM_WORKSPACE_PROJECTION_BYTES = 64 * 1024 * 1024;
export const MAXIMUM_WORKSPACE_PROJECTION_FILES = 64;
export const MAXIMUM_WORKSPACE_PROJECTION_OBJECTS = 64;
export const MAXIMUM_INTERACTIVE_PREPARE_RESPONSE_BYTES = MAXIMUM_WORKSPACE_PROJECTION_BYTES + 8 * 1024 * 1024;

const projectionPath = Type.String({ minLength: 1, maxLength: 400 });
const isoTimestamp = Type.String({ minLength: 20, maxLength: 35 });
const projectionManifestItem = Type.Object({
  kind: Type.Union([
    Type.Literal("current_thread"), Type.Literal("current_question"), Type.Literal("learning_activity"),
    Type.Literal("selection_intent"), Type.Literal("annotation"), Type.Literal("history_thread"),
    Type.Literal("attachment"), Type.Literal("scientific_state"), Type.Literal("evidence_index"),
  ]),
  resource_ref: Type.String({ minLength: 1, maxLength: 2_000 }),
  label: Type.String({ minLength: 1, maxLength: 1_000 }),
  freshness: isoTimestamp,
  href: Type.String({ minLength: 1, maxLength: 2_000 }),
  version: Type.Optional(Type.Integer({ minimum: 0 })),
  detail: Type.Optional(Type.String({ maxLength: 2_000 })),
}, { additionalProperties: false });

export const INTERACTIVE_WORKSPACE_PROJECTION_SCHEMA = Type.Object({
  snapshotVersion: Type.Integer({ minimum: 0 }),
  generatedAt: isoTimestamp,
  accountUserId: Type.String({ pattern: "^usr_[A-Za-z0-9]{8,}$" }),
  roles: Type.Array(Type.Union([Type.Literal("student"), Type.Literal("teacher")]), {
    minItems: 1, maxItems: 2, uniqueItems: true,
  }),
  files: Type.Array(Type.Object({
    path: projectionPath,
    content: Type.String(),
  }, { additionalProperties: false }), { maxItems: MAXIMUM_WORKSPACE_PROJECTION_FILES }),
  objects: Type.Array(Type.Object({
    path: projectionPath,
    // The content-integrity package owns this nested domain schema. Consumers
    // validate it there rather than maintaining a second descriptor contract.
    descriptor: Type.Unknown(),
  }, { additionalProperties: false }), { maxItems: MAXIMUM_WORKSPACE_PROJECTION_OBJECTS }),
  manifest: Type.Object({
    schema: Type.Literal("mathpilot.agent-context-manifest/v1"),
    manifest_ref: Type.String({ minLength: 1, maxLength: 2_000 }),
    foreground_epoch_id: foregroundEpochId,
    snapshot_version: Type.Integer({ minimum: 0 }),
    generated_at: isoTimestamp,
    items: Type.Array(projectionManifestItem, { maxItems: 4_096 }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export const INTERACTIVE_PREPARE_RESPONSE_SCHEMA = Type.Object({
  schema: Type.Literal("mathpilot.interactive-prepare/v1"),
  frozen_input: Type.Record(Type.String(), Type.Unknown()),
  workspace_projection: INTERACTIVE_WORKSPACE_PROJECTION_SCHEMA,
}, { additionalProperties: false });

export type InteractiveWorkspaceProjection = Static<typeof INTERACTIVE_WORKSPACE_PROJECTION_SCHEMA>;
export type InteractivePrepareResponse = Static<typeof INTERACTIVE_PREPARE_RESPONSE_SCHEMA>;

const timestampIsCanonical = (value: string): boolean => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
};

const projectionPathIsSafe = (value: string): boolean => {
  if (value.startsWith("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  const segments = value.split("/");
  const encoder = new TextEncoder();
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== ".."
    && encoder.encode(segment).byteLength <= 255);
};

export function parseInteractiveWorkspaceProjection(value: unknown): InteractiveWorkspaceProjection {
  if (!Value.Check(INTERACTIVE_WORKSPACE_PROJECTION_SCHEMA, value)) {
    throw new Error("interactive workspace projection is invalid");
  }
  const projection = Value.Clone(value) as InteractiveWorkspaceProjection;
  const paths = [...projection.files, ...projection.objects].map((entry) => entry.path);
  if (paths.some((entry) => !projectionPathIsSafe(entry))
    || new Set(paths).size !== paths.length || paths.includes("manifest.json")) {
    throw new Error("interactive workspace projection path is invalid");
  }
  const encoder = new TextEncoder();
  const inlineBytes = projection.files.reduce(
    (total, file) => total + encoder.encode(file.content).byteLength,
    0,
  );
  if (inlineBytes > MAXIMUM_WORKSPACE_PROJECTION_BYTES) {
    throw new Error("interactive workspace projection exceeds its byte budget");
  }
  if (!timestampIsCanonical(projection.generatedAt)
    || !timestampIsCanonical(projection.manifest.generated_at)
    || projection.manifest.generated_at !== projection.generatedAt
    || projection.manifest.snapshot_version !== projection.snapshotVersion
    || projection.manifest.items.some((item) => !timestampIsCanonical(item.freshness))) {
    throw new Error("interactive workspace projection metadata is inconsistent");
  }
  return Object.freeze(projection);
}

export function parseInteractivePrepareResponse(value: unknown): InteractivePrepareResponse {
  if (!Value.Check(INTERACTIVE_PREPARE_RESPONSE_SCHEMA, value)) {
    throw new Error("interactive prepare response is invalid");
  }
  const response = Value.Clone(value) as InteractivePrepareResponse;
  return Object.freeze({
    ...response,
    workspace_projection: parseInteractiveWorkspaceProjection(response.workspace_projection),
  });
}

/** Exact identity shared by API admission, the Pi host and Pi extensions. */
export const INTERACTIVE_ADMISSION_RECEIPT_SCHEMA = Type.Object({
  operation_id: operationId,
  foreground_request_id: foregroundRequestId,
  conversation_thread_id: conversationThreadId,
  foreground_epoch_id: foregroundEpochId,
  triggering_message_id: messageId,
  event_id: eventId,
  agent_attempt_id: agentAttemptId,
  input_ref: inputRef,
  driver_execution_id: driverExecutionId,
  execution_driver: Type.Literal("interactive_epoch"),
}, { additionalProperties: false });

/** Receipt subset sent on each Pi -> Learning callback. */
export const INTERACTIVE_ATTEMPT_BINDING_SCHEMA = Type.Object({
  operation_id: operationId,
  foreground_request_id: foregroundRequestId,
  conversation_thread_id: conversationThreadId,
  foreground_epoch_id: foregroundEpochId,
  triggering_message_id: messageId,
  input_ref: inputRef,
  driver_execution_id: driverExecutionId,
}, { additionalProperties: false });

export type InteractiveAdmissionReceipt = Static<typeof INTERACTIVE_ADMISSION_RECEIPT_SCHEMA>;
export type InteractiveAttemptBinding = Static<typeof INTERACTIVE_ATTEMPT_BINDING_SCHEMA>;

const assertDriverBinding = (value: InteractiveAttemptBinding): void => {
  const expected = `interactive-epoch:${value.foreground_epoch_id}:${value.foreground_request_id}`;
  if (value.driver_execution_id !== expected) {
    throw new Error("interactive driver execution identity is invalid");
  }
};

export function parseInteractiveAdmissionReceipt(value: unknown): InteractiveAdmissionReceipt {
  if (!Value.Check(INTERACTIVE_ADMISSION_RECEIPT_SCHEMA, value)) {
    throw new Error("interactive admission receipt is invalid");
  }
  const receipt = Value.Clone(value) as InteractiveAdmissionReceipt;
  assertDriverBinding(receipt);
  return Object.freeze(receipt);
}

export function parseInteractiveAttemptBinding(value: unknown): InteractiveAttemptBinding {
  if (!Value.Check(INTERACTIVE_ATTEMPT_BINDING_SCHEMA, value)) {
    throw new Error("interactive attempt binding is invalid");
  }
  const binding = Value.Clone(value) as InteractiveAttemptBinding;
  assertDriverBinding(binding);
  return Object.freeze(binding);
}

export function interactiveReceiptBinding(receipt: InteractiveAdmissionReceipt): InteractiveAttemptBinding {
  return parseInteractiveAttemptBinding({
    operation_id: receipt.operation_id,
    foreground_request_id: receipt.foreground_request_id,
    conversation_thread_id: receipt.conversation_thread_id,
    foreground_epoch_id: receipt.foreground_epoch_id,
    triggering_message_id: receipt.triggering_message_id,
    input_ref: receipt.input_ref,
    driver_execution_id: receipt.driver_execution_id,
  });
}
