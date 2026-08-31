import {
  ActivityCancellationType,
  ApplicationFailure,
  CancellationScope,
  ParentClosePolicy,
  continueAsNew,
  defineQuery,
  defineSignal,
  defineUpdate,
  executeChild,
  isCancellation,
  scheduleActivity,
  setHandler,
  workflowInfo,
  type ActivityOptions,
} from "@temporalio/workflow";
import { assertAllowedChild, getTaskSpec } from "./task-registry.ts";
import type {
  AgentTaskWorkflowInput,
  AgentTaskWorkflowResult,
  AgentTaskWorkflowState,
  AllowedChildWorkflowInput,
  FinalizeQuestionWorkflowInput,
  LearningNextActivities,
  PiTaskActivityResult,
  QuestionClosureResult,
  ScientificReplayResult,
  ScientificReplayWorkflowInput,
  ScheduledDreamTickInput,
  TaskRevision,
  TaskType,
} from "./runtime-types.ts";

export const reviseTaskSignal = defineSignal<[TaskRevision]>("reviseTask");
export const reviseTaskUpdate = defineUpdate<AgentTaskWorkflowState, [TaskRevision]>("reviseTaskUpdate");
export const taskStateQuery = defineQuery<AgentTaskWorkflowState>("taskState");

const refPattern = /^[a-z][a-z0-9+.-]*:[^\s]+$/;
const idempotencyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,180}$/;

const snapshot = (state: AgentTaskWorkflowState): AgentTaskWorkflowState => ({ ...state });

const assertWorkflowInput = (input: AgentTaskWorkflowInput): void => {
  if (input.schemaVersion !== 3) throw ApplicationFailure.nonRetryable("unsupported workflow schema", "invalid_workflow_input");
  if (!refPattern.test(input.aggregateRef) || !refPattern.test(input.inputRef)) {
    throw ApplicationFailure.nonRetryable("workflow references are invalid", "invalid_workflow_input");
  }
  if (!idempotencyPattern.test(input.idempotencyKey)) {
    throw ApplicationFailure.nonRetryable("workflow idempotency key is invalid", "invalid_workflow_input");
  }
  if (!Number.isSafeInteger(input.aggregateVersion) || input.aggregateVersion < 1
    || !Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw ApplicationFailure.nonRetryable("workflow versions must be positive integers", "invalid_workflow_input");
  }
  if (input.resultOwnership !== undefined && input.resultOwnership !== "workflow" && input.resultOwnership !== "parent") {
    throw ApplicationFailure.nonRetryable("invalid result ownership", "invalid_workflow_input");
  }
  getTaskSpec(input.taskType, input.taskSpecVersion);
};

const assertRevision = (revision: TaskRevision): void => {
  if (!Number.isSafeInteger(revision.revision) || revision.revision < 1) throw new Error("revision must be a positive integer");
  if (!refPattern.test(revision.inputRef)) throw new Error("revision inputRef is invalid");
  if (!revision.reason.trim() || revision.reason.length > 500) throw new Error("revision reason must contain 1-500 characters");
};

const taskActivityOptions = (taskType: TaskType, taskSpecVersion: string, activityId: string): ActivityOptions => {
  const taskSpec = getTaskSpec(taskType, taskSpecVersion);
  return {
    activityId,
    startToCloseTimeout: `${taskSpec.timeout_policy.start_to_close_seconds}s`,
    heartbeatTimeout: `${taskSpec.timeout_policy.heartbeat_seconds}s`,
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: {
      maximumAttempts: taskSpec.retry_policy.maximum_attempts,
      initialInterval: `${taskSpec.retry_policy.initial_interval_seconds}s`,
      backoffCoefficient: taskSpec.retry_policy.backoff_coefficient,
      maximumInterval: `${taskSpec.retry_policy.maximum_interval_seconds}s`,
      nonRetryableErrorTypes: ["invalid_workflow_input", "task_policy_violation"],
    },
  };
};

const durableActivityOptions = (activityId: string): ActivityOptions => ({
  activityId,
  startToCloseTimeout: "1m",
  retry: {
    maximumAttempts: 10,
    initialInterval: "1s",
    backoffCoefficient: 2,
    maximumInterval: "30s",
  },
});

const questionCommitActivityOptions = (activityId: string): ActivityOptions => ({
  activityId,
  startToCloseTimeout: "2m",
  retry: {
    maximumAttempts: 10,
    initialInterval: "1s",
    backoffCoefficient: 2,
    maximumInterval: "30s",
  },
});

const idempotencyForRevision = (base: string, revision: number): string => `${base}:r${revision}`;

