import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type {
  AgentTaskWorkflowInput,
  LearningNextActivities,
  PiTaskActivityInput,
} from "../src/runtime-types.ts";
import { finalizeQuestionWorkflow } from "../src/workflows.ts";

const gradeTask = (attemptId: string): AgentTaskWorkflowInput => ({
  schemaVersion: 3,
  tenantId: "tnt_test00001",
  operationId: "op_finalize00000001",
  eventId: "evt_cut00000001",
  aggregateRef: "question-session:qsn_finalize0001",
  aggregateVersion: 3,
  taskType: "grade",
  taskSpecVersion: "v1",
  inputRef: `agent-artifact:art_${attemptId.slice(4)}00000001`,
  idempotencyKey: `cut_finalize0001:grade:${attemptId}`,
  revision: 1,
  resultOwnership: "parent",
});

test("FinalizeQuestion turns exhausted grading into unresolved and still closes once", { timeout: 60_000 }, async () => {
  const environment = await TestWorkflowEnvironment.createTimeSkipping();
  const taskQueue = "learning-next-finalize-test";
  const recorded: string[] = [];
  const unresolved: string[] = [];
  let closureCommits = 0;
  const activities: LearningNextActivities = {
    async executePiTask(input: PiTaskActivityInput) {
      if (input.idempotencyKey.includes("att_gradefail01")) throw new Error("bounded grade model failure");
      return {
        outputRef: "agent-artifact:art_gradeoutput01",
        resolvedModelId: "deepseek-v4-flash-vision-exp",
        inputTokens: 10,
        outputTokens: 5,
      };
    },
    async commitOperationResult() {
      throw new Error("child grade must not commit the parent operation");
    },
    async markOperationFailed() {
      throw new Error("child grade must not fail the parent operation");
    },
    async beginDreamRun() { throw new Error("unexpected Dream Activity"); },
    async commitLightDream() { throw new Error("unexpected Dream Activity"); },
    async commitRemDream() { throw new Error("unexpected Dream Activity"); },
    async commitDeepDream() { throw new Error("unexpected Dream Activity"); },
    async failDreamRun() { throw new Error("unexpected Dream Activity"); },
    async enqueueScheduledDream() {
      throw new Error("unexpected Dream Activity");
    },
    async enqueueImmediateDream() { throw new Error("unexpected Dream Activity"); },
    async rollbackAnnotationChangeSet() { throw new Error("unexpected Dream Activity"); },
    async prepareQuestionFinalization() {
      return {
        tenantId: "tnt_test00001",
        operationId: "op_finalize00000001",
        cutRequestId: "cut_finalize0001",
        questionSessionId: "qsn_finalize0001",
        gradeTasks: [
          { attemptId: "att_gradepass001", judgmentId: "jdg_gradepass001", workflowInput: gradeTask("att_gradepass001") },
          { attemptId: "att_gradefail01", judgmentId: "jdg_gradefail01", workflowInput: gradeTask("att_gradefail01") },
        ],
      };
    },
    async recordFinalJudgment(input) {
      recorded.push(input.attemptId);
    },
    async recordUnresolvedJudgment(input) {
      unresolved.push(input.attemptId);
    },
    async commitQuestionClosure(input) {
      closureCommits += 1;
      return {
        questionClosureId: "qcl_finalize0001",
        questionSessionId: input.questionSessionId,
        status: "closed",
        sessionVersion: 4,
        judgmentRefs: ["judgment://jdg_gradepass001", "judgment://jdg_gradefail01"],
        observationRefs: [],
      };
    },
    async replayScientificCorrection() {
      throw new Error("unexpected scientific replay Activity");
    },
    async commitSelectionDecision() {
      throw new Error("unexpected selection commit Activity");
    },
    async markSelectionSuperseded() {
      throw new Error("unexpected selection supersede Activity");
    },
    async commitForegroundResponse() {
      throw new Error("unexpected foreground response Activity");
    },
  };
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    namespace: environment.namespace ?? "default",
    taskQueue,
    workflowsPath: fileURLToPath(new URL("../src/workflows.ts", import.meta.url)),
    activities,
  });
  try {
    const result = await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start(finalizeQuestionWorkflow, {
        args: [{
          schemaVersion: 3,
          tenantId: "tnt_test00001",
          operationId: "op_finalize00000001",
          eventId: "evt_cut00000001",
          cutRequestId: "cut_finalize0001",
          questionSessionId: "qsn_finalize0001",
          aggregateVersion: 3,
          inputRef: "agent-artifact:art_cut00000001",
        }],
        taskQueue,
        workflowId: "question.cut_requested:evt_cut00000001",
      });
      await environment.sleep("10s");
      return handle.result();
    });
    assert.equal(result.status, "closed");
    assert.deepEqual(recorded, ["att_gradepass001"]);
    assert.deepEqual(unresolved, ["att_gradefail01"]);
    assert.equal(closureCommits, 1);
  } finally {
    await environment.teardown();
  }
});
