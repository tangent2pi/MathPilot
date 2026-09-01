"use client";

import {
  AssistantRuntimeProvider,
  MessageNotSentError,
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
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { UnifiedAttachmentAdapter } from "@/AttachmentAdapter";
import { AUTH_DRAFT_KEY, useAuth } from "@/auth";
import { mathpilotObjectMetadata } from "@/storage-upload";
import type {
  CanonicalMessagePart,
  LearningThreadMessage,
  ThreadMessagesView,
  ThreadOperation,
  UserSubmittedMessagePart,
} from "../contracts";
import { learningApi, learningKeys, newIdempotencyKey } from "../data/client";
import {
  acquireMessageCommandEnvelope,
  bindMessageCommandThread,
  messageCommandOutcomeIsUnknown,
  type MessageCommandEnvelope,
} from "./message-command-envelope";

const ACTIVE_OPERATION_STATUSES = new Set(["accepted", "running", "needs_input"]);

type PendingMessage = {
  key: string;
  threadId?: string;
  canonicalMessageId?: string;
  message: ThreadMessage;
};

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
    ? <AuthenticatedLearningRuntime threadId={threadId}>{children}</AuthenticatedLearningRuntime>
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
  const retryEnvelope = useRef<MessageCommandEnvelope | null>(null);
  const attachmentAdapter = useMemo(() => new UnifiedAttachmentAdapter(), []);
  const query = useQuery({
    queryKey: threadId ? learningKeys.thread(threadId) : ["learning", "thread", "new"],
    queryFn: () => learningApi.threadMessages(threadId!),
    enabled: Boolean(threadId),
    retry: 1,
    refetchInterval: (state) => hasActiveOperation(state.state.data) ? 1_200 : false,
  });
  const view = query.data;
  const operations = view?.data.operations ?? [];
  const activeOperation = [...operations].find((operation) => ACTIVE_OPERATION_STATUSES.has(operation.status));

  useLearningEvents(Boolean(threadId));

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
    const items: ThreadMessage[] = [
      ...canonical.map((message) => canonicalMessage(message, supersededJudgments)),
      ...operations.map(operationMessage),
    ];
    const canonicalHasPending = pending?.canonicalMessageId
      ? canonical.some((message) => message.message_id === pending.canonicalMessageId)
      : false;
    if (pending && !canonicalHasPending && (!pending.threadId || pending.threadId === threadId)) {
      items.push(pending.message);
    }
    return items.sort((left, right) => {
      const time = left.createdAt.getTime() - right.createdAt.getTime();
      if (time !== 0) return time;
      return left.role === "user" && right.role !== "user" ? -1 : 1;
    });
  }, [operations, pending, threadId, view?.data.messages]);

  const onNew = useCallback(async (message: AppendMessage) => {
    let parts: UserSubmittedMessagePart[];
    try {
      parts = appendMessageParts(message);
    } catch (error) {
      throw messageNotSent(error, false);
    }

    let envelope = acquireMessageCommandEnvelope(retryEnvelope.current, {
      threadId,
      expectedVersion: view?.data.thread.version,
      requestedAt: message.createdAt.toISOString(),
      parts,
    }, () => newIdempotencyKey("message"));
    retryEnvelope.current = envelope;
    const optimistic = optimisticMessage(envelope.key, message, new Date(envelope.requestedAt));
    setPending({ key: envelope.key, threadId: envelope.threadId, message: optimistic });

    let receipt: Awaited<ReturnType<typeof learningApi.sendMessage>>;
    let receiptThreadId: string | undefined;
    try {
      if (!envelope.threadId) {
        const created = await learningApi.createThread(
          `${envelope.key}:thread`,
          "新对话",
          envelope.requestedAt,
        );
        envelope = bindMessageCommandThread(envelope, created.thread.thread_id, created.thread.version);
        retryEnvelope.current = envelope;
        setPending((current) => current?.key === envelope.key
          ? { ...current, threadId: created.thread.thread_id }
          : current);
        navigate(`/c/${encodeURIComponent(created.thread.thread_id)}`, { replace: true });
      }
      const targetThreadId = envelope.threadId;
      if (!targetThreadId) throw new Error("对话标识未建立，请稍后重试");
      if (envelope.expectedVersion === undefined) throw new Error("对话仍在载入，请稍后重试");
      receipt = await learningApi.sendMessage({
        threadId: targetThreadId,
        key: envelope.key,
        expectedVersion: envelope.expectedVersion,
        parts: envelope.parts,
        requestedAt: envelope.requestedAt,
      });
      receiptThreadId = targetThreadId;
    } catch (error) {
      setPending((current) => current?.key === envelope.key ? null : current);
      const outcomeUnknown = messageCommandOutcomeIsUnknown(error);
      if (!outcomeUnknown && retryEnvelope.current?.key === envelope.key) retryEnvelope.current = null;
      throw messageNotSent(error, outcomeUnknown);
    }

    if (retryEnvelope.current?.key === envelope.key) retryEnvelope.current = null;
    setPending((current) => current?.key === envelope.key ? {
      ...current,
      canonicalMessageId: receipt.message_id,
      message: { ...current.message, id: receipt.message_id },
    } : current);
    attachmentAdapter.markCommitted(message.attachments ?? []);
    await Promise.allSettled([
      queryClient.invalidateQueries({ queryKey: learningKeys.threads }),
      queryClient.invalidateQueries({ queryKey: learningKeys.thread(receiptThreadId!) }),
    ]);
  }, [attachmentAdapter, navigate, queryClient, threadId, view?.data.thread.version]);

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
    adapters: { attachments: attachmentAdapter },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <PendingDraftRestorer />
      {children}
    </AssistantRuntimeProvider>
  );
}

function useLearningEvents(enabled: boolean) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const events = new EventSource("/api/learning/events");
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: learningKeys.all });
    };
    for (const type of [
      "canonical_message.appended",
      "canonical_message.updated",
      "learning_resource.changed",
      "learning_operation.changed",
    ]) events.addEventListener(type, refresh);
    return () => events.close();
  }, [enabled, queryClient]);
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
    const object = mathpilotObjectMetadata(file.providerMetadata?.mathpilot);
    if (!object || object.object_ref!==file.data) {
      throw new Error(`附件 ${attachment.name} 缺少不可变版本信息，请重新上传`);
    }
    parts.push({
      type: "attachment",
      attachment_ref: object.object_ref,
      name: object.original_name,
      mime_type: object.mime_type,
      version_id: object.version_id,
      sha256: object.sha256,
      byte_size: object.byte_size,
    });
  }
  if (parts.length === 0) throw new Error("消息内容为空");
  return parts;
}

function optimisticMessage(key: string, message: AppendMessage, createdAt = message.createdAt): ThreadMessage {
  const content = message.content.filter((part): part is ThreadUserMessagePart =>
    part.type === "text" || part.type === "image" || part.type === "file"
      || part.type === "data" || part.type === "audio");
  return {
    id: `optimistic:${key}`,
    role: "user",
    createdAt,
    content,
    attachments: message.attachments ?? [],
    metadata: { custom: { optimistic: true, idempotencyKey: key }, isOptimistic: true },
  };
}

function messageNotSent(error: unknown, outcomeUnknown: boolean): MessageNotSentError {
  if (outcomeUnknown) {
    return new MessageNotSentError("发送结果尚未确认；再次发送会安全复用同一请求");
  }
  return new MessageNotSentError(error instanceof Error ? error.message : "消息未发送");
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
