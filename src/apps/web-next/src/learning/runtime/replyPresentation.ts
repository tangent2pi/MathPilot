import type { ThreadMessage } from "@assistant-ui/react";
import type { LearningThreadMessage, ReplyPresentationLink, ThreadOperation } from "../contracts";

/** Presentation only: never rewrite canonical messages or infer ownership from timestamps. */
export function mergeReplyPresentations(
  items: readonly ThreadMessage[],
  canonical: readonly LearningThreadMessage[],
  operations: readonly ThreadOperation[],
  links: readonly ReplyPresentationLink[],
): ThreadMessage[] {
  const result = [...items];
  const removed = new Set<string>();
  const byRef = new Map(links.map((link) => [link.resource_ref, link]));
  const targetFor = (link: ReplyPresentationLink) => {
    const live = result.find((item) => item.id === `delta:${link.foreground_operation_id}`);
    if (live) return live;
    const reply = canonical.find((message) => message.author_kind === "assistant"
      && message.reply_to_message_id === link.triggering_message_id);
    return reply ? result.find((item) => item.id === reply.message_id) : undefined;
  };
  const append = (target: ThreadMessage, source: ThreadMessage) => {
    if (target.role !== "assistant" || source.role !== "assistant" || target.id === source.id) return;
    const index = result.findIndex((item) => item.id === target.id);
    result[index] = { ...target, content: [...target.content, ...source.content] };
    removed.add(source.id);
  };
  const published = new Set<string>();
  for (const message of canonical) {
    // Only attach standalone system cards, never consume a student's answer or another reply.
    if (message.author_kind !== "system" || message.parts.length !== 1) continue;
    const part = message.parts[0];
    if (part?.type !== "domain_ui" || part.part.view_kind !== "question") continue;
    const intent = part.part.snapshot.data.selection_intent_id;
    if (typeof intent !== "string") continue;
    const ref = `selection-intent:${intent}`;
    published.add(ref);
    published.add(part.part.resource_ref);
    published.add(`message:${message.message_id}`);
    published.add(`canonical-message:${message.message_id}`);
    const link = byRef.get(ref);
    const card = result.find((item) => item.id === message.message_id);
    const target = link && targetFor(link);
    if (target && card) append(target, card);
  }
  for (const operation of operations) {
    if (operation.kind === "foreground_teaching") continue;
    const source = result.find((item) => item.id === `operation:${operation.operation_id}`);
    if (!source) continue;
    // A published question replaces its loading status, even if the operation read is a tick behind.
    if (operation.kind === "select_question" && operation.related_resource_refs.some((ref) => published.has(ref))) {
      removed.add(source.id);
      continue;
    }
    const link = operation.related_resource_refs.map((ref) => byRef.get(ref)).find(Boolean);
    const target = link && targetFor(link);
    if (target) append(target, source);
  }
  return result.filter((item) => !removed.has(item.id));
}
