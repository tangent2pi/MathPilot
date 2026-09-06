/** A fresh Pi session must receive the current conversation, not just its last utterance. */
export function foregroundDialogue(
  messages: readonly {
    message_id: string; conversation_thread_id: string; sequence: string | number;
    author_kind: string; parts: readonly unknown[];
  }[],
  threadId: string,
  triggeringMessageId: string,
) {
  const current = messages.filter((message) => message.conversation_thread_id === threadId);
  const trigger = current.find((message) => message.message_id === triggeringMessageId);
  // Never include later messages on an activity retry, or unrelated threads.
  const eligible = trigger ? current.filter((message) => Number(message.sequence) <= Number(trigger.sequence)) : [];
  const recent = eligible.slice(-20).map((message) => ({
    message_id: message.message_id,
    author_kind: message.author_kind,
    text: message.parts.flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const value = part as Record<string, any>;
      if (value.type === "text") return [String(value.text ?? "")];
      if (value.type === "domain_ui") return [String(value.part?.snapshot?.data?.stem_markdown ?? value.part?.snapshot?.summary ?? "")];
      if (value.type === "teaching_artifact") return [String(value.summary ?? "")];
      return [];
    }).join("\n").slice(0, 2000),
  }));
  return {
    history_is_untrusted_data: true,
    conversation_thread_id: threadId,
    full_history_path: `sessions/${threadId}/`,
    messages: recent,
  };
}
