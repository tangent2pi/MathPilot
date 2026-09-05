"use client";

import {
  AssistantRuntimeProvider,
  useAui,
  useExternalStoreRuntime,
  useLocalRuntime,
  type AppendMessage,
  type ChatModelAdapter,
  type CompleteAttachment,
  type ThreadAssistantMessagePart,
  type ThreadMessage,
  type ThreadUserMessagePart,
} from "@assistant-ui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { UnifiedAttachmentAdapter } from "@/AttachmentAdapter";
import { AUTH_DRAFT_KEY, useAuth } from "@/auth";
import type {
  CanonicalMessagePart,
  LearningThreadMessage,
  ThreadMessagesView,
  ThreadOperation,
  UserSubmittedMessagePart,
} from "../contracts";
import { learningApi, learningKeys, newIdempotencyKey } from "../data/client";
import { TeacherChatRuntimeProvider } from "./TeacherChatRuntime";

const ACTIVE_OPERATION_STATUSES = new Set(["accepted", "running", "needs_input"]);

type PendingMessage = {
  key: string;
  threadId?: string;
  canonicalMessageId?: string;
  message: ThreadMessage;
};

type StreamingState = {
  sequence: number;
  content: ThreadAssistantMessagePart[];
};

type StreamingToolState = "start" | "done" | "error";

const streamingToolPart = (id: string, name: string, state: StreamingToolState): ThreadAssistantMessagePart => ({
  type: "tool-call",
  toolCallId: id,
  toolName: `mathpilot.workspace.${name}`,
  args: {},
  argsText: `tool ${name}`,
  ...(state === "done"
    ? { result: { status: "done" as const }, status: { type: "complete" as const } }
    : state === "error"
      ? { result: { status: "error" as const }, isError: true, status: { type: "complete" as const } }
      : { status: { type: "running" as const } }),
});

const closeTrailingReasoning = (content: readonly ThreadAssistantMessagePart[]): ThreadAssistantMessagePart[] => {
  const next = [...content];
  const last = next.at(-1);
  if (last?.type === "reasoning" && last.status?.type === "running") {
    next[next.length - 1] = { ...last, status: { type: "complete" } };
  }
  return next;
};

export function applyForegroundDelta(
  current: StreamingState | undefined,
  sequence: number,
  kind: "text" | "thinking" | "tool",
  delta: string,
): StreamingState {
  const base = current ?? { sequence: -1, content: [] };
  if (sequence <= base.sequence) return base;

  if (kind === "thinking") {
    const content = [...base.content];
    const last = content.at(-1);
    if (last?.type === "reasoning") {
      content[content.length - 1] = { ...last, text: `${last.text}${delta}`, status: { type: "running" } };
    } else {
      content.push({ type: "reasoning", text: delta, status: { type: "running" } });
    }
    return { sequence, content };
  }

  if (kind === "text") {
    const content = closeTrailingReasoning(base.content);
    const last = content.at(-1);
    if (last?.type === "text") {
      content[content.length - 1] = { ...last, text: `${last.text}${delta}` };
    } else {
      content.push({ type: "text", text: delta });
    }
    return { sequence, content };
  }

  try {
    const tool = JSON.parse(delta) as { name?: unknown; state?: unknown; id?: unknown };
    const name = typeof tool.name === "string" ? tool.name : "tool";
    if (name === "respond") return { ...base, sequence };
    const id = typeof tool.id === "string" && tool.id ? tool.id : `${name}:${sequence}`;
    const state: StreamingToolState = tool.state === "done" || tool.state === "error" ? tool.state : "start";
    const content = closeTrailingReasoning(base.content);
    const existing = content.findIndex((part) => part.type === "tool-call" && part.toolCallId === id);
    const nextPart = streamingToolPart(id, name, state);
    if (existing >= 0) content[existing] = nextPart;
    else content.push(nextPart);
    return { sequence, content };
  } catch {
    return { ...base, sequence };
  }
}

export function LearningRuntimeProvider({
  threadId,
  children,
}: {
  threadId?: string;
  children: ReactNode;
}) {
  const { principal, loading } = useAuth();
  if (loading && !principal) {
    return (
      <div className="grid h-dvh place-items-center" role="status" aria-live="polite">
        <Loader2Icon className="text-muted-foreground size-6 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        <span className="sr-only">正在读取账户</span>
      </div>
    );
  }
  return principal
    ? principal.roles.includes("teacher")
      ? <TeacherChatRuntimeProvider threadId={threadId}>{children}</TeacherChatRuntimeProvider>
      : <AuthenticatedLearningRuntime threadId={threadId}>{children}</AuthenticatedLearningRuntime>
    : <GuestRuntimeProvider>{children}</GuestRuntimeProvider>;
}

