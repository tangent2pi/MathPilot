import type { InternalServiceRuntime } from "@mathpilot/internal-service";
import type { CandidateRepository } from "./candidate-repository.ts";

const hostCommandTimeoutMs = 10 * 60 * 1000;

type DispatchLog = {
  error: (data: unknown, message: string) => void;
  info?: (data: unknown, message: string) => void;
  warn?: (data: unknown, message: string) => void;
};

export type ErCommandRepository = Pick<
  CandidateRepository,
  "pendingCommands" | "markCommandAttempt" | "markCommandDispatched"
>;

export type FeedbackCommandRepository = Pick<
  CandidateRepository,
  "pendingFeedbackCommands" | "markFeedbackAttempt" | "markFeedbackDispatched"
>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function dispatchErCommands(
  repository: ErCommandRepository,
  runtime: InternalServiceRuntime,
  log: DispatchLog,
  signal?: AbortSignal,
): Promise<void> {
  const commands = await repository.pendingCommands().catch((error) => {
    log.error({ err: error }, "ER handoff polling failed");
    return [];
  });
  for (const command of commands) {
    if (signal?.aborted) return;
    try {
      const response = await runtime.request(
        "content-to-pi",
        { tenantId: command.tenant_id, userId: command.owner_user_id, roles: ["teacher"] },
        "/internal/er-start",
        {
          method: "POST",
          json: {
            command_id: command.command_id,
            candidate_set_id: command.approved_ktq_candidate_set_id,
            target_thread_id: command.target_thread_id,
          },
          timeoutMs: hostCommandTimeoutMs,
          ...(signal ? { signal } : {}),
        },
      );
      if (!response.ok) throw new Error(`Pi runtime returned ${response.status}: ${await response.text()}`);
      await repository.markCommandDispatched(command.command_id, command.tenant_id, command.owner_user_id);
    } catch (error) {
      if (signal?.aborted) return;
      await repository
        .markCommandAttempt(command.command_id, command.tenant_id, command.owner_user_id, errorMessage(error))
        .catch((cause) => log.error({ err: cause, commandId: command.command_id }, "ER handoff attempt update failed"));
    }
  }
}

export async function dispatchReviewFeedbackCommands(
  repository: FeedbackCommandRepository,
  runtime: InternalServiceRuntime,
  log: DispatchLog,
  signal?: AbortSignal,
): Promise<void> {
  const commands = await repository.pendingFeedbackCommands().catch((error) => {
    log.error({ err: error }, "review feedback polling failed");
    return [];
  });
  for (const command of commands) {
    if (signal?.aborted) return;
    try {
      const response = await runtime.request(
        "content-to-pi",
        { tenantId: command.tenant_id, userId: command.owner_user_id, roles: ["teacher"] },
        "/internal/review-feedback",
        {
          method: "POST",
          json: {
            command_id: command.command_id,
            candidate_set_id: command.candidate_set_id,
            target_thread_id: command.target_thread_id,
            phase: command.phase,
            annotations: command.annotations,
          },
          timeoutMs: hostCommandTimeoutMs,
          ...(signal ? { signal } : {}),
        },
      );
      if (!response.ok) throw new Error(`Pi runtime returned ${response.status}: ${await response.text()}`);
      await repository.markFeedbackDispatched(command.command_id, command.tenant_id, command.owner_user_id);
    } catch (error) {
      if (signal?.aborted) return;
      await repository
        .markFeedbackAttempt(command.command_id, command.tenant_id, command.owner_user_id, errorMessage(error))
        .catch((cause) => log.error({ err: cause, commandId: command.command_id }, "review feedback attempt update failed"));
    }
  }
}

export type KtqCommandRepository = Pick<
  CandidateRepository,
  "pendingKtqCommands" | "markKtqCommandAttempt" | "markKtqCommandDispatched"
>;

export async function dispatchKtqCommands(
  repository: KtqCommandRepository,
  runtime: InternalServiceRuntime,
  log: DispatchLog,
  signal?: AbortSignal,
): Promise<void> {
  const commands = await repository.pendingKtqCommands().catch((error) => {
    log.error({ err: error }, "KTQ start polling failed");
    return [];
  });
  for (const command of commands) {
    if (signal?.aborted) return;
    try {
      const response = await runtime.request(
        "content-to-pi",
        { tenantId: command.tenant_id, userId: command.owner_user_id, roles: ["teacher"] },
        "/internal/ktq-start",
        {
          method: "POST",
          json: {
            command_id: command.command_id,
            target_thread_id: command.target_thread_id,
            chapter_id: command.chapter_id,
          },
          timeoutMs: hostCommandTimeoutMs,
          ...(signal ? { signal } : {}),
        },
      );
      if (!response.ok) throw new Error(`Pi runtime returned ${response.status}: ${await response.text()}`);
      await repository.markKtqCommandDispatched(command.command_id, command.tenant_id, command.owner_user_id);
    } catch (error) {
      if (signal?.aborted) return;
      await repository
        .markKtqCommandAttempt(command.command_id, command.tenant_id, command.owner_user_id, errorMessage(error))
        .catch((cause) => log.error({ err: cause, commandId: command.command_id }, "KTQ start attempt update failed"));
    }
  }
}

export type AutoPrivateRepository = Pick<
  CandidateRepository,
  "pendingAutoPrivateCandidates" | "decide"
>;

/** 教师私有资料链：ktq-start/er-start 已派发线程的候选集自动批准并推进到包。 */
export async function dispatchAutoPrivateApprovals(
  repository: AutoPrivateRepository,
  log: DispatchLog,
  signal?: AbortSignal,
): Promise<void> {
  const candidates = await repository.pendingAutoPrivateCandidates().catch((error) => {
    log.error({ err: error }, "auto-private approval polling failed");
    return [];
  });
  for (const candidate of candidates) {
    if (signal?.aborted) return;
    try {
      await repository.decide(
        { tenantId: candidate.tenant_id, userId: candidate.owner_user_id, roles: ["teacher"] },
        candidate.candidate_set_id,
        "approved",
      );
      log.info?.({ candidateId: candidate.candidate_set_id, phase: candidate.phase }, "auto-approved private candidate");
    } catch (error) {
      log.warn?.({ err: error, candidateId: candidate.candidate_set_id }, "auto-private approval skipped");
    }
  }
}