export async function agentTaskWorkflow(input: AgentTaskWorkflowInput): Promise<AgentTaskWorkflowResult> {
  assertWorkflowInput(input);
  const continueAfter = Math.min(Math.max(input.continueAsNewAfter ?? 32, 1), 256);
  const carriedAttempts = input.carriedAttempts ?? 0;
  const state: AgentTaskWorkflowState = {
    status: "running",
    taskType: input.taskType,
    revision: input.revision,
    inputRef: input.inputRef,
    attemptsCompleted: carriedAttempts,
  };
  let attemptsThisRun = 0;
  let activeScope: CancellationScope | undefined;

  const acceptRevision = (revision: TaskRevision): AgentTaskWorkflowState => {
    assertRevision(revision);
    if (state.status === "succeeded" || state.status === "failed" || state.status === "cancelled") return snapshot(state);
    if (revision.revision < state.revision) return snapshot(state);
    if (revision.revision === state.revision) {
      if (revision.inputRef !== state.inputRef) throw new Error("the current revision is already bound to a different inputRef");
      return snapshot(state);
    }
    state.revision = revision.revision;
    state.inputRef = revision.inputRef;
    state.status = "revising";
    activeScope?.cancel();
    return snapshot(state);
  };

  setHandler(taskStateQuery, () => snapshot(state));
  setHandler(reviseTaskSignal, (revision) => {
    try {
      acceptRevision(revision);
    } catch {
      // Signals cannot return validation errors. Invalid or conflicting signals
      // are ignored; callers that need acknowledgement use the Update below.
    }
  });
  setHandler(reviseTaskUpdate, acceptRevision, { validator: assertRevision });

  while (true) {
    if (attemptsThisRun >= continueAfter || workflowInfo().continueAsNewSuggested) {
      await continueAsNew<typeof agentTaskWorkflow>({
        ...input,
        revision: state.revision,
        inputRef: state.inputRef,
        carriedAttempts: state.attemptsCompleted,
      });
    }

    state.status = "running";
    const scheduledRevision = state.revision;
    const activityInput = {
      ...input,
      revision: scheduledRevision,
      inputRef: state.inputRef,
      idempotencyKey: idempotencyForRevision(input.idempotencyKey, scheduledRevision),
      workflowId: workflowInfo().workflowId,
    };
    activeScope = new CancellationScope();
    let result: PiTaskActivityResult;
    try {
      result = await activeScope.run(() => scheduleActivity<PiTaskActivityResult>(
        "executePiTask",
        [activityInput],
        taskActivityOptions(input.taskType, input.taskSpecVersion, `pi-r${scheduledRevision}-n${attemptsThisRun + 1}`),
      ));
      attemptsThisRun += 1;
      state.attemptsCompleted += 1;
    } catch (error) {
      attemptsThisRun += 1;
      state.attemptsCompleted += 1;
      activeScope = undefined;
      if (isCancellation(error) && scheduledRevision !== state.revision) continue;
      state.status = isCancellation(error) ? "cancelled" : "failed";
      if (input.resultOwnership !== "parent") {
        await CancellationScope.nonCancellable(() => scheduleActivity<Awaited<ReturnType<LearningNextActivities["markOperationFailed"]>>>(
          "markOperationFailed",
          [{
            tenantId: input.tenantId,
            operationId: input.operationId,
            cancelled: isCancellation(error),
            message: isCancellation(error) ? "操作已取消" : "后台任务失败，请稍后重试",
          }],
          durableActivityOptions(`mark-${state.status}`),
        ));
      }
      throw error;
    } finally {
      activeScope = undefined;
    }

    if (scheduledRevision !== state.revision) continue;
    if (input.resultOwnership === "parent") {
      state.status = "succeeded";
      return {
        operationId: input.operationId,
        taskType: input.taskType,
        status: "succeeded",
        outputRef: result.outputRef,
        aggregateRef: input.aggregateRef,
        aggregateVersion: input.aggregateVersion,
        revision: scheduledRevision,
      };
    }
    const persisted = await scheduleActivity<Awaited<ReturnType<LearningNextActivities["commitOperationResult"]>>>(
      "commitOperationResult",
      [{
        tenantId: input.tenantId,
        operationId: input.operationId,
        idempotencyKey: idempotencyForRevision(input.idempotencyKey, scheduledRevision),
        aggregateRef: input.aggregateRef,
        aggregateVersion: input.aggregateVersion,
        outputRef: result.outputRef,
      }],
      durableActivityOptions(`commit-r${scheduledRevision}`),
    );
    state.status = "succeeded";
    return {
      operationId: input.operationId,
      taskType: input.taskType,
      status: "succeeded",
      outputRef: persisted.outputRef,
      aggregateRef: input.aggregateRef,
      aggregateVersion: input.aggregateVersion,
      revision: scheduledRevision,
    };
  }
}