function AuthenticatedLearningRuntime({
  threadId,
  children,
}: {
  threadId?: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<PendingMessage | null>(null);
  const [streamingByOperation, setStreamingByOperation] = useState<ReadonlyMap<string, StreamingState>>(new Map());
  const attachmentAdapter = useMemo(() => new UnifiedAttachmentAdapter(), []);
  const query = useQuery({
    queryKey: threadId ? learningKeys.thread(threadId) : ["learning", "thread", "new"],
    queryFn: () => learningApi.threadMessages(threadId!),
    enabled: Boolean(threadId),
    retry: 1,
    // SSE 不可达/断连时轮询兜底：始终以低频轮询保证最终一致
    // （操作进行中提速到 1.2s；空闲 5s 轮询以捕获迟到事件）。
    refetchInterval: (state) => hasActiveOperation(state.state.data) ? 1_200 : 5_000,
  });
  const view = query.data;
  const operations = view?.data.operations ?? [];
  const activeOperation = [...operations].find((operation) => ACTIVE_OPERATION_STATUSES.has(operation.status));

  const onForegroundDelta = useCallback((
    operationId: string,
    sequence: number,
    kind: "text" | "thinking" | "tool",
    delta: string,
  ) => {
    setStreamingByOperation((current) => {
      const existing = current.get(operationId);
      if (existing && sequence <= existing.sequence) return current;
      const next = new Map(current);
      next.set(operationId, applyForegroundDelta(existing, sequence, kind, delta));
      return next;
    });
  }, []);
  useLearningEvents(Boolean(threadId), onForegroundDelta);

  useEffect(() => {
    if (!pending || !threadId || pending.threadId === threadId) return;
    setPending(null);
  }, [pending, threadId]);

  useEffect(() => {
    if (!pending?.canonicalMessageId) return;
    if (!view?.data.messages.some((message) => message.message_id === pending.canonicalMessageId)) return;
    setPending((current) => current?.key === pending.key ? null : current);
  }, [pending, view?.data.messages]);

  const messages = useMemo(() => {
    const canonical = view?.data.messages ?? [];
    const supersededJudgments = judgmentSupersessions(canonical);
    const streamedCanonicalReplies = new Map<string, LearningThreadMessage>();
    for (const operation of operations) {
      const streaming = streamingByOperation.get(operation.operation_id);
      if (operation.kind !== "foreground_teaching" || !streaming?.content.length) continue;
      const linkedMessages = new Set(operation.related_resource_refs
        .filter((ref) => ref.startsWith("canonical-message:"))
        .map((ref) => ref.slice("canonical-message:".length)));
      const reply = canonical.find((message) =>
        message.author_kind === "assistant" && linkedMessages.has(message.message_id));
      if (reply) streamedCanonicalReplies.set(operation.operation_id, reply);
    }
    const streamedCanonicalMessageIds = new Set(
      [...streamedCanonicalReplies.values()].map((message) => message.message_id),
    );
    // 前台教学（foreground_teaching）不渲染占位操作卡：实时内容由流式
    // 增量气泡呈现，终态与失败由权威 canonical 消息呈现；其余后台任务
    // （选题/收口/记忆整理）保留占位卡作为运行指示。
    const visibleOperations = operations.filter((operation) => operation.kind !== "foreground_teaching");
    const items: ThreadMessage[] = [
      ...canonical
        .filter((message) => !streamedCanonicalMessageIds.has(message.message_id))
        .map((message) => canonicalMessage(message, supersededJudgments)),
      ...visibleOperations.map(operationMessage),
    ];
    const canonicalHasPending = pending?.canonicalMessageId
      ? canonical.some((message) => message.message_id === pending.canonicalMessageId)
      : false;
    if (pending && !canonicalHasPending && (!pending.threadId || pending.threadId === threadId)) {
      items.push(pending.message);
    }
    // 当前页已有 live 轨迹时始终复用它；canonical 只校准最终正文和结束
    // 状态。避免结束时用另一套“工具+正文”整体替换，导致思考轨迹消失。
    for (const operation of operations) {
      if (operation.kind !== "foreground_teaching") continue;
      const streaming = streamingByOperation.get(operation.operation_id);
      if (!streaming?.content.length) continue;
      items.push(streamingTimelineMessage(operation, streaming, streamedCanonicalReplies.get(operation.operation_id)));
    }
    return items.sort((left, right) => {
      const time = left.createdAt.getTime() - right.createdAt.getTime();
      if (time !== 0) return time;
      return left.role === "user" && right.role !== "user" ? -1 : 1;
    });
  }, [activeOperation, operations, pending, streamingByOperation, threadId, view?.data.messages]);

  const onNew = useCallback(async (message: AppendMessage) => {
    const key = newIdempotencyKey("message");
    const requestedAt = message.createdAt.toISOString();
    const optimistic = optimisticMessage(key, message);
    setPending({ key, threadId, message: optimistic });
    try {
      let targetThreadId = threadId;
      let expectedVersion = view?.data.thread.version;
      if (!targetThreadId) {
        const created = await learningApi.createThread(`${key}:thread`);
        targetThreadId = created.thread.thread_id;
        expectedVersion = created.thread.version;
        setPending((current) => current?.key === key ? { ...current, threadId: targetThreadId } : current);
        navigate(`/c/${encodeURIComponent(targetThreadId)}`, { replace: true });
      }
      if (expectedVersion === undefined) throw new Error("对话仍在载入，请稍后重试");
      const receipt = await learningApi.sendMessage({
        threadId: targetThreadId,
        key,
        expectedVersion,
        parts: appendMessageParts(message),
        requestedAt,
      });
      setPending((current) => current?.key === key ? {
        ...current,
        canonicalMessageId: receipt.message_id,
        message: { ...current.message, id: receipt.message_id },
      } : current);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: learningKeys.threads }),
        queryClient.invalidateQueries({ queryKey: learningKeys.thread(targetThreadId) }),
      ]);
    } catch (error) {
      setPending((current) => current?.key === key ? null : current);
      throw error;
    }
  }, [navigate, queryClient, threadId, view?.data.thread.version]);

  const onCancel = activeOperation ? async () => {
    await learningApi.cancelOperation(activeOperation.operation_id, activeOperation.version);
    await query.refetch();
  } : undefined;

  const isLoading = Boolean(threadId) && query.isPending && messages.length === 0;
  const isRunning = Boolean(pending || activeOperation);
  const runtime = useExternalStoreRuntime({
    messages,
    isLoading,
    isRunning,
    isDisabled: view?.data.thread.status === "archived",
    isSendDisabled: Boolean(threadId && !view) || isRunning || view?.data.thread.status === "archived",
    onNew,
    ...(onCancel ? { onCancel } : {}),
    onRefetchThread: async () => { await query.refetch(); },
    adapters: { attachments: attachmentAdapter, threadList: { threadId: threadId ?? "new" } },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <PendingDraftRestorer />
      {children}
    </AssistantRuntimeProvider>
  );
}

