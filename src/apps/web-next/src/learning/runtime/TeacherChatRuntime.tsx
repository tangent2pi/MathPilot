"use client";

// 教师对话运行时：教师 / 及 /c/:threadId 下的多轮对话空间。教师消息不写
// 学习证据、不生成 BKT/科学状态，也没有自我测评；只把 Pi transcript 渲染成
// 普通文本消息，由 pi-chat-runtime 保存并延续上下文。
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessage,
} from "@assistant-ui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { UnifiedAttachmentAdapter } from "@/AttachmentAdapter";
import { Button } from "@/components/ui/button";
import {
  teacherChatApi,
  teacherChatKeys,
  type TeacherChatAttachmentPart,
  type TeacherParseStatus,
  type TeacherChatThreadDetail,
} from "../data/teacherChatClient";
import { teacherTranscript } from "./teacherTranscript";

type PendingMessage = {
  key: string;
  threadId?: string;
  message: ThreadMessage;
  canonicalUserCount: number;
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
  const [streamError, setStreamError] = useState("");
  const attachmentAdapter = useMemo(() => new UnifiedAttachmentAdapter(), []);
  const query = useQuery({
    queryKey: threadId ? teacherChatKeys.thread(threadId) : teacherChatKeys.all,
    queryFn: () => teacherChatApi.threadMessages(threadId!),
    enabled: Boolean(threadId),
    retry: 1,
    refetchInterval: (state) => state.state.data?.status === "running" ? 1500 : 5000,
  });
  useEffect(() => {
    if (!threadId) return;
    setStreamError("");
    const events = new EventSource(`/api/content/teacher-chat/threads/${encodeURIComponent(threadId)}/events`);
    events.addEventListener("thread.snapshot", (event) => {
      const snapshot = JSON.parse((event as MessageEvent).data) as TeacherChatThreadDetail;
      if (snapshot.thread_id !== threadId || !Array.isArray(snapshot.messages)) return;
      queryClient.setQueryData(teacherChatKeys.thread(threadId), snapshot);
      if (snapshot.status !== "running") {
        void queryClient.invalidateQueries({ queryKey: ["teacher-chat", "parse", threadId] });
        void queryClient.invalidateQueries({ queryKey: ["teacher", "library"] });
      }
    });
    events.addEventListener("thread.error", () => setStreamError("执行发生错误，请查看消息或重试。"));
    events.onopen = () => setStreamError("");
    // Browser reconnect + periodic snapshots recover without cancelling the server task.
    return () => events.close();
  }, [queryClient, threadId]);

  const canonical = useMemo(
    () => teacherTranscript(query.data?.messages ?? [], threadId ?? "thread", query.data?.status === "running"),
    [query.data?.messages, query.data?.status, threadId],
  );

  const parseQuery = useQuery({
    queryKey: threadId ? ["teacher-chat", "parse", threadId] : ["teacher-chat", "parse", "none"],
    queryFn: () => teacherChatApi.parseStatus(threadId!),
    enabled: Boolean(threadId),
    retry: 1,
    refetchInterval: (state) => {
      const stage = (state.state.data as TeacherParseStatus | undefined)?.stage;
      return stage === "done" ? 10000 : 3000;
    },
  });
  const parseStage = threadId ? parseQuery.data?.stage ?? "none" : "none";
  const stageMessage = ({ parsing: "正在解析抽取", reviewing: "等待教师审核，批准后继续", er: parseQuery.data?.er_candidate?.status === "pending_review" ? "ER 已生成，等待教师审核" : "正在生成错因与诊断规则", done: "私有题库包已就绪" } as Record<string, string>)[parseStage];

  const messages = useMemo(() => {
    const base = [...canonical];
    const last = base.at(-1);
    if (last?.role === "assistant" && last.status.type !== "running" && stageMessage) {
      const content = [...last.content, { type: "data" as const, name: "mathpilot-operation-status", data: { title: "题库进度", message: stageMessage, status: parseStage } }];
      const er = parseQuery.data?.er_candidate;
      if (er && !base.some(message => message.content.some(part => part.type === "data" && part.name === "mathpilot-teacher-review" && (part.data as { candidateSetId?: string })?.candidateSetId === er.candidate_set_id))) {
        content.push({ type: "data", name: "mathpilot-teacher-review", data: { candidateSetId: er.candidate_set_id } });
      }
      base[base.length - 1] = { ...last, content };
    }
    if (!pending || (pending.threadId && pending.threadId !== threadId)) return base;
    if (canonical.filter((message) => message.role === "user").length > pending.canonicalUserCount) return base;
    return [...base, pending.message];
  }, [canonical, pending, threadId, stageMessage, parseStage, parseQuery.data?.er_candidate]);

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
    setStreamError("");
    setPending({ key, threadId, message: optimistic, canonicalUserCount: canonical.filter((item) => item.role === "user").length });
    try {
      let targetThreadId = threadId;
      if (!targetThreadId) {
        const created = await teacherChatApi.createThread();
        targetThreadId = created.thread_id;
        setPending((current) => current?.key === key ? { ...current, threadId: targetThreadId } : current);
        navigate(`/c/${encodeURIComponent(targetThreadId)}`, { replace: true });
      }
      await teacherChatApi.sendMessage(targetThreadId, text, attachmentParts);
      await queryClient.invalidateQueries({ queryKey: teacherChatKeys.thread(targetThreadId) });
      setPending((current) => current?.key === key ? null : current);
      await queryClient.invalidateQueries({ queryKey: teacherChatKeys.threads });
    } catch (error) {
      setPending((current) => current?.key === key ? null : current);
      throw error;
    }
  }, [canonical, navigate, queryClient, threadId]);

  const runtime = useExternalStoreRuntime({
    messages,
    isLoading: Boolean(threadId) && query.isPending && messages.length === 0,
    isRunning: Boolean(pending) || query.data?.status === "running",
    isDisabled: false,
    isSendDisabled: Boolean(pending) || query.data?.status === "running" || (Boolean(threadId) && !query.data),
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
      {(streamError || parseQuery.data?.last_error) && <div role="alert" className="border-destructive/30 bg-background mx-4 mt-12 rounded-xl border p-3 text-sm">{streamError || parseQuery.data?.last_error}</div>}
      <AssistantRuntimeProvider runtime={runtime}>
        {children}
      </AssistantRuntimeProvider>
    </>
  );
}
