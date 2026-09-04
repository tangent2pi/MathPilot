"use client";

import {
  AssistantRuntimeProvider,
  useAui,
  useLocalRuntime,
  type ChatModelAdapter,
} from "@assistant-ui/react";
import { usePiRuntime, usePiRuntimeExtras } from "@assistant-ui/react-pi";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { UnifiedAttachmentAdapter } from "@/AttachmentAdapter";
import { AUTH_DRAFT_KEY, useAuth } from "@/auth";
import { learningApi, learningKeys } from "../data/client";
import { createCanonicalPiClient } from "../data/pi-client";
import { canonicalMessageProjector } from "./canonical-message-projector";

/**
 * The browser uses the canonical `thr_*` ID as the controlled React Pi thread
 * ID. Pi's snapshot is deliberately the sole source for the in-pane transcript
 * while a conversation is open; canonical records refresh alongside it for
 * learning cards and history, rather than being appended a second time.
 */
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
  const attachmentAdapter = useMemo(() => new UnifiedAttachmentAdapter(), []);
  const canonicalThread = useQuery({
    queryKey: threadId ? learningKeys.thread(threadId) : ["learning", "thread", "new"],
    queryFn: () => learningApi.threadMessages(threadId!),
    enabled: Boolean(threadId),
    retry: 1,
  });
  const canonicalVersion = useRef<number | undefined>(undefined);
  canonicalVersion.current = canonicalThread.data?.data.thread.version;
  const piRunningRef = useRef(false);
  const [piRunning, setPiRunning] = useState(false);
  const [recoveryGeneration, setRecoveryGeneration] = useState(0);
  const handlePiRunningChange = useCallback((running: boolean) => {
    piRunningRef.current = running;
    setPiRunning(running);
  }, []);
  const client = useMemo(
    () => createCanonicalPiClient({
      attachmentAdapter,
      expectedVersion: () => canonicalVersion.current,
      isThreadRunning: () => piRunningRef.current,
    }),
    [attachmentAdapter],
  );
  const handleThreadIdChange = useCallback((nextThreadId: string | undefined) => {
    if (!nextThreadId) return;
    // The Pi gateway guarantees this is the canonical id returned by
    // `learningApi.createThread`, never its internal session id.
    navigate(`/c/${encodeURIComponent(nextThreadId)}`, { replace: true });
  }, [navigate]);
  const handlePiError = useCallback(() => {
    setRecoveryGeneration((generation) => generation + 1);
  }, []);
  const runtime = usePiRuntime({
    client,
    threadId,
    onThreadIdChange: handleThreadIdChange,
    onError: handlePiError,
    adapters: { attachments: attachmentAdapter },
    customMessageProjector: canonicalMessageProjector,
    isDisabled: canonicalThread.data?.data.thread.status === "archived",
    // The canonical host admits one Interactive Epoch at a time. Do not expose
    // react-pi's native follow-up queue until the host has a matching admission
    // protocol; Cancel remains available through the running thread state.
    isSendDisabled: Boolean(threadId && !canonicalThread.data) || piRunning,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <PiRunSendLock onRunningChange={handlePiRunningChange} />
      <CanonicalProjectionRefresh threadId={threadId} recoveryGeneration={recoveryGeneration} />
      <PendingDraftRestorer />
      {children}
    </AssistantRuntimeProvider>
  );
}

function PiRunSendLock({ onRunningChange }: { onRunningChange: (running: boolean) => void }) {
  const { status } = usePiRuntimeExtras();
  useEffect(() => {
    onRunningChange(status === "running");
  }, [onRunningChange, status]);
  useEffect(() => () => onRunningChange(false), [onRunningChange]);
  return null;
}

/**
 * The Pi endpoint owns token/reasoning/tool deltas and reconnection. This
 * synchronizer only refreshes the immutable canonical read models after a
 * terminal Pi state or a domain event; it never reconstructs stream chunks.
 */
function CanonicalProjectionRefresh({
  threadId,
  recoveryGeneration,
}: {
  threadId?: string;
  recoveryGeneration: number;
}) {
  const queryClient = useQueryClient();
  const { status, refresh: refreshPiSnapshot } = usePiRuntimeExtras();
  const wasRunning = useRef(false);
  const refreshPiSnapshotRef = useRef(refreshPiSnapshot);
  refreshPiSnapshotRef.current = refreshPiSnapshot;
  const refreshCanonicalProjection = useCallback(async () => {
    if (!threadId) return;
    await Promise.allSettled([
      queryClient.invalidateQueries({ queryKey: learningKeys.thread(threadId) }),
      queryClient.invalidateQueries({ queryKey: learningKeys.threads }),
    ]);
    // The official client fetches a fresh Pi snapshot and then resumes its own
    // seq/SSE processing.  Canonical custom/link messages are projected in
    // react-pi's package boundary, not merged into this application store.
    await refreshPiSnapshotRef.current();
  }, [queryClient, threadId]);

  useEffect(() => {
    if (!threadId) return;
    if (status === "running") {
      wasRunning.current = true;
      return;
    }
    if (!wasRunning.current) return;
    wasRunning.current = false;
    void refreshCanonicalProjection();
  }, [refreshCanonicalProjection, status, threadId]);

  useEffect(() => {
    if (!threadId || recoveryGeneration === 0) return;
    void refreshCanonicalProjection();
  }, [recoveryGeneration, refreshCanonicalProjection, threadId]);

  useEffect(() => {
    if (!threadId) return;
    const events = new EventSource("/api/learning/events");
    const refresh = () => {
      void refreshCanonicalProjection();
    };
    for (const type of [
      "canonical_message.appended",
      "canonical_message.updated",
      "learning_resource.changed",
      "learning_operation.changed",
    ]) events.addEventListener(type, refresh);
    return () => events.close();
  }, [refreshCanonicalProjection, threadId]);

  return null;
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