function useLearningEvents(
  enabled: boolean,
  onForegroundDelta: (operationId: string, sequence: number, kind: "text" | "thinking" | "tool", delta: string) => void,
) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const events = new EventSource("/api/learning/events");
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void queryClient.invalidateQueries({ queryKey: learningKeys.all });
      }, 25);
    };
    events.addEventListener("open", refresh);
    for (const type of [
      "canonical_message.appended",
      "canonical_message.updated",
      "learning_resource.changed",
      "learning_operation.changed",
    ]) events.addEventListener(type, refresh);
    events.addEventListener("foreground.delta", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as {
          operation_id?: unknown; sequence?: unknown; kind?: unknown; delta?: unknown;
        };
        if (typeof data.operation_id !== "string" || typeof data.delta !== "string") return;
        const sequence = Number(data.sequence);
        if (!Number.isInteger(sequence) || sequence < 0) return;
        const kind = data.kind === "thinking" || data.kind === "tool" ? data.kind : "text";
        onForegroundDelta(data.operation_id, sequence, kind, data.delta);
      } catch {
        // 增量是展示投影；解析失败不影响权威消息刷新。
      }
    });
    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      events.close();
    };
  }, [enabled, onForegroundDelta, queryClient]);
}

function hasActiveOperation(view: ThreadMessagesView | undefined): boolean {
  return Boolean(view?.data.operations.some((operation) => ACTIVE_OPERATION_STATUSES.has(operation.status)));
}

function appendMessageParts(message: AppendMessage): UserSubmittedMessagePart[] {
  const parts: UserSubmittedMessagePart[] = message.content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text" && Boolean(part.text.trim()))
    .map((part) => ({ type: "text", text: part.text }));
  for (const attachment of message.attachments ?? []) {
    const file = attachment.content.find((part) => part.type === "file");
    if (!file || !file.data.startsWith("storage-object:obj_")) {
      throw new Error(`附件 ${attachment.name} 缺少可提交的存储引用`);
    }
    parts.push({
      type: "attachment",
      attachment_ref: file.data,
      name: attachment.name,
      mime_type: file.mimeType,
    });
  }
  if (parts.length === 0) throw new Error("消息内容为空");
  return parts;
}

