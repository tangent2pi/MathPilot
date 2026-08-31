import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { agentAttemptId, type RuntimeStore } from "./runtime-store.ts";
import type { QuestionStore } from "./question-store.ts";
import type { SelectionStore } from "./selection-store.ts";
import { getTaskSpec } from "./task-registry.ts";
import type { LearningNextActivities, PiTaskExecutor } from "./runtime-types.ts";

export interface ActivityDependencies {
  store: RuntimeStore;
  questionStore: QuestionStore;
  selectionStore: SelectionStore;
  executor: PiTaskExecutor;
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function createActivities({ store, questionStore, selectionStore, executor }: ActivityDependencies): LearningNextActivities {
  return {
    async executePiTask(input) {
      const context = Context.current();
      const taskSpec = getTaskSpec(input.taskType, input.taskSpecVersion);
      const cached = await store.findOperationResult(input);
      if (cached) return cached;

      const workflowRunId = context.info.workflowExecution?.runId;
      if (!workflowRunId) throw new Error("Temporal Activity is missing its Workflow run identity");
      const attemptId = agentAttemptId(input.workflowId, workflowRunId, context.info.activityId, context.info.attempt);
      const start = {
        agentAttemptId: attemptId,
        input,
        taskSpec,
        workflowRunId,
        temporalActivityId: context.info.activityId,
        temporalAttempt: context.info.attempt,
      };
      await store.startAttempt(start);
      context.heartbeat({ stage: "input", attemptId });
      try {
        const inputBundle = await store.loadInputBundle(input, taskSpec);
        const result = await executor.execute({
          agentAttemptId: attemptId,
          tenantId: input.tenantId,
          operationId: input.operationId,
          workflowId: input.workflowId,
          inputRef: input.inputRef,
          inputBundle,
          taskSpec,
          ...(input.taskType === "select_question" ? {
            questionCatalog: {
              search: (toolCallId, params) => selectionStore.searchCatalog({
                tenantId: input.tenantId,
                operationId: input.operationId,
                agentAttemptId: attemptId,
                toolCallId,
                ...params,
              }),
            },
          } : {}),
          signal: context.cancellationSignal,
          heartbeat: (detail) => context.heartbeat(detail ?? { stage: "model", attemptId }),
        });
        const outputRef = await store.storeStructuredOutput(start, result.output, taskSpec.output_schema);
        await store.completeAttempt(attemptId, input.tenantId, {
          outputRef,
          resolvedModelId: result.resolvedModelId,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        });
        context.heartbeat({ stage: "complete", attemptId, outputRef });
        return { outputRef, resolvedModelId: result.resolvedModelId, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
      } catch (error) {
        const cancelled = context.cancellationSignal.aborted;
        await store.failAttempt(attemptId, input.tenantId, {
          code: cancelled ? "cancelled" : error instanceof ApplicationFailure ? error.type ?? "application_failure" : "pi_task_failed",
          detail: errorText(error),
          cancelled,
        }).catch(() => undefined);
        throw error;
      }
    },

    commitOperationResult: (input) => store.commitOperationResult(input),
    markOperationFailed: (input) => store.markOperationFailed(input),
    enqueueScheduledDream: (input) => store.enqueueScheduledDream(input),
    prepareQuestionFinalization: (input) => questionStore.prepareFinalization(input),
    recordFinalJudgment: (input) => questionStore.recordFinalJudgment(input),
    recordUnresolvedJudgment: (input) => questionStore.recordUnresolvedJudgment(input),
    commitQuestionClosure: (input) => questionStore.commitClosure(input),
    replayScientificCorrection: (input) => questionStore.replayCorrection(input),
    commitSelectionDecision: (input) => selectionStore.commitDecision(input),
    markSelectionSuperseded: (input) => selectionStore.markSuperseded(input),
  };
}
