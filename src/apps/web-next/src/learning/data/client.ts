import type {
  CanonicalMessagePart,
  CreateThreadReceipt,
  ForegroundReceipt,
  LearningView,
  ProblemDetails,
  ThreadListView,
  ThreadMessagesView,
  ThreadSummary,
} from "../contracts";

export class LearningApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly currentVersion?: number,
  ) {
    super(message);
  }
}

export const learningKeys = {
  all: ["learning"] as const,
  threads: ["learning", "threads"] as const,
  thread: (threadId: string) => ["learning", "thread", threadId] as const,
  view: (url: string) => ["learning", "view", url] as const,
};

export function newIdempotencyKey(scope: string): string {
  const id = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `web-${scope}-${id}`;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => ({})) as ProblemDetails;
    throw new LearningApiError(
      problem.title || problem.error || `请求失败（${response.status}）`,
      response.status,
      problem.code,
      problem.current_version,
    );
  }
  return response.json() as Promise<T>;
}

function commandInit(key: string, body: Record<string, unknown>): RequestInit {
  return {
    method: "POST",
    headers: { "idempotency-key": key },
    body: JSON.stringify({ ...body, idempotency_key: key }),
  };
}

export const learningApi = {
  listThreads: () => requestJson<ThreadListView>("/api/learning/threads"),

  async threadMessages(threadId: string): Promise<ThreadMessagesView> {
    let after: string | undefined;
    let combined: ThreadMessagesView | undefined;
    for (let page = 0; page < 100; page += 1) {
      const suffix = after ? `?after=${encodeURIComponent(after)}` : "";
      const next = await requestJson<ThreadMessagesView>(
        `/api/learning/threads/${encodeURIComponent(threadId)}/messages${suffix}`,
      );
      combined = combined ? {
        ...next,
        data: {
          ...next.data,
          messages: [...combined.data.messages, ...next.data.messages],
        },
      } : next;
      if (!next.data.has_more) return combined;
      after = next.data.next_cursor;
    }
    if (!combined) throw new LearningApiError("对话记录为空", 500, "empty_thread_view");
    return combined;
  },

  createThread(key: string, title = "新对话") {
    return requestJson<CreateThreadReceipt>(
      "/api/learning/threads",
      commandInit(key, { expected_version: 0, requested_at: new Date().toISOString(), title }),
    );
  },

  sendMessage(input: {
    threadId: string;
    key: string;
    expectedVersion: number;
    parts: CanonicalMessagePart[];
    requestedAt: string;
  }) {
    return requestJson<ForegroundReceipt>(
      `/api/learning/threads/${encodeURIComponent(input.threadId)}/messages`,
      commandInit(input.key, {
        schema_version: 3,
        command_type: "send_message",
        expected_version: input.expectedVersion,
        requested_at: input.requestedAt,
        parts: input.parts,
      }),
    );
  },

  renameThread(thread: ThreadSummary, title: string, key = newIdempotencyKey("rename")) {
    return requestJson<ThreadSummary>(
      `/api/learning/threads/${encodeURIComponent(thread.thread_id)}/rename`,
      commandInit(key, { expected_version: thread.version, requested_at: new Date().toISOString(), title }),
    );
  },

  archiveThread(thread: ThreadSummary, key = newIdempotencyKey("archive")) {
    return requestJson<ThreadSummary>(
      `/api/learning/threads/${encodeURIComponent(thread.thread_id)}/archive`,
      commandInit(key, { expected_version: thread.version, requested_at: new Date().toISOString() }),
    );
  },

  cancelOperation(operationId: string, version: number, key = newIdempotencyKey("cancel")) {
    return requestJson<{ operation_id: string; status: string; version: number }>(
      `/api/learning/operations/${encodeURIComponent(operationId)}/cancel`,
      commandInit(key, { expected_version: version, requested_at: new Date().toISOString() }),
    );
  },

  view<T extends object = Record<string, unknown>>(url: string) {
    return requestJson<LearningView<T>>(url);
  },

  command<T>(url: string, expectedVersion: number, body: Record<string, unknown>, scope: string) {
    const key = newIdempotencyKey(scope);
    return requestJson<T>(url, commandInit(key, {
      expected_version: expectedVersion,
      requested_at: new Date().toISOString(),
      ...body,
    }));
  },
};