function optimisticMessage(key: string, message: AppendMessage): ThreadMessage {
  const content = message.content.filter((part): part is ThreadUserMessagePart =>
    part.type === "text" || part.type === "image" || part.type === "file"
      || part.type === "data" || part.type === "audio");
  return {
    id: `optimistic:${key}`,
    role: "user",
    createdAt: message.createdAt,
    content,
    attachments: message.attachments ?? [],
    metadata: { custom: { optimistic: true, idempotencyKey: key }, isOptimistic: true },
  };
}

function canonicalMessage(
  message: LearningThreadMessage,
  supersededJudgments: ReadonlyMap<string, string> = new Map(),
): ThreadMessage {
  const createdAt = new Date(message.created_at);
  if (message.author_kind === "student") {
    return {
      id: message.message_id,
      role: "user",
      createdAt,
      content: message.parts.flatMap<ThreadUserMessagePart>((part) => {
        if (part.type === "text") return [{ type: "text", text: part.text }];
        if (part.type === "domain_ui") {
          return [{ type: "data", name: "mathpilot-domain-ui", data: presentDomainPart(part.part, supersededJudgments) }];
        }
        if (part.type === "teaching_artifact") {
          return [{ type: "data", name: "mathpilot-teaching-artifact", data: part }];
        }
        return [];
      }),
      attachments: message.parts.flatMap((part, index) => part.type === "attachment"
        ? [canonicalAttachment(message.message_id, index, part.attachment_ref, part.name, part.mime_type)]
        : []),
      metadata: { custom: { canonical: true, version: message.version, editable: message.editable, lockReason: message.lock_reason } },
    };
  }
  return {
    id: message.message_id,
    role: "assistant",
    createdAt,
    content: message.parts.flatMap<ThreadAssistantMessagePart>((part) => {
      if (part.type === "text") return [{ type: "text", text: part.text }];
      if (part.type === "attachment") return [{
        type: "file", data: part.attachment_ref, filename: part.name,
        mimeType: part.mime_type, sourceType: "id",
      }];
      if (part.type === "domain_ui") {
        return [{ type: "data", name: "mathpilot-domain-ui", data: presentDomainPart(part.part, supersededJudgments) }];
      }
      if (part.type === "tool_trace") {
        // 权威工具轨迹 → assistant-ui tool-call parts（消息内原生渲染，跨刷新持久）。
        return part.items.map<ThreadAssistantMessagePart>((tool, index) => ({
          type: "tool-call",
          toolCallId: `tool:${index}`,
          toolName: `mathpilot.workspace.${tool.name}`,
          args: {},
          argsText: `tool ${tool.name}`,
          ...(tool.state === "done"
            ? { result: { status: "done" as const }, status: { type: "complete" as const } }
            : { result: { status: "error" as const }, isError: true, status: { type: "complete" as const } }),
        }));
      }
      return [{ type: "data", name: "mathpilot-teaching-artifact", data: part }];
    }),
    status: message.lifecycle === "streaming"
      ? { type: "running" }
      : message.lifecycle === "failed"
        ? { type: "incomplete", reason: "error", error: "回复生成失败" }
        : { type: "complete", reason: "stop" },
    metadata: {
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: { canonical: true, version: message.version, lifecycle: message.lifecycle },
    },
  };
}

function judgmentSupersessions(messages: readonly LearningThreadMessage[]): ReadonlyMap<string, string> {
  const replacements = new Map<string, string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "domain_ui" || part.part.view_kind !== "judgment") continue;
      const data = part.part.snapshot.data;
      const supersededId = typeof data.supersedes_judgment_id === "string" ? data.supersedes_judgment_id : undefined;
      const replacementId = typeof data.judgment_id === "string" ? data.judgment_id : undefined;
      if (supersededId && replacementId) replacements.set(supersededId, replacementId);
    }
  }
  return replacements;
}

function presentDomainPart(
  part: Extract<CanonicalMessagePart, { type: "domain_ui" }>["part"],
  supersededJudgments: ReadonlyMap<string, string>,
): Extract<CanonicalMessagePart, { type: "domain_ui" }>["part"] {
  if (part.view_kind !== "judgment") return part;
  const judgmentId = typeof part.snapshot.data.judgment_id === "string"
    ? part.snapshot.data.judgment_id
    : part.resource_ref.replace(/^judgment:/, "");
  const replacementId = supersededJudgments.get(judgmentId);
  if (!replacementId) return part;
  return {
    ...part,
    snapshot: {
      ...part.snapshot,
      data: { ...part.snapshot.data, superseded_by_judgment_id: replacementId },
    },
  };
}

