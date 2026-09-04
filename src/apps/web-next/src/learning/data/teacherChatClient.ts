// 教师对话 API：经 api-next -> content-next -> pi-chat-runtime 中继的教师独立
// 会话（PiThreadStore 归属教师 owner_user_id，与学生学习证据完全隔离）。
// 消息即 Pi 官方 transcript 快照（user content 为字符串或分块，assistant
// content 为分块数组），本客户端只按文本消费，不依赖任何学习领域 UI 契约。

export type TeacherChatMessage = {
  role: string;
  content: unknown;
  timestamp?: number;
};

export type TeacherChatThreadSummary = {
  thread_id: string;
  created_at: string;
  archived_at?: string | null;
};

export type TeacherChatThreadDetail = {
  thread_id: string;
  messages: TeacherChatMessage[];
};

export type TeacherChatCreateReceipt = {
  thread_id: string;
  created: boolean;
  messages: TeacherChatMessage[];
};

export type TeacherChatSendReceipt = {
  thread_id: string;
  messages: TeacherChatMessage[];
};

export class TeacherChatApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export const teacherChatKeys = {
  all: ["teacher-chat"] as const,
  threads: ["teacher-chat", "threads"] as const,
  thread: (threadId: string) => ["teacher-chat", "thread", threadId] as const,
};

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body = await response.json().catch(() => ({})) as T & { error?: string; detail?: string };
  if (!response.ok) {
    throw new TeacherChatApiError(
      body.detail || body.error || `请求失败（${response.status}）`,
      response.status,
    );
  }
  return body;
}

export type TeacherChatAttachmentPart = {
  attachment_ref: string;
  name?: string;
  mime_type?: string;
};

export type TeacherParseStatus = {
  stage: "none" | "parsing" | "reviewing" | "er" | "done";
  command_status?: string | null;
  last_error?: string | null;
  package?: { package_id?: string; status?: string } | null;
};

export const teacherChatApi = {
  listThreads: () => requestJson<TeacherChatThreadSummary[]>("/api/content/teacher-chat/threads"),

  createThread: (threadId?: string) =>
    requestJson<TeacherChatCreateReceipt>("/api/content/teacher-chat/threads", {
      method: "POST",
      body: JSON.stringify(threadId ? { thread_id: threadId } : {}),
    }),

  sendMessage: (threadId: string, content: string, attachments: TeacherChatAttachmentPart[] = []) =>
    requestJson<TeacherChatSendReceipt>(
      `/api/content/teacher-chat/threads/${encodeURIComponent(threadId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ content, ...(attachments.length ? { attachments } : {}) }),
      },
    ),

  threadMessages: (threadId: string) =>
    requestJson<TeacherChatThreadDetail>(
      `/api/content/teacher-chat/threads/${encodeURIComponent(threadId)}`,
    ),

  parseStatus: (threadId: string) =>
    requestJson<TeacherParseStatus>(
      `/api/content/teacher-chat/threads/${encodeURIComponent(threadId)}/parse`,
    ),
};

/** 从 Pi transcript 消息中提取可渲染文本（assistant 分块 / user 字符串）。 */
export function teacherChatText(message: TeacherChatMessage): string {
  if (message.role !== "user" && message.role !== "assistant") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const value = part as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string" ? value.text : "";
    })
    .join("");
}
