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
  ForegroundResponseCommitResult,
  ImmediateDreamEnqueueResult,
  ImmediateDreamWorkflowInput,
  LearningNextActivities,
  PiTaskActivityResult,
  QuestionClosureResult,
  ScientificReplayResult,
  ScientificReplayWorkflowInput,
  SelectionWorkflowResult,
  SelectionWorkflowState,
  ScheduledDreamTickInput,
  DreamPhase,
  DreamRunCommitResult,
  TaskRevision,
  TaskType,
} from "./runtime-types.ts";

export const reviseTaskSignal = defineSignal<[TaskRevision]>("reviseTask");
export const reviseTaskUpdate = defineUpdate<AgentTaskWorkflowState, [TaskRevision]>("reviseTaskUpdate");
export const taskStateQuery = defineQuery<AgentTaskWorkflowState>("taskState");
export const reviseSelectionSignal = defineSignal<[AgentTaskWorkflowInput]>("reviseSelection");
export const selectionStateQuery = defineQuery<SelectionWorkflowState>("selectionState");

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

export async function foregroundTeachingWorkflow(input: AgentTaskWorkflowInput): Promise<AgentTaskWorkflowResult> {
  assertWorkflowInput(input);
  enforceTaskType(input, "foreground_teaching");
  if (!input.eventId || !idempotencyPattern.test(input.eventId)
    || !/^conversation-thread:thr_[A-Za-z0-9]{8,}$/.test(input.aggregateRef)
    || !/^agent-artifact:art_[A-Za-z0-9]{8,}$/.test(input.inputRef)) {
    throw ApplicationFailure.nonRetryable("invalid foreground teaching input", "invalid_workflow_input");
  }
  try {
    const result = await scheduleActivity<PiTaskActivityResult>(
      "executePiTask",
      [{
        ...input,
        workflowId: workflowInfo().workflowId,
        resultOwnership: "parent",
        idempotencyKey: idempotencyForRevision(input.idempotencyKey, input.revision),
      }],
      taskActivityOptions("foreground_teaching", input.taskSpecVersion, `foreground-pi-r${input.revision}`),
    );
    const committed = await scheduleActivity<ForegroundResponseCommitResult>(
      "commitForegroundResponse",
      [{
        tenantId: input.tenantId,
        operationId: input.operationId,
        eventId: input.eventId,
        outputRef: result.outputRef,
      }],
      questionCommitActivityOptions("commit-foreground-response"),
    );
    return {
      operationId: input.operationId,
      taskType: "foreground_teaching",
      status: "succeeded",
      outputRef: result.outputRef,
      aggregateRef: input.aggregateRef,
      aggregateVersion: committed.threadVersion,
      revision: input.revision,
    };
  } catch (error) {
    await CancellationScope.nonCancellable(() => scheduleActivity<Awaited<ReturnType<LearningNextActivities["markOperationFailed"]>>>(
      "markOperationFailed",
      [{
        tenantId: input.tenantId,
        operationId: input.operationId,
        cancelled: isCancellation(error),
        message: isCancellation(error) ? "回复已取消" : "回复失败，请重试",
      }],
      durableActivityOptions("mark-foreground-failed"),
    ));
    throw error;
  }
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

const assertSelectionWorkflowInput = (input: AgentTaskWorkflowInput): void => {
  assertWorkflowInput(input);
  enforceTaskType(input, "select_question");
  if (!input.eventId || !idempotencyPattern.test(input.eventId)) {
    throw ApplicationFailure.nonRetryable("Selector event ID is invalid", "invalid_workflow_input");
  }
  if (!/^conversation-thread:thr_[A-Za-z0-9]{8,}$/.test(input.aggregateRef)
    || input.aggregateVersion !== input.revision) {
    throw ApplicationFailure.nonRetryable("Selector must be bound to one Thread intent revision", "invalid_workflow_input");
  }
};

const selectionSnapshot = (state: SelectionWorkflowState): SelectionWorkflowState => ({ ...state });

export async function selectQuestionWorkflow(initial: AgentTaskWorkflowInput): Promise<SelectionWorkflowResult> {
  assertSelectionWorkflowInput(initial);
  let current = { ...initial, resultOwnership: "parent" as const };
  const continueAfter = Math.min(Math.max(initial.continueAsNewAfter ?? 32, 1), 256);
  let attemptsThisRun = 0;
  let attemptsForRevision = 0;
  let activeScope: CancellationScope | undefined;
  const state: SelectionWorkflowState = {
    status: "running",
    revision: current.revision,
    operationId: current.operationId,
    inputRef: current.inputRef,
    attemptsCompleted: current.carriedAttempts ?? 0,
  };

  const acceptRevision = (next: AgentTaskWorkflowInput): void => {
    assertSelectionWorkflowInput(next);
    if (next.tenantId !== initial.tenantId || next.aggregateRef !== initial.aggregateRef) {
      throw new Error("selection revision belongs to a different Thread");
    }
    if (next.revision < current.revision) return;
    if (next.revision === current.revision) {
      if (next.operationId !== current.operationId || next.inputRef !== current.inputRef || next.eventId !== current.eventId) {
        throw new Error("selection revision is already bound to different immutable inputs");
      }
      return;
    }
    current = { ...next, resultOwnership: "parent" };
    attemptsForRevision = 0;
    state.status = "revising";
    state.revision = current.revision;
    state.operationId = current.operationId;
    state.inputRef = current.inputRef;
    activeScope?.cancel();
  };

  setHandler(selectionStateQuery, () => selectionSnapshot(state));
  setHandler(reviseSelectionSignal, (next) => {
    try {
      acceptRevision(next);
    } catch {
      // Outbox delivery is at-least-once. Invalid or conflicting signal
      // payloads are ignored; host-side commit validation remains decisive.
    }
  });

  const supersede = async (previous: AgentTaskWorkflowInput, replacement: AgentTaskWorkflowInput): Promise<void> => {
    await CancellationScope.nonCancellable(() => scheduleActivity<Awaited<ReturnType<LearningNextActivities["markSelectionSuperseded"]>>>(
      "markSelectionSuperseded",
      [{
        tenantId: previous.tenantId,
        operationId: previous.operationId,
        replacementOperationId: replacement.operationId,
      }],
      durableActivityOptions(`supersede-r${previous.revision}-by-r${replacement.revision}`),
    ));
  };

  while (true) {
    if (attemptsThisRun >= continueAfter || workflowInfo().continueAsNewSuggested) {
      await continueAsNew<typeof selectQuestionWorkflow>({
        ...current,
        carriedAttempts: state.attemptsCompleted,
      });
    }

    const scheduled = current;
    state.status = "running";
    activeScope = new CancellationScope();
    let taskResult: PiTaskActivityResult;
    try {
      taskResult = await activeScope.run(() => scheduleActivity<PiTaskActivityResult>(
        "executePiTask",
        [{
          ...scheduled,
          idempotencyKey: idempotencyForRevision(scheduled.idempotencyKey, scheduled.revision),
          workflowId: workflowInfo().workflowId,
          resultOwnership: "parent",
        }],
        taskActivityOptions("select_question", scheduled.taskSpecVersion, `selector-r${scheduled.revision}-n${attemptsForRevision + 1}`),
      ));
      attemptsThisRun += 1;
      attemptsForRevision += 1;
      state.attemptsCompleted += 1;
    } catch (error) {
      attemptsThisRun += 1;
      attemptsForRevision += 1;
      state.attemptsCompleted += 1;
      activeScope = undefined;
      if (isCancellation(error) && scheduled.operationId !== current.operationId) {
        await supersede(scheduled, current);
        continue;
      }
      state.status = isCancellation(error) ? "cancelled" : "failed";
      await CancellationScope.nonCancellable(() => scheduleActivity<Awaited<ReturnType<LearningNextActivities["markOperationFailed"]>>>(
        "markOperationFailed",
        [{
          tenantId: scheduled.tenantId,
          operationId: scheduled.operationId,
          cancelled: isCancellation(error),
          message: isCancellation(error) ? "选题操作已取消" : "选题任务失败，请稍后重试",
        }],
        durableActivityOptions(`mark-selector-${state.status}-r${scheduled.revision}`),
      ));
      throw error;
    } finally {
      activeScope = undefined;
    }

    if (scheduled.operationId !== current.operationId) {
      await supersede(scheduled, current);
      continue;
    }

    const committed = await scheduleActivity<Awaited<ReturnType<LearningNextActivities["commitSelectionDecision"]>>>(
      "commitSelectionDecision",
      [{
        tenantId: scheduled.tenantId,
        operationId: scheduled.operationId,
        eventId: scheduled.eventId!,
        outputRef: taskResult.outputRef,
      }],
      questionCommitActivityOptions(`commit-selection-r${scheduled.revision}-n${attemptsForRevision}`),
    );

    if (scheduled.operationId !== current.operationId) {
      await supersede(scheduled, current);
      continue;
    }
    if (committed.status === "candidate_invalid" && attemptsForRevision < 3) continue;
    if (committed.status === "candidate_invalid") {
      state.status = "failed";
      await scheduleActivity<Awaited<ReturnType<LearningNextActivities["markOperationFailed"]>>>(
        "markOperationFailed",
        [{
          tenantId: scheduled.tenantId,
          operationId: scheduled.operationId,
          cancelled: false,
          message: "候选题已变化，请重新发起选题",
        }],
        durableActivityOptions(`mark-selector-candidate-invalid-r${scheduled.revision}`),
      );
    } else if (committed.status === "selected" || committed.status === "already_committed") {
      state.status = "selected";
    } else if (committed.status === "no_candidate") {
      state.status = "no_candidate";
    } else {
      state.status = "failed";
    }
    return {
      ...committed,
      operationId: scheduled.operationId,
      intentRevision: scheduled.revision,
    };
  }
}

export async function lightWorkflow(input: AgentTaskWorkflowInput): Promise<AgentTaskWorkflowResult> {
  return dreamPhaseWorkflow(input,"light","commitLightDream");
}

export async function remSweepWorkflow(input: AgentTaskWorkflowInput): Promise<AgentTaskWorkflowResult> {
  return dreamPhaseWorkflow(input,"rem","commitRemDream");
}

export async function deepConsolidationWorkflow(input: AgentTaskWorkflowInput): Promise<AgentTaskWorkflowResult> {
  return dreamPhaseWorkflow(input,"deep","commitDeepDream");
}

async function dreamPhaseWorkflow(
  input: AgentTaskWorkflowInput,
  phase: DreamPhase,
  commitActivity: "commitLightDream" | "commitRemDream" | "commitDeepDream",
): Promise<AgentTaskWorkflowResult> {
  assertWorkflowInput(input);
  enforceTaskType(input,phase);
  if (!input.eventId || !idempotencyPattern.test(input.eventId)) {
    throw ApplicationFailure.nonRetryable("Dream event ID is invalid","invalid_workflow_input");
  }
  const base = {
    tenantId: input.tenantId,
    operationId: input.operationId,
    eventId: input.eventId,
    inputRef: input.inputRef,
    phase,
  };
  await scheduleActivity<Awaited<ReturnType<LearningNextActivities["beginDreamRun"]>>>(
    "beginDreamRun",[base],durableActivityOptions(`begin-${phase}`),
  );
  try {
    const result = await scheduleActivity<PiTaskActivityResult>(
      "executePiTask",
      [{
        ...input,
        workflowId: workflowInfo().workflowId,
        resultOwnership: "parent",
        idempotencyKey: idempotencyForRevision(input.idempotencyKey,input.revision),
      }],
      taskActivityOptions(phase,input.taskSpecVersion,`${phase}-pi-r${input.revision}`),
    );
    await scheduleActivity<DreamRunCommitResult>(
      commitActivity,[{ ...base,outputRef: result.outputRef }],questionCommitActivityOptions(`commit-${phase}`),
    );
    return {
      operationId: input.operationId,
      taskType: phase,
      status: "succeeded",
      outputRef: result.outputRef,
      aggregateRef: input.aggregateRef,
      aggregateVersion: input.aggregateVersion,
      revision: input.revision,
    };
  } catch (error) {
    await CancellationScope.nonCancellable(() => scheduleActivity<Awaited<ReturnType<LearningNextActivities["failDreamRun"]>>>(
      "failDreamRun",
      [{
        ...base,
        cancelled: isCancellation(error),
        message: isCancellation(error) ? "Dream task cancelled" : "Dream task failed after bounded retries",
      }],
      durableActivityOptions(`fail-${phase}`),
    ));
    throw error;
  }
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

export async function immediateDreamWorkflow(input: ImmediateDreamWorkflowInput): Promise<ImmediateDreamEnqueueResult> {
  if (input.schemaVersion !== 3
    || !idempotencyPattern.test(input.operationId)
    || !idempotencyPattern.test(input.eventId)
    || !/^stu_[A-Za-z0-9]{8,}$/.test(input.studentId)
    || !Number.isFinite(Date.parse(input.requestedAt))) {
    throw ApplicationFailure.nonRetryable("invalid immediate Dream input","invalid_workflow_input");
  }
  try {
    return await scheduleActivity<ImmediateDreamEnqueueResult>(
      "enqueueImmediateDream",[input],questionCommitActivityOptions("enqueue-immediate-dream"),
    );
  } catch (error) {
    await CancellationScope.nonCancellable(() => scheduleActivity<Awaited<ReturnType<LearningNextActivities["markOperationFailed"]>>>(
      "markOperationFailed",
      [{ tenantId: input.tenantId,operationId: input.operationId,cancelled: isCancellation(error),message: "学习记忆整理失败，请稍后重试" }],
      durableActivityOptions("mark-immediate-dream-failed"),
    ));
    throw error;
  }
}
