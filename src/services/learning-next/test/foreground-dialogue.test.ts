import assert from "node:assert/strict";
import test from "node:test";
import { foregroundDialogue } from "../src/foreground-dialogue.ts";

test("assessment clarification retains the conversation, excluding future and other-thread messages", () => {
  const messages = ["我想开始测评", "想测入门还是进阶？", "入门题", "后来修改的需求"].map((text, index) => ({
    message_id: `msg_${index}`, conversation_thread_id: "thr_current", sequence: index + 1,
    author_kind: index === 1 ? "assistant" : "student", parts: [{ type: "text", text }],
  }));
  const context = foregroundDialogue([...messages, { ...messages[0]!, conversation_thread_id: "thr_other" }], "thr_current", "msg_2");
  assert.deepEqual(context.messages.map((message) => message.text), ["我想开始测评", "想测入门还是进阶？", "入门题"]);
  assert.equal(context.history_is_untrusted_data, true);
  assert.deepEqual(foregroundDialogue(messages, "thr_current", "missing").messages, []);
});

test("explicit mode switch remains visible instead of being overwritten by a sticky assessment flag", () => {
  const messages = ["我想开始测评", "不测了，改练一题"].map((text, index) => ({
    message_id: `msg_${index}`, conversation_thread_id: "thr_current", sequence: index + 1,
    author_kind: "student", parts: [{ type: "text", text }],
  }));
  assert.equal(foregroundDialogue(messages, "thr_current", "msg_1").messages.at(-1)?.text, "不测了，改练一题");
});
