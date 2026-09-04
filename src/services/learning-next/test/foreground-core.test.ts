import assert from "node:assert/strict";
import test from "node:test";
import {
  foregroundTeachingOutputFromAgentMessages,
  parseBoundedLearningAction,
  parseForegroundTeachingOutput,
} from "../src/foreground-core.ts";

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

test("foreground output is host-built from the final completed assistant reply", () => {
  const output = foregroundTeachingOutputFromAgentMessages([
    { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "先检查一下" }, { type: "toolCall" }] },
    { role: "toolResult", content: [{ type: "text", text: "done" }] },
    {
      role: "assistant",
      stopReason: "stop",
      content: [
        { type: "thinking", thinking: "内部推理" },
        { type: "text", text: "最终" },
        { type: "text", text: "回复" },
      ],
    },
  ], binding, [{
    type: "teaching_artifact",
    artifact_ref: "agent-artifact:art_12345678",
    artifact_schema: "mathpilot.teaching-artifact/math-derivation/v1",
    summary: "推导过程",
  }]);

  assert.deepEqual(output.parts, [
    { type: "text", text: "最终回复" },
    {
      type: "teaching_artifact",
      artifact_ref: "agent-artifact:art_12345678",
      artifact_schema: "mathpilot.teaching-artifact/math-derivation/v1",
      summary: "推导过程",
    },
  ]);
});

test("foreground host finalizer rejects missing or empty final replies", () => {
  assert.throws(
    () => foregroundTeachingOutputFromAgentMessages([
      { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall" }] },
    ], binding),
    /without a completed assistant reply/,
  );
  assert.throws(
    () => foregroundTeachingOutputFromAgentMessages([
      { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "only thinking" }] },
    ], binding),
    /no visible text/,
  );
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

test("learning_action accepts only the validated math derivation artifact", () => {
  assert.deepEqual(parseBoundedLearningAction({
    action: "present_validated_artifact",
    artifact_schema: "mathpilot.teaching-artifact/math-derivation/v1",
    summary: "逐步配方求解。",
    content: {
      schema: "mathpilot.teaching-artifact/math-derivation/v1",
      label: "配方法",
      steps: [
        { expression: "x^2+6x+5=0" },
        { expression: "(x+3)^2=4", note: "两边同时补 9" },
      ],
    },
  }), {
    action: "present_validated_artifact",
    artifact_schema: "mathpilot.teaching-artifact/math-derivation/v1",
    summary: "逐步配方求解。",
    content: {
      schema: "mathpilot.teaching-artifact/math-derivation/v1",
      label: "配方法",
      steps: [
        { expression: "x^2+6x+5=0" },
        { expression: "(x+3)^2=4", note: "两边同时补 9" },
      ],
    },
  });
  assert.throws(() => parseBoundedLearningAction({
    action: "present_validated_artifact",
    artifact_schema: "mathpilot.teaching-artifact/arbitrary/v1",
    summary: "任意内容",
    content: { html: "<script>bad()</script>" },
  }), /artifact_schema is invalid/);
  assert.throws(() => parseBoundedLearningAction({
    action: "present_validated_artifact",
    artifact_schema: "mathpilot.teaching-artifact/math-derivation/v1",
    summary: "夹带科学状态",
    content: {
      schema: "mathpilot.teaching-artifact/math-derivation/v1",
      steps: [{ expression: "x=1", mastery: 1 }],
    },
  }), /unsupported fields/);
});
