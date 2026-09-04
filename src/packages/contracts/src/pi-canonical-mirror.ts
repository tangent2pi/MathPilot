import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { CanonicalMessagePart } from "./science-v3-learning.js";

/**
 * The Pi session mirror transport is intentionally smaller than the Science v3
 * canonical ledger message.  It is a projection marker written to a Pi
 * session, not a replacement for the ledger schema.
 */
export const CANONICAL_MIRROR_MESSAGE_TYPE = "mathpilot.canonical-message/v1" as const;
export const CANONICAL_MIRROR_LINK_TYPE = "mathpilot.canonical-link/v1" as const;
export const MAX_CANONICAL_MIRROR_TRANSCRIPT_MESSAGES = 2_000;

const messageId = Type.String({ pattern: "^msg_[A-Za-z0-9]{8,}$" });
const authorKind = Type.Union([
  Type.Literal("student"), Type.Literal("assistant"), Type.Literal("system"),
]);

const textPart = Type.Object({
  type: Type.Literal("text"),
  text: Type.String({ minLength: 1, maxLength: 50_000 }),
}, { additionalProperties: false });

const attachmentPart = Type.Object({
  type: Type.Literal("attachment"),
  attachment_ref: Type.String({ minLength: 1, maxLength: 1024 }),
  name: Type.String({ minLength: 1, maxLength: 240 }),
  mime_type: Type.String({ minLength: 3, maxLength: 160 }),
  version_id: Type.String({ minLength: 1, maxLength: 1024 }),
  sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  byte_size: Type.Integer({ minimum: 1, maximum: 48 * 1024 * 1024 }),
}, { additionalProperties: false });

const domainUiPart = Type.Object({
  type: Type.Literal("domain_ui"),
  part: Type.Object({
    schema: Type.Literal("mathpilot.message-part/domain-ui/v1"),
    part_id: Type.String({ minLength: 1, maxLength: 200 }),
    view_kind: Type.Union([
      Type.Literal("question"), Type.Literal("answer_receipt"), Type.Literal("judgment"),
      Type.Literal("probe"), Type.Literal("question_closure"), Type.Literal("learning_update"),
      Type.Literal("memory_update"), Type.Literal("review_due"), Type.Literal("activity_milestone"),
    ]),
    resource_ref: Type.String({ minLength: 1, maxLength: 1024 }),
    resource_version: Type.Integer({ minimum: 0 }),
    snapshot: Type.Object({
      schema: Type.String({ pattern: "^mathpilot\\.view/.+/v[0-9]+$" }),
      title: Type.String({ minLength: 1, maxLength: 500 }),
      summary: Type.String({ minLength: 1, maxLength: 2_000 }),
      data: Type.Record(Type.String(), Type.Unknown()),
      redactions: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 64 })),
    }, { additionalProperties: false }),
    action_slots: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 32 }),
    occurred_at: Type.String({ minLength: 1, maxLength: 64 }),
    origin: Type.Literal("domain_projector"),
    domain_event_ref: Type.String({ minLength: 1, maxLength: 1024 }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const teachingArtifactPart = Type.Object({
  type: Type.Literal("teaching_artifact"),
  artifact_ref: Type.String({ minLength: 1, maxLength: 1024 }),
  artifact_schema: Type.String({ minLength: 1, maxLength: 1024 }),
  summary: Type.String({ minLength: 1, maxLength: 1_000 }),
}, { additionalProperties: false });

const canonicalMirrorPart = Type.Union([
  textPart, attachmentPart, domainUiPart, teachingArtifactPart,
]);

/** Strict transport shape sent from the canonical API to a Pi host. */
export const CANONICAL_MIRROR_MESSAGE_SCHEMA = Type.Object({
  message_id: messageId,
  author_kind: authorKind,
  created_at: Type.String({ minLength: 1, maxLength: 64 }),
  parts: Type.Array(canonicalMirrorPart, { minItems: 1, maxItems: 32 }),
  digest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  reply_to_message_id: Type.Optional(messageId),
}, { additionalProperties: false });

const canonicalMirrorDetailsVariant = (schema: typeof CANONICAL_MIRROR_MESSAGE_TYPE | typeof CANONICAL_MIRROR_LINK_TYPE) =>
  Type.Object({
    schema: Type.Literal(schema),
    message_id: messageId,
    author_kind: authorKind,
    created_at: Type.String({ minLength: 1, maxLength: 64 }),
    parts: Type.Array(canonicalMirrorPart, { minItems: 1, maxItems: 32 }),
    digest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  }, { additionalProperties: false });

/** Strict details stored on Pi custom-message entries. */
export const CANONICAL_MIRROR_DETAILS_SCHEMA = Type.Union([
  canonicalMirrorDetailsVariant(CANONICAL_MIRROR_MESSAGE_TYPE),
  canonicalMirrorDetailsVariant(CANONICAL_MIRROR_LINK_TYPE),
]);

type MirrorMessageStatic = Static<typeof CANONICAL_MIRROR_MESSAGE_SCHEMA>;
type MirrorDetailsStatic = Static<typeof CANONICAL_MIRROR_DETAILS_SCHEMA>;

// Keep the established Science v3 part type as the public TypeScript boundary;
// TypeBox remains the runtime constraint source for the transport.
export type CanonicalMirrorMessage = Omit<MirrorMessageStatic, "parts"> & {
  parts: CanonicalMessagePart[];
};
export type CanonicalMirrorDetails = Omit<MirrorDetailsStatic, "parts"> & {
  parts: CanonicalMessagePart[];
};

export function parseCanonicalMirrorMessage(value: unknown): CanonicalMirrorMessage {
  if (!Value.Check(CANONICAL_MIRROR_MESSAGE_SCHEMA, value)) {
    throw new Error("canonical mirror message is invalid");
  }
  return Value.Clone(value) as CanonicalMirrorMessage;
}

export function parseCanonicalMirrorDetails(value: unknown): CanonicalMirrorDetails {
  if (!Value.Check(CANONICAL_MIRROR_DETAILS_SCHEMA, value)) {
    throw new Error("canonical mirror details are invalid");
  }
  return Value.Clone(value) as CanonicalMirrorDetails;
}
