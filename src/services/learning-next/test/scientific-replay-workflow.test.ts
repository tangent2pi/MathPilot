import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Context } from "@temporalio/activity";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { LearningNextActivities } from "../src/runtime-types.ts";
import { replayScientificStateWorkflow } from "../src/workflows.ts";

test("teacher correction replay is a retryable deterministic Workflow without Pi", { timeout: 60_000 }, async () => {
  const environment = await TestWorkflowEnvironment.createTimeSkipping();
  const taskQueue = "learning-next-scientific-replay-test";
  let attempts = 0;
  const unexpected = async (): Promise<never> => { throw new Error("unexpected Activity"); };
  const activities: LearningNextActivities = {
    executePiTask: unexpected,
    commitOperationResult: unexpected,
    markOperationFailed: unexpected,
    beginDreamRun: unexpected,
    commitLightDream: unexpected,
    commitRemDream: unexpected,
    commitDeepDream: unexpected,
    failDreamRun: unexpected,
    enqueueScheduledDream: unexpected,
    rollbackAnnotationChangeSet: unexpected,
    prepareQuestionFinalization: unexpected,
    recordFinalJudgment: unexpected,
    recordUnresolvedJudgment: unexpected,
    commitQuestionClosure: unexpected,
    commitSelectionDecision: unexpected,
    markSelectionSuperseded: unexpected,
    async replayScientificCorrection(input) {
      attempts += 1;
      if (Context.current().info.attempt === 1) throw new Error("transient database transport error");
      return {
        teacherCorrectionId: input.teacherCorrectionId,
        questionSessionId: "qsn_scireplay001",
        masteryProjectionRefs: ["mastery-projection:stu_scireplay001:K_TEST:1"],
        retentionProjectionRefs: [],
        errorPatternProjectionRefs: ["error-pattern-projection:stu_scireplay001:E_TEST"],
      };
    },
  };
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    namespace: environment.namespace ?? "default",
    taskQueue,
    workflowsPath: fileURLToPath(new URL("../src/workflows.ts",import.meta.url)),
    activities,
  });
  try {
    const result = await worker.runUntil(() => environment.client.workflow.execute(replayScientificStateWorkflow,{
      args: [{
        schemaVersion: 3,
        tenantId: "tnt_scireplay001",
        operationId: "op_scireplay001",
        eventId: "evt_scireplay001",
        studentId: "stu_scireplay001",
        teacherCorrectionId: "tcor_scireplay001",
        aggregateVersion: 2,
        inputRef: "teacher-correction:tcor_scireplay001",
      }],
      taskQueue,
      workflowId: "teacher.correction_recorded:evt_scireplay001",
    }));
    assert.equal(result.teacherCorrectionId,"tcor_scireplay001");
    assert.equal(attempts,2);
  } finally {
    await environment.teardown();
  }
});
