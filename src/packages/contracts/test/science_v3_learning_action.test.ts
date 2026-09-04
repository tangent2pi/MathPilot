import assert from "node:assert/strict";
import test from "node:test";
import { LEARNING_ACTION_TOOL_PARAMETERS, parseBoundedLearningAction } from "../src/index.ts";
import { Value } from "typebox/value";

const artifact = {
  schema: "mathpilot.teaching-artifact/math-derivation/v1",
  label: "Derivative",
  steps: [{ expression: "d(x^2)/dx = 2x", note: "power rule" }],
};

test("learning_action exposes a strict provider-compatible object root", () => {
  assert.equal(LEARNING_ACTION_TOOL_PARAMETERS.type, "object");
  assert.equal(LEARNING_ACTION_TOOL_PARAMETERS.additionalProperties, false);
  assert.deepEqual(LEARNING_ACTION_TOOL_PARAMETERS.required, ["action"]);
});

test("learning_action accepts each semantic variant", () => {
  const values = [
    { action: "request_cut", reason: "completed" },
    { action: "revise_selection_intent", natural_language_request: "Use a quadratic example" },
    { action: "present_validated_artifact", artifact_schema: artifact.schema, summary: "A derivation", content: artifact },
  ];
  for (const value of values) {
    assert.equal(Value.Check(LEARNING_ACTION_TOOL_PARAMETERS, value), true);
    assert.deepEqual(parseBoundedLearningAction(value), value);
  }
});

test("learning_action rejects mixed, missing, extra, and out-of-bounds fields", () => {
  const invalid = [
    { action: "request_cut" },
    { action: "request_cut", reason: "completed", natural_language_request: "wrong field" },
    { action: "revise_selection_intent", natural_language_request: "ok", reason: "completed" },
    { action: "present_validated_artifact", artifact_schema: artifact.schema, summary: "ok" },
    { action: "request_cut", reason: "completed", actor_user_id: "user_1" },
    { action: "request_cut", reason: "completed", next_natural_language_request: "x".repeat(4001) },
    { action: "present_validated_artifact", artifact_schema: artifact.schema, summary: "ok", content: {
      ...artifact,
      steps: Array.from({ length: 17 }, () => ({ expression: "x" })),
    } },
  ];
  for (const value of invalid) {
    assert.equal(Value.Check(LEARNING_ACTION_TOOL_PARAMETERS, value), false);
    assert.throws(() => parseBoundedLearningAction(value));
  }
});
