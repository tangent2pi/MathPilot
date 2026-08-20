import assert from "node:assert/strict";
import test from "node:test";
import { PIPELINE_TASK_TIMEOUT_MS, shouldResumeTimedOutKtq } from "../src/pipeline-retry.ts";

test("document pipeline stages have a three-hour deadline", () => {
  assert.equal(PIPELINE_TASK_TIMEOUT_MS, 10_800_000);
});

test("only a timed-out KTQ run resumes the same session", () => {
  assert.equal(shouldResumeTimedOutKtq("ktq", "pipeline stage exceeded 2700000ms"), true);
  assert.equal(shouldResumeTimedOutKtq("ktq", "request timed out"), true);
  assert.equal(shouldResumeTimedOutKtq("ktq", "fetch failed"), false);
  assert.equal(shouldResumeTimedOutKtq("er", "pipeline stage exceeded 2700000ms"), false);
});
