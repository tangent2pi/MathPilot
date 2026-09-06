import type { ThreadMessage, ThreadAssistantMessagePart, CompleteAttachment } from "@assistant-ui/react";
import { teacherChatText, type TeacherChatMessage } from "../data/teacherChatClient";

const importInstructions = "这是教师资料导入。除非教师明确要求只阅读或讲解，否则读取 ktq-extraction Skill，从这些文件抽取知识点、题型和题目，执行校验，并调用 respond 注册候选集；不能只口头承诺稍后抽取。不要自行生成来源中不存在的题目。后续入库由宿主推进。\n请全程使用简体中文回复。";
const legacyInstructions = "请按需读取这些文件（例如先用内容工具查看 PDF 或图片版面）。\n请全程使用简体中文回复，不要在回复中夹杂英文。";

/** Project known host-added envelopes without mutating the durable model transcript. */
export function teacherUserPresentation(text: string): { text: string; attachments: CompleteAttachment[] } {
  const fallback = { text, attachments: [] };
  const marker = "\n\n本次消息附带文件：\n";
  const start = text.lastIndexOf(marker);
  const suffix = [importInstructions, legacyInstructions].find(value => text.endsWith(`\n${value}`));
  if (start < 0 || !suffix) return fallback;
  const lines = text.slice(start + marker.length, -(suffix.length + 1)).split("\n");
  if (!lines.length || lines.length > 5) return fallback;
  const attachments: CompleteAttachment[] = [];
  for (const line of lines) {
    const match = /^- input\/original\/(obj_[A-Za-z0-9]+)_[^\r\n]+（原名：(.+)；MIME：([^；\r\n]+)；(\d+) 字节；SHA-256：[0-9a-f]+…）$/.exec(line);
    if (!match) return fallback;
    const objectId = match[1]!;
    const name = match[2]!;
    const mimeType = match[3]!;
    attachments.push({ id: objectId, type: "document", name, contentType: mimeType,
      status: { type: "complete" },
      content: [{ type: "file", data: `storage-object:${objectId}`, mimeType, filename: name, sourceType: "id" }],
    });
  }
  return { text: text.slice(0, start), attachments };
}

/** Both live snapshots and durable Pi history pass through the same renderer. */
export function teacherTranscript(messages: readonly TeacherChatMessage[], threadId: string, running = false): ThreadMessage[] {
  const results = new Map(messages.filter((message) => message.role === "toolResult" && message.toolCallId).map((message) => [message.toolCallId, message]));
  const output: ThreadMessage[] = [];
  const reviewCards = new Map<string, Set<string>>();
  messages.forEach((message, index) => {
    if (message.role !== "user" && message.role !== "assistant") return;
    const createdAt = new Date(message.timestamp ?? 0);
    if (message.role === "user") {
      const display = teacherUserPresentation(teacherChatText(message));
      output.push({ id: `${threadId}:user:${index}`, role: "user", createdAt, attachments: display.attachments, content: [{ type: "text", text: display.text }], metadata: { custom: { teacherChat: true } } });
      return;
    }
    const content: ThreadAssistantMessagePart[] = [];
    const candidateIds: string[] = [];
    for (const raw of Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }]) {
      if (!raw || typeof raw !== "object") continue;
      const part = raw as Record<string, any>;
      if (part.type === "toolCall" && part.name === "respond") {
        const result = results.get(part.id);
        if (result && !result.isError && Array.isArray(result.content)) {
          for (const block of result.content) {
            if (block?.type !== "text") continue;
            try {
              const receipt = JSON.parse(block.text);
              const id = receipt.candidate_set_id ?? receipt.candidate?.candidate_set_id;
              if (receipt.schema === "mathpilot.content-respond/v1" && typeof id === "string") candidateIds.push(id);
            } catch { /* An unfinished tool result is not a review receipt. */ }
          }
        }
      }
      if (part.type === "text" && typeof part.text === "string") content.push({ type: "text", text: part.text });
      if (part.type === "thinking") content.push({ type: "reasoning", text: part.redacted ? "此段思考未公开" : String(part.thinking ?? ""), status: { type: "complete" } });
      if (part.type === "toolCall" && part.name !== "respond") {
        const result = results.get(part.id);
        content.push({ type: "tool-call", toolCallId: part.id, toolName: `mathpilot.workspace.${part.name}`, args: {}, argsText: "{}",
          ...(result || !running ? { result: { status: !result ? "interrupted" : result.isError ? "error" : "done" }, isError: !result || Boolean(result.isError) } : {}),
        });
      }
    }
    if (message.errorMessage) content.push({ type: "text", text: `执行未完成：${message.errorMessage}` });
    const previous = output.at(-1);
    if (previous?.role === "assistant") {
      output[output.length - 1] = { ...previous, content: [...previous.content, ...content] };
    } else {
      output.push({ id: `${threadId}:assistant:${index}`, role: "assistant", createdAt, content,
        status: { type: "complete", reason: "stop" },
        metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: { teacherChat: true } },
      });
    }
    const assistantId = output.at(-1)?.id;
    if (assistantId && candidateIds.length) reviewCards.set(assistantId, new Set([...(reviewCards.get(assistantId) ?? []), ...candidateIds]));
  });
  const last = output.at(-1);
  if (running && last?.role === "assistant") output[output.length - 1] = { ...last, status: { type: "running" } };
  return output.map(message => message.role === "assistant" && message.status.type !== "running" && reviewCards.has(message.id)
    ? { ...message, content: [...message.content, ...[...reviewCards.get(message.id)!].map(candidateSetId => ({ type: "data" as const, name: "mathpilot-teacher-review", data: { candidateSetId } }))] }
    : message);
}
