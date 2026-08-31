import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Context } from "@temporalio/activity";
import type { WorkflowHandle } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { OutboxRelay, type OutboxRelayStore } from "../src/outbox-relay.ts";
import type {
  AgentTaskWorkflowInput,
  LearningNextActivities,
  OutboxWorkflowStart,
  PiTaskActivityInput,
} from "../src/runtime-types.ts";
import {
  agentTaskWorkflow,
  allowedChildTasksWorkflow,
  reviseTaskUpdate,
} from "../src/workflows.ts";

const taskInput = (
  suffix: string,
  taskType: AgentTaskWorkflowInput["taskType"] = "grade",
  extra: Partial<AgentTaskWorkflowInput> = {},
): AgentTaskWorkflowInput => ({
  schemaVersion: 3,
  tenantId: "tnt_test00001",
  operationId: `op_${suffix}00000001`,
  aggregateRef: `question-session:${suffix}`,
  aggregateVersion: 1,
  taskType,
  taskSpecVersion: "v1",
  inputRef: `agent-artifact:art_${suffix}00000001`,
  idempotencyKey: `evt_${suffix}00000001`,
  revision: 1,
  ...extra,
});

const waitUntil = async (predicate: () => boolean): Promise<void> => {
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return;
    await wait(10);
  }
  throw new Error("timed out waiting for test Activity");
};

const waitForActivityCancellation = async (context: Context): Promise<never> => {
  const heartbeat = setInterval(() => context.heartbeat({ waitingForCancellation: true }), 10);
  try {
    return await context.cancelled;
  } finally {
    clearInterval(heartbeat);
  }
};

