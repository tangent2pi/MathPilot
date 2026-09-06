import assert from "node:assert/strict";
import test from "node:test";
import { teacherTranscript, teacherUserPresentation } from "./teacherTranscript";

const userText = "我想提取这个题库";
const envelope = `${userText}\n\n本次消息附带文件：\n- input/original/obj_99dbe936af6a413b8d2a_05一些定理或模型问题.pdf（原名：05一些定理或模型问题.pdf；MIME：application/pdf；2075726 字节；SHA-256：3ddd28cac28b…）\n这是教师资料导入。除非教师明确要求只阅读或讲解，否则读取 ktq-extraction Skill，从这些文件抽取知识点、题型和题目，执行校验，并调用 respond 注册候选集；不能只口头承诺稍后抽取。不要自行生成来源中不存在的题目。后续入库由宿主推进。\n请全程使用简体中文回复。`;

test("host import prompt displays original words and file tile, live and after reload", () => {
  const message = { role: "user", content: envelope };
  for (const running of [true, false]) {
    const [display] = teacherTranscript(JSON.parse(JSON.stringify([message])), "thr_upload", running);
    assert.equal((display?.content[0] as any).text, userText);
    assert.equal((display as any).attachments[0].name, "05一些定理或模型问题.pdf");
    assert.equal((display as any).attachments[0].content[0].data, "storage-object:obj_99dbe936af6a413b8d2a");
    assert.ok(!JSON.stringify(display).includes("ktq-extraction"));
  }
  assert.equal(message.content, envelope);
});

test("ordinary messages and similar user-authored text are never truncated", () => {
  for (const text of [userText, "说明：\n\n本次消息附带文件：\n这是我自己写的内容", envelope + "\n继续补充需求"]) {
    assert.deepEqual(teacherUserPresentation(text), { text, attachments: [] });
  }
});

test("durable thoughts, tools and final answer render as one assistant reply", () => {
  const saved = JSON.parse(JSON.stringify([
    { role: "user", content: "抽取资料", timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: "读取来源" }, { type: "toolCall", id: "call1", name: "read" }], timestamp: 2 },
    { role: "toolResult", toolCallId: "call1", content: [{ type: "text", text: "private raw data" }], timestamp: 3 },
    { role: "assistant", content: [{ type: "text", text: "完成" }], timestamp: 4 },
  ]));
  const view = teacherTranscript(saved, "thr_test");
  assert.equal(view.length, 2);
  assert.deepEqual(view[1]?.content.map(part => part.type), ["reasoning", "tool-call", "text"]);
  assert.equal((view[1]?.content[0] as any).text, "读取来源");
  assert.ok(!JSON.stringify(view).includes("private raw data"));
  assert.equal((teacherTranscript(saved, "thr_test", true)[1] as any)?.status.type, "running");
});

test("missing tool result is never rendered as successful", () => {
  const view = teacherTranscript([{ role: "assistant", content: [{ type: "toolCall", id: "missing", name: "bash" }] }], "thr_test");
  assert.equal((view[0]?.content[0] as any).result.status, "interrupted");
});

test("review card follows the final reply, never interrupts a running response", () => {
  const saved = [
    { role: "user", content: "抽取" },
    { role: "assistant", content: [{ type: "toolCall", id: "registration", name: "respond" }] },
    { role: "toolResult", toolCallId: "registration", content: [{ type: "text", text: JSON.stringify({ schema: "mathpilot.content-respond/v1", candidate_set_id: "cset_test" }) }] },
    { role: "assistant", content: [{ type: "text", text: "已抽取，请审核。" }] },
  ];
  const live = teacherTranscript(saved, "thr_review", true);
  assert.equal(live.length, 2);
  assert.ok(!live[1]?.content.some(part => part.type === "data"));
  const complete = teacherTranscript(saved, "thr_review", false);
  assert.deepEqual(complete[1]?.content.map(part => part.type), ["text", "data"]);
  assert.equal((complete[1]?.content.at(-1) as any).data.candidateSetId, "cset_test");
});
