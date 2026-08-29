"use client";

import { AssistantRuntimeProvider, useAui, useLocalRuntime, type ChatModelAdapter } from "@assistant-ui/react";
import { createPiHttpClient, usePiRuntime } from "@assistant-ui/react-pi";
import { useEffect, useMemo, type ReactNode } from "react";
import { UnifiedAttachmentAdapter } from "./AttachmentAdapter";
import { AUTH_DRAFT_KEY, useAuth } from "./auth";

/**
 * 把浏览器 PiClient（HTTP/SSE over /api/pi）接入 Pi runtime。
 * 附件走 UnifiedAttachmentAdapter：图片（Pi 视觉 + 落盘 input/original/）
 * 与文件（落盘 + 前端展示）统一处理；Pi 扩展只为对应回合注入隐藏文件上下文。
 */
export function PiRuntimeProvider({ children }: { children: ReactNode }) {
  const { principal, loading } = useAuth();
  if (loading) return (
    <div className="grid h-dvh place-items-center" role="status" aria-live="polite">
      <div className="relative size-14">
        <img className="size-14 rounded-2xl" src="/mathpilot-icon.png" width="56" height="56" alt="" />
        <span className="border-primary/20 border-t-primary absolute -inset-2 animate-spin rounded-[1.35rem] border-2 motion-reduce:animate-none" aria-hidden="true" />
      </div>
      <span className="sr-only">正在读取账户</span>
    </div>
  );
  return principal
    ? <AuthenticatedPiRuntimeProvider>{children}</AuthenticatedPiRuntimeProvider>
    : <GuestRuntimeProvider>{children}</GuestRuntimeProvider>;
}

function AuthenticatedPiRuntimeProvider({ children }: { children: ReactNode }) {
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
  const runtime = usePiRuntime({ client, adapters });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <PendingDraftRestorer />
      {children}
    </AssistantRuntimeProvider>
  );
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