test("Temporal owns retry, restart recovery, revision cancellation, Continue-As-New, child wait and duplicate start", { timeout: 120_000 }, async () => {
  const environment = await TestWorkflowEnvironment.createTimeSkipping();
  const taskQueue = "learning-next-runtime-test";
  const executions: Array<{
    operationId: string;
    revision: number;
    temporalAttempt: number;
    runId: string | undefined;
  }> = [];
  const failedOperations: Array<{ operationId: string; cancelled: boolean }> = [];
  const activities: LearningNextActivities = {
    async executePiTask(input: PiTaskActivityInput) {
      const context = Context.current();
      executions.push({
        operationId: input.operationId,
        revision: input.revision,
        temporalAttempt: context.info.attempt,
        runId: context.info.workflowExecution?.runId,
      });
      if (input.operationId.startsWith("op_retry") && context.info.attempt === 1) {
        throw new Error("transient model transport error");
      }
      if ((input.operationId.startsWith("op_revision") && input.revision === 1)
        || input.operationId.startsWith("op_cancel")) {
        await waitForActivityCancellation(context);
      }
      return {
        outputRef: `agent-artifact:art_output_${input.operationId}`,
        resolvedModelId: "deepseek-v4-flash-vision-exp",
        inputTokens: 10,
        outputTokens: 5,
      };
    },
    async commitOperationResult(input) {
      return { resultStatus: "committed", outputRef: input.outputRef };
    },
    async markOperationFailed(input) {
      failedOperations.push({ operationId: input.operationId, cancelled: input.cancelled });
    },
    async enqueueScheduledDream(input) {
      return {
        schemaVersion: 3,
        eventId: `evt_${input.phase}00000001`,
        tenantId: input.tenantId,
        operationId: `op_${input.phase}00000001`,
        eventType: input.phase === "rem" ? "dream.rem_requested" : "dream.deep_requested",
        aggregateRef: `dream-sweep:${input.tenantId}:${input.phase}`,
        aggregateVersion: 1,
        payloadRef: `agent-artifact:art_${input.phase}00000001`,
        occurredAt: input.scheduledAt,
      };
    },
    async prepareQuestionFinalization() {
      throw new Error("unexpected FinalizeQuestion Activity in generic runtime test");
    },
    async recordFinalJudgment() {},
    async recordUnresolvedJudgment() {},
    async commitQuestionClosure() {
      throw new Error("unexpected FinalizeQuestion commit in generic runtime test");
    },
  };
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    namespace: environment.namespace ?? "default",
    taskQueue,
    workflowsPath: fileURLToPath(new URL("../src/workflows.ts", import.meta.url)),
    activities,
  });

  let restartHandle: WorkflowHandle<typeof agentTaskWorkflow> | undefined;
  try {
    await worker.runUntil(async () => {
      const retryHandle = await environment.client.workflow.start(agentTaskWorkflow, {
        args: [taskInput("retry")],
        taskQueue,
        workflowId: "wf-retry-runtime-test",
      });
      await environment.sleep("5s");
      const retryResult = await retryHandle.result();
      assert.equal(retryResult.status, "succeeded");
      assert.deepEqual(
        executions.filter((value) => value.operationId.startsWith("op_retry")).map((value) => value.temporalAttempt),
        [1, 2],
      );

      const revisionInput = taskInput("revision", "select_question", { continueAsNewAfter: 1 });
      const revisionHandle = await environment.client.workflow.start(agentTaskWorkflow, {
        args: [revisionInput],
        taskQueue,
        workflowId: "wf-revision-runtime-test",
      });
      await waitUntil(() => executions.some((value) => value.operationId === revisionInput.operationId));
      const revisedState = await revisionHandle.executeUpdate(reviseTaskUpdate, {
        args: [{
          revision: 2,
          inputRef: "agent-artifact:art_revision00000002",
          reason: "student changed the selection intent",
        }],
      });
      assert.equal(revisedState.revision, 2);
      const revisionResult = await revisionHandle.result();
      assert.equal(revisionResult.revision, 2);
      const revisionRuns = executions
        .filter((value) => value.operationId === revisionInput.operationId)
        .map((value) => value.runId);
      assert.equal(new Set(revisionRuns).size, 2);

      const cancelInput = taskInput("cancel");
      const cancelHandle = await environment.client.workflow.start(agentTaskWorkflow, {
        args: [cancelInput],
        taskQueue,
        workflowId: "wf-cancel-runtime-test",
      });
      await waitUntil(() => executions.some((value) => value.operationId === cancelInput.operationId));
      await cancelHandle.cancel();
      await assert.rejects(cancelHandle.result());
      assert.deepEqual(
        failedOperations.find((value) => value.operationId === cancelInput.operationId),
        { operationId: cancelInput.operationId, cancelled: true },
      );

      const childResults = await environment.client.workflow.execute(allowedChildTasksWorkflow, {
        args: [{
          parentTaskType: "semantic_decomposition",
          children: [taskInput("childgrade", "grade"), taskInput("childlight", "light")],
        }],
        taskQueue,
        workflowId: "wf-child-runtime-test",
      });
      assert.deepEqual(childResults.map((value) => value.taskType), ["grade", "light"]);

      const event: OutboxWorkflowStart = {
        schemaVersion: 3,
        eventId: "evt_outbox00000001",
        tenantId: "tnt_test00001",
        operationId: "op_outbox00000001",
        eventType: "selection.intent_revised",
        aggregateRef: "selection-intent:intent-outbox",
        aggregateVersion: 1,
        payloadRef: "agent-artifact:art_outbox00000001",
        occurredAt: "2026-08-31T00:00:00.000Z",
      };
      const marked: string[] = [];
      const relayStore: OutboxRelayStore = {
        async pending() { return [event]; },
        async markStarted(eventId) { marked.push(eventId); },
        async markFailed(_eventId, error) { throw new Error(error); },
        async close() {},
      };
      const relay = new OutboxRelay(environment.client.workflow, relayStore, { taskQueue });
      assert.equal((await relay.pollOnce()).started, 1);
      assert.equal((await relay.pollOnce()).duplicates, 1);
      assert.deepEqual(marked, [event.eventId, event.eventId]);

    });

    // Starts are durable even while no Worker is polling. The replacement
    // Worker must recover this queued execution from Temporal, not memory.
    const restartInput = taskInput("restart");
    restartHandle = await environment.client.workflow.start(agentTaskWorkflow, {
      args: [restartInput],
      taskQueue,
      workflowId: "wf-restart-runtime-test",
    });
    const replacementWorker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace ?? "default",
      taskQueue,
      workflowsPath: fileURLToPath(new URL("../src/workflows.ts", import.meta.url)),
      activities,
    });
    const recovered = await replacementWorker.runUntil(async () => {
      return restartHandle!.result();
    });
    assert.equal(recovered.status, "succeeded");
    assert.equal(executions.filter((value) => value.operationId.startsWith("op_restart")).length, 1);
  } finally {
    await environment.teardown();
  }
});
