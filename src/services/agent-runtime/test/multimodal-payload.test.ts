import assert from "node:assert/strict";
import test from "node:test";
import { governMultimodalProviderPayload } from "../src/multimodal-payload.ts";

const image = (id: string, size = 16) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${id.padEnd(size, id)}` } });
const toolImages = (...parts: unknown[]) => ({
  role: "user",
  content: [{ type: "text", text: "Attached image(s) from tool result:" }, ...parts],
});

test("leaves ordinary user images and small tool history unchanged", () => {
  const payload = {
    messages: [
      { role: "user", content: [{ type: "text", text: "我的题图" }, image("student")] },
      toolImages(image("tool")),
    ],
  };
  const result = governMultimodalProviderPayload(payload);
  assert.equal(result.changed, false);
  assert.equal(result.payload, payload);
});

test("keeps the newest tool previews within one cumulative budget", () => {
  const first = toolImages(image("old-1"), image("old-2"), image("old-3"));
  const latest = toolImages(image("new-1"), image("new-2"), image("new-3"));
  const payload = { messages: [{ role: "tool", content: "OCR text remains" }, first, latest] };
  const result = governMultimodalProviderPayload(payload, { maxImages: 4, maxDataUrlChars: 10_000 });
  const next = result.payload as typeof payload;

  assert.equal(result.changed, true);
  assert.equal(result.keptToolImages, 4);
  assert.equal(result.omittedToolImages, 2);
  assert.equal(next.messages[0], payload.messages[0]);
  assert.match(JSON.stringify(next.messages[1]), /old-1/);
  assert.doesNotMatch(JSON.stringify(next.messages[1]), /old-2|old-3/);
  assert.match(JSON.stringify(next.messages[2]), /new-1/);
  assert.match(JSON.stringify(next.messages[2]), /new-2/);
  assert.match(JSON.stringify(next.messages[2]), /new-3/);
  assert.match(JSON.stringify(next.messages), /page range of at most 4 pages/);
  assert.equal(first.content.length, 4, "input payload must not be mutated");
});

test("omits an oversized tool image instead of exceeding the byte budget", () => {
  const payload = { messages: [toolImages(image("huge", 200))] };
  const result = governMultimodalProviderPayload(payload, { maxImages: 4, maxDataUrlChars: 80 });
  assert.equal(result.keptToolImages, 0);
  assert.equal(result.omittedToolImages, 1);
  assert.equal(result.keptDataUrlChars, 0);
  assert.doesNotMatch(JSON.stringify(result.payload), /base64/);
});

test("returns non-OpenAI payloads unchanged", () => {
  const payload = { input: "hello" };
  const result = governMultimodalProviderPayload(payload);
  assert.equal(result.payload, payload);
  assert.equal(result.changed, false);
});
