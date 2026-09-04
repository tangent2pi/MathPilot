import { MATH_DERIVATION_ARTIFACT_SCHEMA } from "@mathpilot/contracts";

// Compatibility re-export for the executor while the shared contract remains
// the sole implementation of the action schema and parser.
export { parseBoundedLearningAction } from "@mathpilot/contracts";

const refPattern = /^[a-z][a-z0-9+.-]*:[^\s]+$/;
const threadPattern = /^thr_[A-Za-z0-9]{8,}$/;
const epochPattern = /^fge_[A-Za-z0-9]{8,}$/;
const messagePattern = /^msg_[A-Za-z0-9]{8,}$/;

const objectValue = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
};

const exactKeys = (value: Record<string, unknown>, allowed: readonly string[], label: string): void => {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} contains unsupported fields`);
};

const boundedText = (value: unknown, maximum: number, label: string): string => {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${label} must contain 1-${maximum} characters`);
  }
  return value;
};

export type ForegroundResponsePart =
  | { type: "text"; text: string }
  | { type: "teaching_artifact"; artifact_ref: string; artifact_schema: string; summary: string };

export interface ForegroundTeachingOutput {
  schema_version: 3;
  conversation_thread_id: string;
  foreground_epoch_id: string;
  reply_to_message_id: string;
  parts: ForegroundResponsePart[];
}

export interface ForegroundOutputBinding {
  conversationThreadId: string;
  foregroundEpochId: string;
  replyToMessageId: string;
}

export function parseForegroundTeachingOutput(value: unknown, binding: ForegroundOutputBinding): ForegroundTeachingOutput {
  const raw = objectValue(value, "foreground teaching output");
  exactKeys(raw, ["schema_version", "conversation_thread_id", "foreground_epoch_id", "reply_to_message_id", "parts"], "foreground teaching output");
  if (raw.schema_version !== 3
    || typeof raw.conversation_thread_id !== "string" || !threadPattern.test(raw.conversation_thread_id)
    || typeof raw.foreground_epoch_id !== "string" || !epochPattern.test(raw.foreground_epoch_id)
    || typeof raw.reply_to_message_id !== "string" || !messagePattern.test(raw.reply_to_message_id)) {
    throw new Error("foreground teaching output identity is invalid");
  }
  if (raw.conversation_thread_id !== binding.conversationThreadId
    || raw.foreground_epoch_id !== binding.foregroundEpochId
    || raw.reply_to_message_id !== binding.replyToMessageId) {
    throw new Error("foreground teaching output binding mismatch");
  }
  if (!Array.isArray(raw.parts) || raw.parts.length < 1 || raw.parts.length > 16) {
    throw new Error("foreground teaching output must contain 1-16 parts");
  }
  const parts = raw.parts.map((part): ForegroundResponsePart => {
    const item = objectValue(part, "foreground response part");
    if (item.type === "text") {
      exactKeys(item, ["type", "text"], "text response part");
      return { type: "text", text: boundedText(item.text, 50_000, "response text") };
    }
    if (item.type === "teaching_artifact") {
      exactKeys(item, ["type", "artifact_ref", "artifact_schema", "summary"], "teaching artifact response part");
      if (typeof item.artifact_ref !== "string" || !refPattern.test(item.artifact_ref)
        || item.artifact_schema !== MATH_DERIVATION_ARTIFACT_SCHEMA) {
        throw new Error("teaching artifact response part is invalid");
      }
      return {
        type: "teaching_artifact",
        artifact_ref: item.artifact_ref,
        artifact_schema: item.artifact_schema,
        summary: boundedText(item.summary, 1000, "teaching artifact summary"),
      };
    }
    throw new Error("foreground response cannot contain authoritative domain UI");
  });
  return {
    schema_version: 3,
    conversation_thread_id: raw.conversation_thread_id,
    foreground_epoch_id: raw.foreground_epoch_id,
    reply_to_message_id: raw.reply_to_message_id,
    parts,
  };
}
