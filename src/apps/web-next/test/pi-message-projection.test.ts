import assert from "node:assert/strict";
import test from "node:test";
import { projectPiThreadMessages } from "../node_modules/@assistant-ui/react-pi/src/runtime/messageProjection.ts";
import { canonicalMessageProjector } from "../src/learning/runtime/canonical-message-projector";

const canonicalDetails = (schema: "mathpilot.canonical-message/v1" | "mathpilot.canonical-link/v1") => ({
  schema,
  message_id: "msg_canonical001",
  author_kind: "assistant",
  created_at: "2026-09-02T08:00:00.000Z",
  digest: "a".repeat(64),
  parts: [
    { type: "text", text: "正式讲解" },
    {
      type: "domain_ui",
      part: {
        schema: "mathpilot.message-part/domain-ui/v1",
        part_id: "part_domain_001",
        view_kind: "question",
        resource_ref: "question-session:q1",
        resource_version: 0,
        snapshot: {
          schema: "mathpilot.view/question/v1",
          title: "题目",
          summary: "题目",
          data: {},
        },
        action_slots: [],
        occurred_at: "2026-09-02T08:00:00.000Z",
        origin: "domain_projector",
        domain_event_ref: "domain-event:question-1",
      },
    },
    {
      type: "teaching_artifact",
      artifact_ref: "artifact:derivation-1",
      artifact_schema: "https://schemas.mathpilot.dev/science-v3/teaching-artifact-math-derivation/v1",
      summary: "推导",
    },
    {
      type: "attachment",
      attachment_ref: "storage-object:obj_canonical1",
      name: "讲义.pdf",
      mime_type: "application/pdf",
      version_id: "ver_canonical_001",
      sha256: "b".repeat(64),
      byte_size: 42,
    },
  ],
});

const piAssistant = (text: string, timestamp: number) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude",
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp,
});

test("react-pi projects strict canonical custom messages without replacing its stream reducer", () => {
  const messages = projectPiThreadMessages({
    messages: [{
      role: "custom",
      customType: "mathpilot.canonical-message/v1",
      content: "",
      display: true,
      details: canonicalDetails("mathpilot.canonical-message/v1"),
      timestamp: 1,
    }] as never,
    toolExecutions: {},
    runStatus: "idle",
    hostUiRequests: [],
    customMessageProjector: canonicalMessageProjector,
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.id, "canonical:msg_canonical001");
  assert.equal(messages[0]?.role, "assistant");
  assert.deepEqual(messages[0]?.content, [
    { type: "text", text: "正式讲解" },
    {
      type: "data",
      name: "mathpilot-domain-ui",
      data: canonicalDetails("mathpilot.canonical-message/v1").parts[1]!.part,
    },
    {
      type: "data",
      name: "mathpilot-teaching-artifact",
      data: canonicalDetails("mathpilot.canonical-message/v1").parts[2],
    },
    {
      type: "file",
      data: "storage-object:obj_canonical1",
      filename: "讲义.pdf",
      mimeType: "application/pdf",
      sourceType: "id",
    },
  ]);
});

test("a hidden canonical link appends only canonical-only parts to the preceding matching Pi turn", () => {
  const link = canonicalDetails("mathpilot.canonical-link/v1");
  link.author_kind = "student";
  link.parts = [
    { type: "text", text: "我选择 A" },
    link.parts[1]!,
    link.parts[3]!,
  ];
  const messages = projectPiThreadMessages({
    messages: [
      { role: "user", content: "我选择 A", timestamp: 1 },
      piAssistant("收到，我来判定。", 2),
      {
        role: "custom",
        customType: "mathpilot.canonical-link/v1",
        content: "",
        display: false,
        details: link,
        timestamp: 3,
      },
    ] as never,
    toolExecutions: {},
    runStatus: "idle",
    hostUiRequests: [],
    customMessageProjector: canonicalMessageProjector,
  });

  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0]?.content, [
    { type: "text", text: "我选择 A" },
    {
      type: "data",
      name: "mathpilot-domain-ui",
      data: link.parts[1]!.part,
    },
  ]);
  assert.equal(messages[0]?.attachments?.[0]?.name, "讲义.pdf");
});

test("a hidden assistant canonical link finds the preceding assistant turn after a user reply", () => {
  const link = canonicalDetails("mathpilot.canonical-link/v1");
  const messages = projectPiThreadMessages({
    messages: [
      piAssistant("先观察图像。", 1),
      { role: "user", content: "好的", timestamp: 2 },
      {
        role: "custom",
        customType: "mathpilot.canonical-link/v1",
        content: "",
        display: false,
        details: link,
        timestamp: 3,
      },
    ] as never,
    toolExecutions: {},
    runStatus: "idle",
    hostUiRequests: [],
    customMessageProjector: canonicalMessageProjector,
  });

  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, "assistant");
  assert.deepEqual(messages[0]?.content, [
    { type: "text", text: "先观察图像。", parentId: "pi-step:0" },
    {
      type: "data",
      name: "mathpilot-domain-ui",
      data: link.parts[1]!.part,
    },
    {
      type: "data",
      name: "mathpilot-teaching-artifact",
      data: link.parts[2],
    },
    {
      type: "file",
      data: "storage-object:obj_canonical1",
      filename: "讲义.pdf",
      mimeType: "application/pdf",
      sourceType: "id",
    },
  ]);
  assert.equal(messages[1]?.role, "user");
  assert.deepEqual(messages[1]?.content, [{ type: "text", text: "好的" }]);
});

test("malformed canonical custom messages retain the official generic/hidden behavior", () => {
  const messages = projectPiThreadMessages({
    messages: [
      {
        role: "custom",
        customType: "mathpilot.canonical-message/v1",
        content: "untrusted visible custom",
        display: true,
        details: { author_kind: "student", parts: [] },
        timestamp: 1,
      },
      {
        role: "custom",
        customType: "mathpilot.canonical-link/v1",
        content: "",
        display: false,
        details: { author_kind: "student", parts: [] },
        timestamp: 2,
      },
    ] as never,
    toolExecutions: {},
    runStatus: "idle",
    hostUiRequests: [],
    customMessageProjector: canonicalMessageProjector,
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, "assistant");
  assert.equal((messages[0]?.content as readonly { name?: string }[])[0]?.name, "pi-custom-message");
});
