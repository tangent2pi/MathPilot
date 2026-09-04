import assert from "node:assert/strict";
import test from "node:test";
import { learningView, viewEtag } from "../src/learning-read/view.ts";

const operationView = (status: "running" | "failed") => learningView({
  kind: "thread_messages",
  resourceKind: "conversation-thread",
  resourceId: "thr_etagtest01",
  version: 2,
  factsThrough: "2026-09-02T00:00:00.000Z",
  data: {
    messages: [],
    operations: [{ operation_id: "op_etagtest01", status }],
  },
});

test("view ETag changes when a composite child changes", () => {
  assert.notEqual(viewEtag(operationView("running")), viewEtag(operationView("failed")));
});

test("view ETag ignores response generation time", () => {
  const first = operationView("running");
  const second = { ...first, generated_at: "2099-01-01T00:00:00.000Z" };
  assert.equal(viewEtag(first), viewEtag(second));
});
