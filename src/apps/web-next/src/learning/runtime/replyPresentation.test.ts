import assert from "node:assert/strict";
import test from "node:test";
import { mergeReplyPresentations } from "./replyPresentation";

const message = (id: string, content: any[]) => ({ id, role: "assistant", createdAt: new Date(0), content }) as any;
const reply = message("reply", [{ type: "text", text: "准备题目" }]);
const status = message("operation:selection", [{ type: "data", name: "mathpilot-operation-status", data: {} }]);
const card = message("card", [{ type: "data", name: "mathpilot-domain-ui", data: { question: true } }]);
const canonical = [
  { message_id: "reply", author_kind: "assistant", reply_to_message_id: "student" },
  { message_id: "card", author_kind: "system", parts: [{ type: "domain_ui", part: { view_kind: "question", resource_ref: "question-session:question", snapshot: { data: { selection_intent_id: "intent" } } } }] },
] as any;
const operations = [{ operation_id: "selection", kind: "select_question", related_resource_refs: ["selection-intent:intent"] }] as any;
const links = [{ resource_ref: "selection-intent:intent", foreground_operation_id: "foreground", triggering_message_id: "student" }];

test("reply, loading status, and question become one reply; canonical data stays intact", () => {
  const result = mergeReplyPresentations([reply, status, card], canonical, operations, links);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.id, "reply");
  assert.deepEqual(result[0]?.content, [...reply.content, ...card.content]);
  assert.equal(reply.content.length, 1);
});
test("pending or failed selection is inline; live streaming keeps its bubble ID", () => {
  const live = { ...reply, id: "delta:foreground" };
  const result = mergeReplyPresentations([live, status], canonical.slice(0, 1), operations, links);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.id, "delta:foreground");
  assert.equal(result[0]?.content.length, 2);
});
test("old published card merges even when its operation is outside the recent window", () => {
  assert.equal(mergeReplyPresentations([reply, card], canonical, [], links).length, 1);
});
test("completed operation refs point to the resulting question, not the original intent", () => {
  const completed = [{ ...operations[0], related_resource_refs: ["question-session:question", "message:card"] }];
  assert.equal(mergeReplyPresentations([reply, status, card], canonical, completed, links).length, 1);
});
test("unlinked cards never attach to an unrelated reply; their redundant status still disappears", () => {
  assert.deepEqual(mergeReplyPresentations([reply, status, card], canonical, operations, []).map((item) => item.id), ["reply", "card"]);
});
