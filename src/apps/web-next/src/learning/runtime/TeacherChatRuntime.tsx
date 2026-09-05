"use client";

// 教师对话运行时：教师 / 及 /c/:threadId 下的多轮对话空间。教师消息不写
// 学习证据、不生成 BKT/科学状态，也没有自我测评；只把 Pi transcript 渲染成
// 普通文本消息，由 pi-chat-runtime 保存并延续上下文。
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadAssistantMessagePart,
  type ThreadMessage,
  type ThreadUserMessagePart,
} from "@assistant-ui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftIcon } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { UnifiedAttachmentAdapter } from "@/AttachmentAdapter";
import { Button } from "@/components/ui/button";
import {
  teacherChatApi,
  teacherChatKeys,
  teacherChatText,
  type TeacherChatAttachmentPart,
  type TeacherParseStatus,
} from "../data/teacherChatClient";

type PendingMessage = {
  key: string;
  threadId?: string;
  message: ThreadMessage;
};

export function TeacherChatRuntimeProvider({
  threadId,
  children,
}: {
  threadId?: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<PendingMessage | null>(null);
  const attachmentAdapter = useMemo(() => new UnifiedAttachmentAdapter(), []);
  const query = useQuery({
    queryKey: threadId ? teacherChatKeys.thread(threadId) : teacherChatKeys.all,
    queryFn: () => teacherChatApi.threadMessages(threadId!),
    enabled: Boolean(threadId),
    retry: 1,
  });

  const canonical = useMemo(
    () => (query.data?.messages ?? []).map((message, index) => teacherMessage(message, `${threadId ?? "thread"}:${index}`)),
    [query.data?.messages, threadId],
  );
  const canonicalIds = useMemo(() => new Set(canonical.map((message) => message.id)), [canonical]);

  const parseQuery = useQuery({
    queryKey: threadId ? ["teacher-chat", "parse", threadId] : ["teacher-chat", "parse", "none"],
    queryFn: () => teacherChatApi.parseStatus(threadId!),
    enabled: Boolean(threadId),
    retry: 1,
    refetchInterval: (state) => {
      const stage = (state.state.data as TeacherParseStatus | undefined)?.stage;
      return stage === "parsing" || stage === "reviewing" || stage === "er" ? 3000 : false;
    },
  });
  const parseStage = threadId ? parseQuery.data?.stage ?? "none" : "none";
  const parseSteps = ["上传资料", "解析抽取中", "写入资料库", "完成"];
  const parseStepIndex = ({ parsing: 1, reviewing: 2, er: 2, done: 3 } as Record<string, number>)[parseStage] ?? -1;

  const messages = useMemo(() => {
    if (!pending || (pending.threadId && pending.threadId !== threadId)) return canonical;
    if (pending.threadId || canonicalIds.has(pending.message.id)) return canonical;
    return [...canonical, pending.message];
  }, [canonical, canonicalIds, pending, threadId]);

  const onNew = useCallback(async (message: AppendMessage) => {
    const text = message.content
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim();
    const attachmentParts: TeacherChatAttachmentPart[] = [];
    for (const attachment of message.attachments ?? []) {
      const file = attachment.content.find((part) => part.type === "file");
      if (!file || !file.data.startsWith("storage-object:")) {
        throw new Error(`附件 ${attachment.name} 尚未完成上传，请稍后再发送`);
      }
      attachmentParts.push({
        attachment_ref: file.data,
        name: attachment.name,
        mime_type: attachment.contentType,
      });
    }
    if (!text && attachmentParts.length === 0) throw new Error("消息内容为空");
    const key = `teacher-${crypto.randomUUID?.() ?? `${Date.now()}`}`;
    const optimistic: ThreadMessage = {
      id: `optimistic:${key}`,
      role: "user",
      createdAt: message.createdAt,
      content: text ? [{ type: "text", text }] : [],
      attachments: message.attachments ?? [],
      metadata: { custom: { teacherChatOptimistic: true }, isOptimistic: true },
    };
    setPending({ key, threadId, message: optimistic });
    try {
      let targetThreadId = threadId;
      if (!targetThreadId) {
        const created = await teacherChatApi.createThread();
        targetThreadId = created.thread_id;
        navigate(`/c/${encodeURIComponent(targetThreadId)}`, { replace: true });
      }
      const receipt = await teacherChatApi.sendMessage(targetThreadId, text, attachmentParts);
      setPending((current) => current?.key === key ? null : current);
      queryClient.setQueryData(teacherChatKeys.thread(targetThreadId), receipt);
      await queryClient.invalidateQueries({ queryKey: teacherChatKeys.threads });
    } catch (error) {
      setPending((current) => current?.key === key ? null : current);
      throw error;
    }
  }, [navigate, queryClient, threadId]);

  const runtime = useExternalStoreRuntime({
    messages,
    isLoading: Boolean(threadId) && query.isPending && messages.length === 0,
    isRunning: Boolean(pending),
    isDisabled: false,
    isSendDisabled: Boolean(pending) || (Boolean(threadId) && !query.data),
    onNew,
    onRefetchThread: async () => { await query.refetch(); },
    adapters: { attachments: attachmentAdapter, threadList: { threadId: threadId ?? "new" } },
  });

  if (query.isError && messages.length === 0) {
    return (
      <main className="mx-auto w-full max-w-5xl p-6 md:p-10">
        <div className="rounded-2xl border p-6 text-center">
          <p className="text-muted-foreground text-sm">这个对话无法打开（{query.error.message}）。</p>
          <div className="mt-4 flex items-center justify-center gap-2">
            <Button variant="outline" onClick={() => navigate("/")}><ArrowLeftIcon className="size-4" />返回对话</Button>
            <Button onClick={() => navigate("/")}>新建对话</Button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <>
      {parseStepIndex >= 0 && (
        <div className="pointer-events-none fixed inset-x-0 top-3 z-50 flex justify-center px-4" role="status">
          <div className="border-border/60 bg-background/95 shadow-sm pointer-events-auto flex max-w-2xl flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-2xl border px-4 py-2.5 text-xs backdrop-blur">
            {parseSteps.map((step, index) => (
              <span key={step} className="flex items-center gap-1.5">
                <span className={index === parseStepIndex ? "text-primary font-semibold" : index < parseStepIndex ? "text-accent2 font-medium" : "text-muted-foreground/70"}>
                  {index < parseStepIndex ? "✓" : `${index + 1}.`} {step}
                </span>
                {index < parseSteps.length - 1 && <span className="text-muted-foreground/40">→</span>}
              </span>
            ))}
            {parseStage === "done" && (
              <>
                <Button size="sm" variant="outline" onClick={() => navigate("/teacher/library?paper=auto")}>去组卷</Button>
                <Button size="sm" variant="outline" onClick={() => navigate("/teacher/library")}>前往我的资料库</Button>
              </>
            )}
          </div>
        </div>
      )}
      <AssistantRuntimeProvider runtime={runtime}>
        {children}
      </AssistantRuntimeProvider>
    </>
  );
}

function teacherMessage(message: { role: string; content: unknown; timestamp?: number }, fallbackId: string): ThreadMessage {
  const createdAt = new Date(typeof message.timestamp === "number" ? message.timestamp : Date.now());
  if (message.role === "assistant") {
    const part: ThreadAssistantMessagePart = { type: "text", text: teacherChatText(message) };
    return {
      id: `assistant:${fallbackId}`,
      role: "assistant",
      createdAt,
      content: [part],
      status: { type: "complete", reason: "stop" },
      metadata: {
        unstable_state: null,
        unstable_annotations: [],
        unstable_data: [],
        steps: [],
        custom: { teacherChat: true },
      },
    };
  }
  const text = message.role === "user" ? teacherChatText(message) : "";
  return {
    id: `user:${fallbackId}`,
    role: "user",
    createdAt,
    content: text ? [{ type: "text", text } satisfies ThreadUserMessagePart] : [],
    attachments: [],
    metadata: { custom: { teacherChat: true } },
  };
}
