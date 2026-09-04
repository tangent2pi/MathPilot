import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_MIRROR_DETAILS_SCHEMA,
  CANONICAL_MIRROR_MESSAGE_SCHEMA,
  parseCanonicalMirrorDetails,
  parseCanonicalMirrorMessage,
} from "../src/index.ts";
import { Value } from "typebox/value";

const message = {
  message_id: "msg_abcdefgh",
  author_kind: "assistant",
  created_at: "2026-09-02T00:00:00.000Z",
  parts: [{ type: "text", text: "答案" }],
  digest: "a".repeat(64),
  reply_to_message_id: "msg_ijklmnop",
} as const;

test("canonical mirror message is a strict object and parser clones it", () => {
  assert.equal(CANONICAL_MIRROR_MESSAGE_SCHEMA.type, "object");
  assert.equal(CANONICAL_MIRROR_MESSAGE_SCHEMA.additionalProperties, false);
  assert.equal(Value.Check(CANONICAL_MIRROR_MESSAGE_SCHEMA, message), true);
  const parsed = parseCanonicalMirrorMessage(message);
  assert.deepEqual(parsed, message);
  assert.notEqual(parsed, message);
  assert.notEqual(parsed.parts, message.parts);
});

test("canonical mirror rejects extra fields in messages and parts", () => {
  assert.equal(Value.Check(CANONICAL_MIRROR_MESSAGE_SCHEMA, {
    ...message, unexpected: true,
  }), false);
  assert.throws(() => parseCanonicalMirrorMessage({
    ...message, parts: [{ type: "text", text: "x", unexpected: true }],
  }), /invalid/);
});

test("canonical mirror details strictly distinguish message and link markers", () => {
  const { reply_to_message_id: _replyToMessageId, ...messageDetails } = message;
  const visible = { schema: "mathpilot.canonical-message/v1", ...messageDetails };
  const link = { schema: "mathpilot.canonical-link/v1", ...messageDetails };
  assert.equal(Value.Check(CANONICAL_MIRROR_DETAILS_SCHEMA, visible), true);
  assert.equal(Value.Check(CANONICAL_MIRROR_DETAILS_SCHEMA, link), true);
  assert.deepEqual(parseCanonicalMirrorDetails(visible), visible);
  assert.deepEqual(parseCanonicalMirrorDetails(link), link);
  assert.equal(Value.Check(CANONICAL_MIRROR_DETAILS_SCHEMA, message), false);
  assert.equal(Value.Check(CANONICAL_MIRROR_DETAILS_SCHEMA, { ...visible, reply_to_message_id: message.reply_to_message_id }), false);
});
