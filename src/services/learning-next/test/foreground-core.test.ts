import assert from "node:assert/strict";
import test from "node:test";
import { parseBoundedLearningAction, parseForegroundTeachingOutput } from "../src/foreground-core.ts";

const binding = {
  conversationThreadId: "thr_foreground01",
  foregroundEpochId: "fge_foreground01",
  replyToMessageId: "msg_foreground01",
};

test("foreground output is bound to the host Thread, epoch and triggering message", () => {
  const output = parseForegroundTeachingOutput({
    schema_version: 3,
    conversation_thread_id: binding.conversationThreadId,
    foreground_epoch_id: binding.foregroundEpochId,
    reply_to_message_id: binding.replyToMessageId,
    parts: [{ type: "text", text: "先固定底边，再比较高。" }],
  }, binding);
  assert.equal(output.parts[0]?.type, "text");
  assert.throws(() => parseForegroundTeachingOutput({
    ...output,
    conversation_thread_id: "thr_otherstudent01",
  }, binding), /binding mismatch/);
});

test("foreground output cannot forge authoritative domain UI", () => {
  assert.throws(() => parseForegroundTeachingOutput({
    schema_version: 3,
    conversation_thread_id: binding.conversationThreadId,
    foreground_epoch_id: binding.foregroundEpochId,
    reply_to_message_id: binding.replyToMessageId,
    parts: [{ type: "domain_ui", part: { view_kind: "judgment" } }],
  }, binding), /cannot contain authoritative domain UI/);
});

test("learning_action rejects authority fields and scientific writes", () => {
  assert.deepEqual(parseBoundedLearningAction({
    action: "request_cut",
    reason: "student_switch",
  }), { action: "request_cut", reason: "student_switch" });
  assert.throws(() => parseBoundedLearningAction({
    action: "request_cut",
    reason: "student_switch",
    tenant_id: "tnt_other0001",
  }), /unsupported fields/);
  assert.throws(() => parseBoundedLearningAction({ action: "set_mastery", value: 1 }), /not allowed/);
});