export async function finalizeQuestionWorkflow(input: FinalizeQuestionWorkflowInput): Promise<QuestionClosureResult> {
  if (input.schemaVersion !== 3
    || !idempotencyPattern.test(input.operationId)
    || !idempotencyPattern.test(input.eventId)
    || !/^qsn_[A-Za-z0-9]{8,}$/.test(input.questionSessionId)
    || !refPattern.test(input.inputRef)
    || !Number.isSafeInteger(input.aggregateVersion)
    || input.aggregateVersion < 1) {
    throw ApplicationFailure.nonRetryable("invalid FinalizeQuestion input", "invalid_workflow_input");
  }

  // Once Cut has frozen Attempt admission, external cancellation must not
  // leave the QuestionSession permanently finalizing. Model failures are
  // bounded by the grade TaskSpec and become explicit unresolved Judgments.
  return CancellationScope.nonCancellable(async () => {
    const prepared = await scheduleActivity<Awaited<ReturnType<LearningNextActivities["prepareQuestionFinalization"]>>>(
      "prepareQuestionFinalization",
      [input],
      questionCommitActivityOptions("prepare-question-finalization"),
    );
    for (const [index, task] of prepared.gradeTasks.entries()) {
      try {
        const result = await executeChild(agentTaskWorkflow, {
          args: [task.workflowInput],
          workflowId: `${workflowInfo().workflowId}:grade:${index + 1}:${task.attemptId}`,
          parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
        });
        await scheduleActivity<Awaited<ReturnType<LearningNextActivities["recordFinalJudgment"]>>>(
          "recordFinalJudgment",
          [{
            tenantId: input.tenantId,
            cutRequestId: prepared.cutRequestId,
            questionSessionId: input.questionSessionId,
            attemptId: task.attemptId,
            judgmentId: task.judgmentId,
            outputRef: result.outputRef,
          }],
          questionCommitActivityOptions(`record-judgment-${index + 1}`),
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : "grading failed";
        await scheduleActivity<Awaited<ReturnType<LearningNextActivities["recordUnresolvedJudgment"]>>>(
          "recordUnresolvedJudgment",
          [{
            tenantId: input.tenantId,
            cutRequestId: prepared.cutRequestId,
            questionSessionId: input.questionSessionId,
            attemptId: task.attemptId,
            judgmentId: task.judgmentId,
            reason: `有界评分未能形成可靠结论：${reason}`.slice(0, 2000),
          }],
          questionCommitActivityOptions(`record-unresolved-${index + 1}`),
        );
      }
    }
    return scheduleActivity<QuestionClosureResult>(
      "commitQuestionClosure",
      [{
        tenantId: input.tenantId,
        operationId: input.operationId,
        eventId: input.eventId,
        cutRequestId: prepared.cutRequestId,
        questionSessionId: input.questionSessionId,
      }],
      questionCommitActivityOptions("commit-question-closure"),
    );
  });
}

export async function replayScientificStateWorkflow(input: ScientificReplayWorkflowInput): Promise<ScientificReplayResult> {
  if (input.schemaVersion !== 3
    || !idempotencyPattern.test(input.operationId)
    || !idempotencyPattern.test(input.eventId)
    || !/^stu_[A-Za-z0-9]{8,}$/.test(input.studentId)
    || !/^tcor_[A-Za-z0-9]{8,}$/.test(input.teacherCorrectionId)
    || input.inputRef !== `teacher-correction:${input.teacherCorrectionId}`
    || !Number.isSafeInteger(input.aggregateVersion)
    || input.aggregateVersion < 2) {
    throw ApplicationFailure.nonRetryable("invalid scientific replay input", "invalid_workflow_input");
  }
  return CancellationScope.nonCancellable(() => scheduleActivity<ScientificReplayResult>(
    "replayScientificCorrection",
    [input],
    questionCommitActivityOptions("replay-scientific-correction"),
  ));
}

const enforceTaskType = (input: AgentTaskWorkflowInput, expected: TaskType): void => {
  if (input.taskType !== expected) {
    throw ApplicationFailure.nonRetryable(`expected ${expected}, received ${input.taskType}`, "invalid_workflow_input");
  }
};

export async function selectQuestionWorkflow(input: AgentTaskWorkflowInput): Promise<AgentTaskWorkflowResult> {
  enforceTaskType(input, "select_question");
  return agentTaskWorkflow(input);
}

export async function lightWorkflow(input: AgentTaskWorkflowInput): Promise<AgentTaskWorkflowResult> {
  enforceTaskType(input, "light");
  return agentTaskWorkflow(input);
}

export async function remSweepWorkflow(input: AgentTaskWorkflowInput): Promise<AgentTaskWorkflowResult> {
  enforceTaskType(input, "rem");
  return agentTaskWorkflow(input);
}

export async function deepConsolidationWorkflow(input: AgentTaskWorkflowInput): Promise<AgentTaskWorkflowResult> {
  enforceTaskType(input, "deep");
  return agentTaskWorkflow(input);
}

export async function allowedChildTasksWorkflow(input: AllowedChildWorkflowInput): Promise<AgentTaskWorkflowResult[]> {
  const results: AgentTaskWorkflowResult[] = [];
  for (const [index, child] of input.children.entries()) {
    assertAllowedChild(input.parentTaskType, child.taskType);
    results.push(await executeChild(agentTaskWorkflow, {
      args: [child],
      workflowId: `${workflowInfo().workflowId}:child:${index + 1}`,
      parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
    }));
  }
  return results;
}

export async function scheduledDreamTickWorkflow(input: ScheduledDreamTickInput): Promise<void> {
  await scheduleActivity<Awaited<ReturnType<LearningNextActivities["enqueueScheduledDream"]>>>(
    "enqueueScheduledDream",
    [{ tenantId: input.tenantId, phase: input.phase, scheduledAt: new Date().toISOString() }],
    durableActivityOptions(`enqueue-${input.phase}`),
  );
}
