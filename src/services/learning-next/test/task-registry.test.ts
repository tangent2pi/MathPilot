import assert from "node:assert/strict";
import test from "node:test";
import { TASK_REGISTRY, directTaskTypeForEvent } from "../src/task-registry.ts";

test("Task Registry grants only the documented minimum capabilities", () => {
  for (const task of ["grade", "diagnose", "teach_summary", "light", "rem", "deep"] as const) {
    assert.deepEqual(TASK_REGISTRY[task].allowed_capability_tools, []);
  }
  assert.deepEqual(TASK_REGISTRY.select_question.allowed_capability_tools, ["question_catalog"]);
  assert.deepEqual(TASK_REGISTRY.semantic_decomposition.allowed_capability_tools, ["delegate"]);
  assert.deepEqual(TASK_REGISTRY.foreground_teaching.allowed_capability_tools, ["read", "grep", "learning_action"]);
});

test("domain workflows are not collapsed into unrelated Pi tasks", () => {
  assert.equal(directTaskTypeForEvent("selection.intent_revised"), "select_question");
  assert.throws(() => directTaskTypeForEvent("question.cut_requested"), /FinalizeQuestionWorkflow/);
  assert.throws(() => directTaskTypeForEvent("teacher.correction_recorded"), /deterministic replay/);
});
