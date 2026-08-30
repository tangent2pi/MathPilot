"use client";

import { AssistantRuntimeProvider, AuiConfig, Tools, useAui, useLocalRuntime, type ChatModelAdapter } from "@assistant-ui/react";
import { createPiHttpClient, usePiRuntime } from "@assistant-ui/react-pi";
import { Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { UnifiedAttachmentAdapter } from "./AttachmentAdapter";
import { AUTH_DRAFT_KEY, useAuth } from "./auth";
import { learningToolkit } from "@/components/assistant-ui/learning-toolkit";

/**
 * 把浏览器 PiClient（HTTP/SSE over /api/pi）接入 Pi runtime。
 * 附件走 UnifiedAttachmentAdapter：图片（Pi 视觉 + 落盘 input/original/）
 * 与文件（落盘 + 前端展示）统一处理；Pi 扩展只为对应回合注入隐藏文件上下文。
 */
export function PiRuntimeProvider({ children }: { children: ReactNode }) {
  const { principal, loading } = useAuth();
  // Better Auth may refetch the session when this tab regains focus. Keep the
  // established runtime mounted during that background refresh; otherwise the
  // whole conversation visibly reloads every time the user returns to the tab.
  if (loading && !principal) return (
    <div className="grid h-dvh place-items-center" role="status" aria-live="polite">
      <Loader2Icon className="text-muted-foreground size-6 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      <span className="sr-only">正在读取账户</span>
    </div>
  );
  return principal
    ? <AuthenticatedPiRuntimeProvider>{children}</AuthenticatedPiRuntimeProvider>
    : <GuestRuntimeProvider>{children}</GuestRuntimeProvider>;
}

function AuthenticatedPiRuntimeProvider({ children }: { children: ReactNode }) {
  const [threadId, setThreadId] = useState(readThreadIdFromLocation);
  const attachmentAdapter = useMemo(() => new UnifiedAttachmentAdapter(), []);
  const client = useMemo(() => {
    const base = createPiHttpClient();
    return {
      ...base,
      async sendMessage(
        threadId: Parameters<typeof base.sendMessage>[0],
        input: Parameters<typeof base.sendMessage>[1],
      ) {
        const attachments = await attachmentAdapter.flushToThread(threadId);
        const requestInput = attachments.length > 0
          ? { ...input, mathpilotAttachmentIds: attachments.map((attachment) => attachment.id) }
          : input;
        return base.sendMessage(threadId, requestInput);
      },
    };
  }, [attachmentAdapter]);
  const adapters = useMemo(() => ({ attachments: attachmentAdapter }), [attachmentAdapter]);
  const handleThreadIdChange = useCallback((nextThreadId: string | undefined) => {
    setThreadId(nextThreadId);
    const nextUrl = threadUrl(nextThreadId);
    if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== nextUrl) {
      window.history.pushState({ mathpilotThreadId: nextThreadId ?? null }, "", nextUrl);
    }
  }, []);
  const runtime = usePiRuntime({
    client,
    adapters,
    threadId,
    onThreadIdChange: handleThreadIdChange,
  });
  const config = AuiConfig({ tools: Tools({ toolkit: learningToolkit }) });

  useEffect(() => {
    const restoreFromHistory = () => setThreadId(readThreadIdFromLocation());
    window.addEventListener("popstate", restoreFromHistory);
    return () => window.removeEventListener("popstate", restoreFromHistory);
  }, []);

  return (
    <AssistantRuntimeProvider runtime={runtime} config={config}>
      <PendingDraftRestorer />
      {children}
    </AssistantRuntimeProvider>
  );
}

const THREAD_PATH = /^\/c\/([^/]+)\/?$/;

function readThreadIdFromLocation(): string | undefined {
  const match = THREAD_PATH.exec(window.location.pathname);
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

function threadUrl(threadId: string | undefined): string {
  return threadId ? `/c/${encodeURIComponent(threadId)}` : "/";
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
