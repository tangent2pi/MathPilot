import assert from "node:assert/strict";
import test from "node:test";
import { LEARNING_ACTION_TOOL_PARAMETERS } from "@mathpilot/contracts";
import { createAgentAttemptSettings } from "../src/pi-task-executor.ts";

test("learning_action exposes an object-rooted provider tool schema", () => {
  const schema = LEARNING_ACTION_TOOL_PARAMETERS as unknown as Record<string, unknown>;
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["action"]);
});

test("AgentAttempt delegates retries to Temporal", () => {
  const settings = createAgentAttemptSettings();
  assert.equal(settings.getCompactionEnabled(), false);
  assert.deepEqual(settings.getRetrySettings(), { enabled: false, maxRetries: 3, baseDelayMs: 2000 });
  assert.deepEqual(settings.getProviderRetrySettings(), {
    timeoutMs: undefined,
    maxRetries: 0,
    maxRetryDelayMs: 60_000,
  });
});
