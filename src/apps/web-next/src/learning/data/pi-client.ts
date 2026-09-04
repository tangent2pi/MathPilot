import {
  createPiHttpClient,
  type PiClient,
  type PiHttpClientOptions,
  type PiSendMessageInput,
  type PiThreadSnapshot,
} from "@assistant-ui/react-pi";
import { type PiTurnAttachment, UnifiedAttachmentAdapter } from "@/AttachmentAdapter";
import { HttpProblemError, responseProblem } from "@/lib/http-problem";
import { learningApi, newIdempotencyKey } from "./client";

/**
 * Extension fields understood only by MathPilot's `/api/pi` gateway. The
 * standard react-pi wire fields retain their official shape; the gateway
 * resolves each immutable object descriptor into the session workspace before
 * Pi starts the turn.
 */
export type CanonicalPiSendInput = PiSendMessageInput & {
  mathpilotAttachments?: readonly PiTurnAttachment[];
};

type CanonicalPiMessageCommand = {
  idempotency_key: string;
  expected_version: number;
  requested_at: string;
  input: CanonicalPiSendInput;
};

type NewThreadAttempt = {
  readonly commandKey: string;
  readonly requestedAt: string;
  readonly title: string;
  canonicalThreadId?: string;
  expectedVersion?: number;
  pending?: Promise<PiThreadSnapshot>;
};

type SendAttempt = {
  readonly inputFingerprint: string;
  readonly fullFingerprint: string;
  readonly key: string;
  readonly requestedAt: string;
  readonly expectedVersion: number;
  pending?: Promise<void>;
};

type CanonicalThreadCreator = (
  key: string,
  title: string,
  requestedAt: string,
) => Promise<{ thread: { thread_id: string; version: number } }>;

export type CanonicalPiClientOptions = {
  attachmentAdapter: UnifiedAttachmentAdapter;
  /** Dependency injection keeps the canonical/Pi boundary testable. */
  baseClient?: PiClient;
  http?: PiHttpClientOptions;
  createCanonicalThread?: CanonicalThreadCreator;
  provision?: (threadId: string) => Promise<void>;
  expectedVersion?: (threadId: string) => number | undefined;
  /** MathPilot permits exactly one active canonical interactive epoch. */
  isThreadRunning?: (threadId: string) => boolean;
  newKey?: (scope: string) => string;
};

/**
 * React Pi speaks only canonical `thr_*` identifiers in the browser. The
 * backend provisions the matching private Pi session, so React Pi never owns
 * an independent user-visible thread list or identifier namespace.
 */
export function createCanonicalPiClient({
  attachmentAdapter,
  baseClient,
  http,
  createCanonicalThread = learningApi.createThread,
  provision = provisionCanonicalPiThread,
  expectedVersion,
  isThreadRunning,
  newKey = newIdempotencyKey,
}: CanonicalPiClientOptions): PiClient {
  // `baseClient` is injectable for focused unit tests. When it is omitted we
  // still construct the official client with its snapshot/seq SSE machinery.
  const client = baseClient ?? createPiHttpClient(http);
  let newThread: NewThreadAttempt | undefined;
  const nextVersionByThread = new Map<string, number>();
  const unresolvedSends = new Map<string, SendAttempt>();

  const sendMessage = async (
    threadId: string,
    input: PiSendMessageInput,
  ): Promise<void> => {
    if (isThreadRunning?.(threadId)) {
      throw new Error("当前回复尚未结束，请先停止或等待完成");
    }
    const inputFingerprint = JSON.stringify(input);
    const existing = unresolvedSends.get(threadId);
    if (existing?.pending && existing.inputFingerprint === inputFingerprint) {
      return existing.pending;
    }

    const attachments = attachmentAdapter.claimForPiTurn();
    const fullFingerprint = JSON.stringify({ input, attachments });
    if (existing && existing.fullFingerprint !== fullFingerprint) {
      attachmentAdapter.restorePiTurn(attachments);
      throw new Error("上一条消息的提交结果尚未确认；请先重试该消息");
    }
    const queryVersion = expectedVersion?.(threadId);
    const localVersion = nextVersionByThread.get(threadId);
    // A command receipt advances the canonical version before React Query can
    // refetch. Preserve that local receipt across an immediately following
    // send, while accepting a newer canonical read after invalidation.
    const observedVersion = queryVersion !== undefined && (localVersion === undefined || queryVersion > localVersion)
      ? queryVersion
      : localVersion;
    if (observedVersion !== undefined) nextVersionByThread.set(threadId, observedVersion);
    const resolvedExpectedVersion = existing?.expectedVersion ?? observedVersion;
    if (resolvedExpectedVersion === undefined) {
      attachmentAdapter.restorePiTurn(attachments);
      throw new Error("对话版本尚未读取完成，请稍后重试");
    }
    const attempt = existing ?? {
      inputFingerprint,
      fullFingerprint,
      key: newKey("pi-message"),
      requestedAt: new Date().toISOString(),
      expectedVersion: resolvedExpectedVersion,
    } satisfies SendAttempt;
    const pending = sendCanonicalPiMessage({
      threadId,
      key: attempt.key,
      expectedVersion: attempt.expectedVersion,
      requestedAt: attempt.requestedAt,
      // Pi-native image bytes stay in the optimistic assistant-ui attachment
      // model. The canonical gateway receives only immutable object descriptors
      // and materializes verified Pi image content server-side.
      input: gatewayInput(input, attachments),
    }).then((receipt) => {
      attachmentAdapter.markPiTurnAccepted(attachments);
      if (receipt.threadVersion !== undefined) {
        const currentVersion = nextVersionByThread.get(threadId);
        if (currentVersion === undefined || receipt.threadVersion > currentVersion) {
          nextVersionByThread.set(threadId, receipt.threadVersion);
        }
      }
      unresolvedSends.delete(threadId);
    }).catch((error: unknown) => {
      if (terminalInteractiveAttempt(error)) {
        // The canonical command was already admitted and settled. Its object
        // claims are durable, so do not restore them for a duplicate retry.
        attachmentAdapter.markPiTurnAccepted(attachments);
      } else {
        attachmentAdapter.restorePiTurn(attachments);
      }
      if (!messageOutcomeIsUnknown(error)) unresolvedSends.delete(threadId);
      throw error;
    });
    attempt.pending = pending;
    unresolvedSends.set(threadId, attempt);
    try {
      await pending;
    } finally {
      if (attempt.pending === pending) attempt.pending = undefined;
    }
  };

  const createThread = async (input?: {
    workspacePath?: string;
    title?: string;
    initialMessage?: PiSendMessageInput;
  }): Promise<PiThreadSnapshot> => {
    if (!newThread) {
      const commandKey = newKey("pi-thread");
      newThread = {
        commandKey,
        requestedAt: new Date().toISOString(),
        title: input?.title?.trim() || "新对话",
      };
    }
    if (newThread.pending) return newThread.pending;

    const activeAttempt = newThread;
    const pending = (async () => {
      if (!activeAttempt.canonicalThreadId) {
        const created = await createCanonicalThread(
          activeAttempt.commandKey,
          activeAttempt.title,
          activeAttempt.requestedAt,
        );
        activeAttempt.canonicalThreadId = created.thread.thread_id;
        activeAttempt.expectedVersion = created.thread.version;
        nextVersionByThread.set(created.thread.thread_id, created.thread.version);
      }
      const threadId = activeAttempt.canonicalThreadId;
      if (!threadId) throw new Error("规范对话标识未建立");
      await provision(threadId);
      if (input?.initialMessage) {
        await sendMessage(threadId, input.initialMessage);
      }
      return client.getThread(threadId);
    })();
    activeAttempt.pending = pending;
    try {
      return await pending;
    } catch (error) {
      // Preserve the canonical creation command across a transport retry. Once
      // the runtime has a snapshot it switches to the controlled route.
      if (activeAttempt.pending === pending) activeAttempt.pending = undefined;
      throw error;
    }
  };

  return { ...client, createThread, sendMessage };
}

