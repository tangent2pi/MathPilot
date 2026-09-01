import type { UserSubmittedMessagePart } from "../contracts";
import { HttpProblemError } from "../../lib/http-problem";

export type MessageCommandEnvelope = {
  readonly signature: string;
  readonly key: string;
  readonly requestedAt: string;
  readonly originThreadId?: string;
  readonly threadId?: string;
  readonly expectedVersion?: number;
  readonly parts: readonly UserSubmittedMessagePart[];
};

type MessageCommandCandidate = {
  readonly threadId?: string;
  readonly expectedVersion?: number;
  readonly requestedAt: string;
  readonly parts: readonly UserSubmittedMessagePart[];
};

/**
 * Reuses the exact server command after an unconfirmed response. A changed
 * payload or a different route is a new user intent and receives a new key.
 */
export function acquireMessageCommandEnvelope(
  current: MessageCommandEnvelope | null,
  candidate: MessageCommandCandidate,
  createKey: () => string,
): MessageCommandEnvelope {
  const signature = JSON.stringify(candidate.parts);
  const sameRoute = current
    && (current.originThreadId === candidate.threadId || current.threadId === candidate.threadId);
  if (current && sameRoute && current.signature === signature) {
    if (
      current.threadId === candidate.threadId
      && current.expectedVersion === undefined
      && candidate.expectedVersion !== undefined
    ) {
      return { ...current, expectedVersion: candidate.expectedVersion };
    }
    return current;
  }
  return {
    signature,
    key: createKey(),
    requestedAt: candidate.requestedAt,
    originThreadId: candidate.threadId,
    threadId: candidate.threadId,
    expectedVersion: candidate.expectedVersion,
    parts: candidate.parts,
  };
}

export function bindMessageCommandThread(
  envelope: MessageCommandEnvelope,
  threadId: string,
  expectedVersion: number,
): MessageCommandEnvelope {
  return { ...envelope, threadId, expectedVersion };
}

/** Only an explicit application 4xx (except timeout) proves no command receipt exists. */
export function messageCommandOutcomeIsUnknown(error: unknown): boolean {
  return !(error instanceof HttpProblemError
    && error.status >= 400
    && error.status < 500
    && error.status !== 408);
}
