import type {
  CanonicalMessage,
  CanonicalMessagePart,
  CommandCapability,
  DomainUIPart,
  LearningView,
} from "@mathpilot/contracts";

export type {
  CanonicalMessage,
  CanonicalMessagePart,
  CommandCapability,
  DomainUIPart,
  LearningView,
};

export interface ThreadSummary {
  thread_id: string;
  title: string;
  status: "active" | "archived";
  version: number;
  created_at: string;
  updated_at: string;
  last_message_summary: string | null;
}

export interface ThreadOperation {
  operation_id: string;
  kind: string;
  status: "accepted" | "running" | "succeeded" | "needs_input" | "failed" | "cancelled";
  user_message: string;
  related_resource_refs: string[];
  retryable: boolean;
  started_at: string;
  updated_at: string;
  version: number;
}

export interface ThreadMessagesData {
  thread: { id: string; title: string; status: "active" | "archived"; version: number };
  messages: CanonicalMessage[];
  operations: ThreadOperation[];
  next_cursor: string;
  has_more: boolean;
}

export type ThreadListView = LearningView<{ threads: ThreadSummary[] }>;
export type ThreadMessagesView = LearningView<ThreadMessagesData>;

export interface CreateThreadReceipt {
  created: boolean;
  thread: {
    thread_id: string;
    title: string;
    status: "active" | "archived";
    version: number;
    created_at: string;
  };
}

export interface ForegroundReceipt {
  accepted: true;
  created: boolean;
  foreground_request_id: string;
  operation_id: string;
  message_id: string;
  foreground_epoch_id: string;
  thread_version: number;
}

export interface ProblemDetails {
  title?: string;
  status?: number;
  code?: string;
  current_version?: number;
  error?: string;
}