const gatewayInput = (
  input: PiSendMessageInput,
  attachments: readonly PiTurnAttachment[],
): CanonicalPiSendInput => ({
  content: input.content,
  ...(input.streamingBehavior === undefined
    ? {}
    : { streamingBehavior: input.streamingBehavior }),
  ...(attachments.length === 0 ? {} : { mathpilotAttachments: attachments }),
});

/**
 * Dedicated provisioning endpoint. It is deliberately outside react-pi's
 * generic client contract: provisioning a canonical learning thread is a
 * product concern, while all streaming/cancel/reconnect traffic remains the
 * official `/api/pi/threads/:threadId/*` protocol.
 */
export async function provisionCanonicalPiThread(threadId: string): Promise<void> {
  const response = await fetch(
    `/api/pi/threads/${encodeURIComponent(threadId)}/provision`,
    {
      method: "PUT",
      credentials: "include",
    },
  );
  if (!response.ok) throw await responseProblem(response, "Pi 会话初始化失败");
  await response.body?.cancel().catch(() => undefined);
}

async function sendCanonicalPiMessage(input: {
  threadId: string;
  key: string;
  expectedVersion: number;
  requestedAt: string;
  input: CanonicalPiSendInput;
}): Promise<{ threadVersion?: number }> {
  const command: CanonicalPiMessageCommand = {
    idempotency_key: input.key,
    expected_version: input.expectedVersion,
    requested_at: input.requestedAt,
    input: input.input,
  };
  const response = await fetch(
    `/api/pi/threads/${encodeURIComponent(input.threadId)}/messages`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        "idempotency-key": input.key,
      },
      body: JSON.stringify(command),
    },
  );
  if (!response.ok) throw await responseProblem(response, "消息提交失败");
  if (response.status === 204 || response.status === 205 || response.headers.get("content-length") === "0") {
    return {};
  }
  const body: unknown = await response.json();
  const threadVersion = body && typeof body === "object" && !Array.isArray(body)
    && typeof (body as { thread_version?: unknown }).thread_version === "number"
    ? (body as { thread_version: number }).thread_version
    : undefined;
  return threadVersion === undefined ? {} : { threadVersion };
}

function messageOutcomeIsUnknown(error: unknown): boolean {
  return !(error instanceof HttpProblemError
    && error.status >= 400
    && error.status < 500
    && error.status !== 408
    && error.status !== 429);
}

function terminalInteractiveAttempt(error: unknown): boolean {
  return error instanceof HttpProblemError
    && error.status === 409
    && (error.code === "interactive_attempt_succeeded"
      || error.code === "interactive_attempt_failed"
      || error.code === "interactive_attempt_cancelled");
}