function canonicalAttachment(
  messageId: string,
  index: number,
  ref: string,
  name: string,
  mimeType: string,
): CompleteAttachment {
  return {
    id: `${messageId}:attachment:${index}`,
    type: mimeType.startsWith("image/") ? "image" : "document",
    name,
    contentType: mimeType,
    status: { type: "complete" },
    content: [{ type: "file", data: ref, filename: name, mimeType, sourceType: "id" }],
  };
}

function operationMessage(operation: ThreadOperation): ThreadMessage {
  const active = ACTIVE_OPERATION_STATUSES.has(operation.status);
  const failed = operation.status === "failed";
  const cancelled = operation.status === "cancelled";
  const title = operationTitle(operation.kind);
  const args = { operation_id: operation.operation_id, title };
  return {
    id: `operation:${operation.operation_id}`,
    role: "assistant",
    createdAt: new Date(operation.started_at),
    content: [
      {
        type: "reasoning",
        text: operation.user_message,
        status: active ? { type: "running" } : { type: "complete" },
      },
      {
        type: "tool-call",
        toolCallId: operation.operation_id,
        toolName: `mathpilot.operation.${operation.kind}`,
        args,
        argsText: JSON.stringify(args),
        ...(active ? {} : {
          result: { status: operation.status, user_message: operation.user_message },
          ...(failed ? { isError: true } : {}),
        }),
      },
    ],
    status: active
      ? { type: "running" }
      : failed
        ? { type: "incomplete", reason: "error", error: operation.user_message }
        : cancelled
          ? { type: "incomplete", reason: "cancelled" }
          : { type: "complete", reason: "stop" },
    metadata: {
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: { operationId: operation.operation_id, operationKind: operation.kind, operationStatus: operation.status },
    },
  };
}

function operationTitle(kind: string): string {
  const labels: Record<string, string> = {
    foreground_teaching: "组织讲解",
    select_question: "选择下一题",
    finalize_question: "判定并收口",
    dream: "整理学习记忆",
    annotation_feedback: "记录学习反馈",
  };
  return labels[kind] ?? "处理学习任务";
}

function PendingDraftRestorer() {
  const aui = useAui();
  useEffect(() => {
    const draft = sessionStorage.getItem(AUTH_DRAFT_KEY);
    if (!draft) return;
    aui.composer.setText(draft);
    sessionStorage.removeItem(AUTH_DRAFT_KEY);
  }, [aui]);
  return null;
}

function GuestRuntimeProvider({ children }: { children: ReactNode }) {
  const { requireAuth } = useAuth();
  const adapter = useMemo<ChatModelAdapter>(() => ({
    async run({ messages }) {
      const lastUser = [...messages].reverse().find((message) => message.role === "user");
      const draft = lastUser?.content
        .map((part) => part.type === "text" ? part.text : "")
        .join("") ?? "";
      requireAuth(draft);
      return { content: [] };
    },
  }), [requireAuth]);
  const runtime = useLocalRuntime(adapter);
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

function streamingTimelineMessage(
  operation: ThreadOperation,
  streaming: StreamingState,
  canonicalReply?: LearningThreadMessage,
): ThreadMessage {
  const active = ACTIVE_OPERATION_STATUSES.has(operation.status);
  const content = active ? [...streaming.content] : closeTrailingReasoning(streaming.content);
  if (canonicalReply) {
    const finalText = canonicalReply.parts
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (finalText) {
      let lastTextIndex = -1;
      for (let index = content.length - 1; index >= 0; index -= 1) {
        if (content[index]?.type === "text") {
          lastTextIndex = index;
          break;
        }
      }
      if (lastTextIndex >= 0) content[lastTextIndex] = { type: "text", text: finalText };
      else content.push({ type: "text", text: finalText });
    }
    for (const part of canonicalReply.parts) {
      if (part.type === "teaching_artifact") {
        content.push({ type: "data", name: "mathpilot-teaching-artifact", data: part });
      }
    }
  }
  return {
    id: `delta:${operation.operation_id}`,
    role: "assistant",
    createdAt: new Date(operation.started_at),
    content,
    status: active
      ? { type: "running" }
      : operation.status === "failed"
        ? { type: "incomplete", reason: "error", error: operation.user_message }
        : operation.status === "cancelled"
          ? { type: "incomplete", reason: "cancelled" }
          : { type: "complete", reason: "stop" },
    metadata: {
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: { streamingDelta: true, operationId: operation.operation_id },
    },
  };
}
