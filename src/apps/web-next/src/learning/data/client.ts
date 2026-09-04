import type {
  CreateThreadReceipt,
  LearningView,
  ThreadListView,
  ThreadMessagesView,
  ThreadSummary,
} from "../contracts";
import { responseJson } from "../../lib/http-problem";

export const learningKeys = {
  all: ["learning"] as const,
  threads: ["learning", "threads"] as const,
  thread: (threadId: string) => ["learning", "thread", threadId] as const,
  view: (url: string) => ["learning", "view", url] as const,
};

export function newIdempotencyKey(scope: string): string {
  return `web-${scope}-${globalThis.crypto.randomUUID()}`;
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
  return responseJson<T>(response);
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
    if (!combined) throw new Error("对话记录为空");
    return combined;
  },

  createThread(key: string, title = "新对话", requestedAt = new Date().toISOString()) {
    return requestJson<CreateThreadReceipt>(
      "/api/learning/threads",
      commandInit(key, { expected_version: 0, requested_at: requestedAt, title }),
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
