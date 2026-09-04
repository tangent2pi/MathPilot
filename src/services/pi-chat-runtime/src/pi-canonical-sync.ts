import { createHash } from "node:crypto";
import { canonicalJson } from "@mathpilot/content-integrity/node";
import {
  CANONICAL_MIRROR_LINK_TYPE,
  CANONICAL_MIRROR_MESSAGE_TYPE,
  parseCanonicalMirrorDetails,
  parseCanonicalMirrorMessage,
} from "@mathpilot/contracts";
import type {
  CanonicalMessagePart,
  CanonicalMirrorDetails,
  CanonicalMirrorMessage,
} from "@mathpilot/contracts";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

const MESSAGE_ID = /^msg_[A-Za-z0-9]{8,}$/;
const DIGEST = /^[0-9a-f]{64}$/;

export const CANONICAL_MESSAGE_TYPE = CANONICAL_MIRROR_MESSAGE_TYPE;
export const CANONICAL_LINK_TYPE = CANONICAL_MIRROR_LINK_TYPE;
export type { CanonicalMirrorDetails, CanonicalMirrorMessage };
export type CanonicalSyncMessage = CanonicalMirrorMessage;

export interface CanonicalSessionAppender {
  manager: SessionManager;
  appendCustomMessage(message: {
    customType: string; content: string; display: boolean; details?: unknown;
  }): Promise<void>;
}

const digestOf = (value: Omit<CanonicalSyncMessage, "digest" | "reply_to_message_id">): string =>
  createHash("sha256").update(canonicalJson(value).json, "utf8").digest("hex");

export const parseCanonicalSyncMessage = (value: unknown): CanonicalSyncMessage => {
  const raw = parseCanonicalMirrorMessage(value);
  if (!Number.isFinite(Date.parse(raw.created_at))) throw new Error("canonical sync message timestamp is invalid");
  const message: CanonicalSyncMessage = {
    message_id: raw.message_id,
    author_kind: raw.author_kind,
    created_at: new Date(raw.created_at).toISOString(),
    parts: raw.parts as CanonicalMessagePart[],
    digest: raw.digest,
    ...(raw.reply_to_message_id ? { reply_to_message_id: raw.reply_to_message_id } : {}),
  };
  const computed = digestOf({
    message_id: message.message_id,
    author_kind: message.author_kind,
    created_at: message.created_at,
    parts: message.parts,
  });
  if (computed !== message.digest) throw new Error("canonical sync message digest does not match");
  return Object.freeze(message);
};

const assertPersistedDetailsIntegrity = (details: CanonicalMirrorDetails): void => {
  if (!Number.isFinite(Date.parse(details.created_at))
    || new Date(details.created_at).toISOString() !== details.created_at) {
    throw new Error("persisted canonical mirror timestamp is invalid");
  }
  const computed = digestOf({
    message_id: details.message_id,
    author_kind: details.author_kind,
    created_at: details.created_at,
    parts: details.parts,
  });
  if (computed !== details.digest) throw new Error("persisted canonical mirror digest does not match");
};

const detailsOf = (
  message: CanonicalSyncMessage,
  schema: CanonicalMirrorDetails["schema"],
): CanonicalMirrorDetails => ({
  schema,
  message_id: message.message_id,
  author_kind: message.author_kind,
  created_at: message.created_at,
  parts: message.parts,
  digest: message.digest,
});

const indexedCanonicalMessages = (manager: SessionManager): Map<string, string> => {
  const indexed = new Map<string, string>();
  for (const entry of manager.getEntries()) {
    if (entry.type !== "custom_message"
      || ![CANONICAL_MESSAGE_TYPE, CANONICAL_LINK_TYPE].includes(entry.customType as never)) continue;
    let details: CanonicalMirrorDetails;
    try { details = parseCanonicalMirrorDetails(entry.details); }
    catch { throw new Error("persisted canonical mirror marker is invalid"); }
    if (details.schema !== entry.customType || !MESSAGE_ID.test(details.message_id)
      || !DIGEST.test(details.digest)) throw new Error("persisted canonical mirror marker is invalid");
    assertPersistedDetailsIntegrity(details);
    const existing = indexed.get(details.message_id);
    if (existing && existing !== details.digest) throw new Error("persisted canonical mirror marker conflicts");
    indexed.set(details.message_id, details.digest);
  }
  return indexed;
};

const append = (
  session: CanonicalSessionAppender,
  message: CanonicalSyncMessage,
  kind: "visible" | "link",
): Promise<boolean> => {
  const indexed = indexedCanonicalMessages(session.manager);
  const existing = indexed.get(message.message_id);
  if (existing && existing !== message.digest) throw new Error("canonical message id changed its digest");
  if (existing) return Promise.resolve(false);
  const schema = kind === "visible" ? CANONICAL_MESSAGE_TYPE : CANONICAL_LINK_TYPE;
  return session.appendCustomMessage({
    customType: schema, content: "", display: kind === "visible", details: detailsOf(message, schema),
  }).then(() => true);
};

export const appendCanonicalVisible = (session: CanonicalSessionAppender, message: CanonicalSyncMessage): Promise<boolean> =>
  append(session, message, "visible");

export const appendCanonicalLink = (session: CanonicalSessionAppender, message: CanonicalSyncMessage): Promise<boolean> =>
  append(session, message, "link");
