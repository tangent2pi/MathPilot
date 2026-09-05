import assert from "node:assert/strict";
import test from "node:test";
import { TASK_REGISTRY, directTaskTypeForEvent } from "../src/task-registry.ts";
import { directWorkflowRoute, scientificReplayInputFromOutbox, workflowInputFromOutbox } from "../src/outbox-routing.ts";

test("Task Registry grants only the documented minimum capabilities", () => {
  for (const task of ["grade", "diagnose", "teach_summary", "light", "rem", "deep"] as const) {
    assert.deepEqual(TASK_REGISTRY[task].allowed_capability_tools, []);
  }
  assert.deepEqual(TASK_REGISTRY.select_question.allowed_capability_tools, ["question_catalog"]);
  assert.deepEqual(TASK_REGISTRY.semantic_decomposition.allowed_capability_tools, ["delegate"]);
  assert.deepEqual(TASK_REGISTRY.foreground_teaching.allowed_capability_tools, ["read", "grep", "learning_action", "assessment", "sandbox"]);
});

test("domain workflows are not collapsed into unrelated Pi tasks", () => {
  assert.equal(directTaskTypeForEvent("selection.intent_revised"), "select_question");
  assert.throws(() => directTaskTypeForEvent("question.cut_requested"), /FinalizeQuestionWorkflow/);
  assert.throws(() => directTaskTypeForEvent("teacher.correction_recorded"), /deterministic replay/);
  assert.equal(directWorkflowRoute("question.cut_requested")?.workflowType, "finalizeQuestionWorkflow");
  assert.equal(directWorkflowRoute("teacher.correction_recorded")?.workflowType, "replayScientificStateWorkflow");
  assert.equal(directWorkflowRoute("foreground.message_submitted")?.workflowType, "foregroundTeachingWorkflow");
  assert.equal(directTaskTypeForEvent("foreground.message_submitted"), "foreground_teaching");
  const soft = workflowInputFromOutbox({
    schemaVersion: 3,
    eventId: "evt_closed00000001",
    tenantId: "tnt_test00001",
    operationId: "op_finalize00000001",
    eventType: "question.closed",
    aggregateRef: "question-session:qsn_finalize0001",
    aggregateVersion: 4,
    payloadRef: "agent-artifact:art_closed00000001",
    occurredAt: "2026-08-31T08:00:00.000Z",
  }, "light");
  assert.equal(soft.resultOwnership, "parent");
  const foreground = workflowInputFromOutbox({
    schemaVersion: 3,
    eventId: "evt_foreground0001",
    tenantId: "tnt_test00001",
    operationId: "op_foreground0001",
    eventType: "foreground.message_submitted",
    aggregateRef: "conversation-thread:thr_foreground01",
    aggregateVersion: 2,
    payloadRef: "agent-artifact:art_foreground01",
    occurredAt: "2026-08-31T08:00:00.000Z",
  }, "foreground_teaching");
  assert.equal(foreground.resultOwnership, "parent");
});

test("teacher correction routes reference-only deterministic replay input", () => {
  const input = scientificReplayInputFromOutbox({
    schemaVersion: 3,
    eventId: "evt_teacher001",
    tenantId: "tnt_dev00001",
    operationId: "op_teacher001",
    eventType: "teacher.correction_recorded",
    aggregateRef: "student:stu_student01",
    aggregateVersion: 2,
    payloadRef: "teacher-correction:tcor_teacher001",
    occurredAt: "2026-08-31T00:00:00.000Z",
  });
  assert.equal(input.studentId,"stu_student01");
  assert.equal(input.teacherCorrectionId,"tcor_teacher001");
  assert.equal(input.inputRef,"teacher-correction:tcor_teacher001");
});
