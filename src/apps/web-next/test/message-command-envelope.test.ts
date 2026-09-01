import assert from "node:assert/strict";
import test from "node:test";
import type { UserSubmittedMessagePart } from "../src/learning/contracts";
import { LearningApiError } from "../src/learning/data/client";
import {
  acquireMessageCommandEnvelope,
  bindMessageCommandThread,
  messageCommandOutcomeIsUnknown,
} from "../src/learning/runtime/message-command-envelope";

const textParts = (text: string): readonly UserSubmittedMessagePart[] => [{ type: "text", text }];

test("an unconfirmed retry reuses the exact key, timestamp, version and payload", () => {
  let nextKey = 0;
  const createKey = () => `key-${++nextKey}`;
  const initial = acquireMessageCommandEnvelope(null, {
    threadId: "thr_existing01",
    expectedVersion: 7,
    requestedAt: "2026-09-01T01:02:03.000Z",
    parts: textParts("解答"),
  }, createKey);
  const retry = acquireMessageCommandEnvelope(initial, {
    threadId: "thr_existing01",
    expectedVersion: 9,
    requestedAt: "2026-09-01T01:05:00.000Z",
    parts: textParts("解答"),
  }, createKey);

  assert.strictEqual(retry, initial);
  assert.equal(retry.key, "key-1");
  assert.equal(retry.requestedAt, "2026-09-01T01:02:03.000Z");
  assert.equal(retry.expectedVersion, 7);
  assert.equal(nextKey, 1);
});

test("new-thread navigation keeps the same bound command envelope", () => {
  const initial = acquireMessageCommandEnvelope(null, {
    requestedAt: "2026-09-01T01:02:03.000Z",
    parts: textParts("新对话首句"),
  }, () => "key-new-thread");
  const bound = bindMessageCommandThread(initial, "thr_created01", 1);
  const retry = acquireMessageCommandEnvelope(bound, {
    threadId: "thr_created01",
    expectedVersion: 2,
    requestedAt: "2026-09-01T01:06:00.000Z",
    parts: textParts("新对话首句"),
  }, () => "unexpected-key");

  assert.strictEqual(retry, bound);
  assert.equal(retry.key, "key-new-thread");
  assert.equal(retry.expectedVersion, 1);
});

test("a changed payload or unrelated route receives a new command key", () => {
  const initial = acquireMessageCommandEnvelope(null, {
    threadId: "thr_existing01",
    expectedVersion: 3,
    requestedAt: "2026-09-01T01:02:03.000Z",
    parts: textParts("原文"),
  }, () => "key-original");
  const changed = acquireMessageCommandEnvelope(initial, {
    threadId: "thr_existing01",
    expectedVersion: 3,
    requestedAt: "2026-09-01T01:03:00.000Z",
    parts: textParts("修改后"),
  }, () => "key-changed");
  const moved = acquireMessageCommandEnvelope(initial, {
    threadId: "thr_elsewhere01",
    expectedVersion: 1,
    requestedAt: "2026-09-01T01:04:00.000Z",
    parts: textParts("原文"),
  }, () => "key-moved");

  assert.equal(changed.key, "key-changed");
  assert.equal(moved.key, "key-moved");
});

test("only explicit non-timeout 4xx responses make the command outcome definitive", () => {
  assert.equal(messageCommandOutcomeIsUnknown(new LearningApiError("无权限", 403)), false);
  assert.equal(messageCommandOutcomeIsUnknown(new LearningApiError("超时", 408)), true);
  assert.equal(messageCommandOutcomeIsUnknown(new LearningApiError("服务异常", 500)), true);
  assert.equal(messageCommandOutcomeIsUnknown(new TypeError("fetch failed")), true);
});
