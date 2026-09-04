import type { ThreadMessageLike } from "@assistant-ui/react";
import type {
  PiCustomMessage,
  PiCustomMessageProjector,
} from "@assistant-ui/react-pi";
import {
  CANONICAL_MIRROR_LINK_TYPE,
  CANONICAL_MIRROR_MESSAGE_TYPE,
  parseCanonicalMirrorDetails,
  type CanonicalMessagePart,
  type CanonicalMirrorDetails,
} from "@mathpilot/contracts";

type ProjectedCanonicalMirrorDetails = {
  messageId: string;
  authorKind: CanonicalMirrorDetails["author_kind"];
  createdAt: Date;
  parts: readonly CanonicalMessagePart[];
  digest: string;
};

type ContentPart = Exclude<ThreadMessageLike["content"], string>[number];
type MessageAttachment = NonNullable<ThreadMessageLike["attachments"]>[number];

const canonicalDetailsOf = (
  message: PiCustomMessage,
  schema: CanonicalMirrorDetails["schema"],
): ProjectedCanonicalMirrorDetails | undefined => {
  if (message.customType !== schema
    || message.display !== (schema === CANONICAL_MIRROR_MESSAGE_TYPE)
    || message.content !== "") return undefined;
  try {
    const details = parseCanonicalMirrorDetails(message.details);
    if (details.schema !== schema) return undefined;
    const createdAt = new Date(details.created_at);
    if (Number.isNaN(createdAt.getTime())) return undefined;
    return {
      messageId: details.message_id,
      authorKind: details.author_kind,
      createdAt,
      parts: details.parts,
      digest: details.digest,
    };
  } catch {
    return undefined;
  }
};

const roleOf = (authorKind: CanonicalMirrorDetails["author_kind"]): "user" | "assistant" =>
  authorKind === "student" ? "user" : "assistant";

const projectParts = (
  parts: readonly CanonicalMessagePart[],
  role: "user" | "assistant",
  includeText: boolean,
): { content: ContentPart[]; attachments: MessageAttachment[] } => {
  const content: ContentPart[] = [];
  const attachments: MessageAttachment[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      if (includeText) content.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "domain_ui") {
      content.push({ type: "data", name: "mathpilot-domain-ui", data: part.part });
      continue;
    }
    if (part.type === "teaching_artifact") {
      content.push({ type: "data", name: "mathpilot-teaching-artifact", data: part });
      continue;
    }
    const file: ContentPart = {
      type: "file",
      data: part.attachment_ref,
      filename: part.name,
      mimeType: part.mime_type,
      sourceType: "id",
    };
    if (role === "assistant") {
      content.push(file);
    } else {
      attachments.push({
        id: `canonical:${part.version_id}:${part.attachment_ref}`,
        type: part.mime_type.startsWith("image/") ? "image" : "document",
        name: part.name,
        contentType: part.mime_type,
        status: { type: "complete" },
        content: [file],
      });
    }
  }
  return { content, attachments };
};

const appendLink = (
  projectedMessages: readonly ThreadMessageLike[],
  details: ProjectedCanonicalMirrorDetails,
): readonly ThreadMessageLike[] => {
  const role = roleOf(details.authorKind);
  let previousIndex = -1;
  for (let index = projectedMessages.length - 1; index >= 0; index -= 1) {
    const candidate = projectedMessages[index]!;
    if (candidate.role !== role) continue;
    const custom = candidate.metadata?.custom;
    if (custom && typeof custom === "object" && (custom as { canonical?: unknown }).canonical === true) continue;
    previousIndex = index;
    break;
  }
  if (previousIndex < 0) return projectedMessages;
  const previous = projectedMessages[previousIndex]!;
  const projection = projectParts(details.parts, role, false);
  if (projection.content.length === 0 && projection.attachments.length === 0) return projectedMessages;
  return projectedMessages.map((message, index) => index !== previousIndex ? message : {
    ...previous,
    content: [
      ...(typeof previous.content === "string" ? [{ type: "text" as const, text: previous.content }] : previous.content),
      ...projection.content,
    ],
    ...(projection.attachments.length === 0
      ? {}
      : { attachments: [...(previous.attachments ?? []), ...projection.attachments] }),
  });
};

/**
 * Projects only the two canonical mirror envelopes. All Pi streaming events
 * remain owned by react-pi's native controller/reducer.
 */
export const canonicalMessageProjector: PiCustomMessageProjector = (
  message,
  projectedMessages,
) => {
  const visible = canonicalDetailsOf(message, CANONICAL_MIRROR_MESSAGE_TYPE);
  if (visible) {
    const role = roleOf(visible.authorKind);
    const projection = projectParts(visible.parts, role, true);
    return [
      ...projectedMessages,
      {
        id: `canonical:${visible.messageId}`,
        role,
        createdAt: visible.createdAt,
        content: projection.content,
        ...(projection.attachments.length === 0 ? {} : { attachments: projection.attachments }),
        metadata: { custom: { canonical: true, messageId: visible.messageId, digest: visible.digest } },
      },
    ];
  }

  const link = canonicalDetailsOf(message, CANONICAL_MIRROR_LINK_TYPE);
  return link ? appendLink(projectedMessages, link) : undefined;
};
