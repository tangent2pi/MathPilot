import assert from "node:assert/strict";
import test from "node:test";
import { objectContentDisposition } from "../src/object-store.ts";

test("safe image rendering and explicit file download use different dispositions", () => {
  assert.equal(objectContentDisposition("inline", "avatar.webp", "image/webp"), 'inline; filename="avatar.webp"');
  assert.equal(objectContentDisposition("attachment", "notes.md", "text/markdown"), 'attachment; filename="notes.md"');
});

test("canonical WebP bytes are never advertised with the source image extension", () => {
  assert.equal(objectContentDisposition("inline", "avatar.jpg", "image/webp"), 'inline; filename="avatar.webp"');
  assert.equal(objectContentDisposition("attachment", "photo.png", "image/webp"), 'attachment; filename="photo.webp"');
});

test("the RFC 6266 codec encodes Unicode and cannot inject another header", () => {
  const unicode = objectContentDisposition("inline", "数学头像.jpg", "image/webp");
  assert.match(unicode, /^inline; /);
  assert.match(unicode, /\.webp/);
  assert.match(unicode, /filename\*=UTF-8''/);

  const injected = objectContentDisposition("attachment", 'answer"\r\nX-Test: bad.png', "image/webp");
  assert.match(injected, /^attachment; /);
  assert.doesNotMatch(injected, /[\r\n]/);
  assert.match(injected, /%0D%0A/);
  assert.match(injected, /\.webp/);
});
