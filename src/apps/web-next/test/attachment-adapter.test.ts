import assert from "node:assert/strict";
import { File } from "node:buffer";
import test from "node:test";
import type { PendingAttachment } from "@assistant-ui/react";
import type { ImmutableObjectDescriptor } from "@mathpilot/content-integrity";
import { UnifiedAttachmentAdapter } from "../src/AttachmentAdapter";

const descriptor = (suffix: string): ImmutableObjectDescriptor => ({
  object_id: `obj_${suffix}`,
  object_ref: `storage-object:obj_${suffix}`,
  version_id: `version-${suffix}`,
  sha256: "a".repeat(64),
  byte_size: 1,
  mime_type: "text/plain",
  original_name: `${suffix}.txt`,
  source: {
    version_id: `source-${suffix}`,
    sha256: "b".repeat(64),
    byte_size: 1,
    mime_type: "text/plain",
  },
  expires_at: null,
});

const pending = (id: string, name = `${id}.txt`): PendingAttachment => ({
  id,
  type: "document",
  name,
  contentType: "text/plain",
  file: new File(["x"], name, { type: "text/plain" }),
  status: { type: "requires-action", reason: "composer-send" },
});

test("reuses one in-flight and completed upload for the same attachment id", async () => {
  let uploadCount = 0;
  const adapter = new UnifiedAttachmentAdapter({
    upload: async () => {
      uploadCount += 1;
      return descriptor("samefile");
    },
    remove: async () => undefined,
  });
  const attachment = pending("attachment-1");

  const [first, concurrent] = await Promise.all([
    adapter.send(attachment),
    adapter.send(attachment),
  ]);
  const retry = await adapter.send(attachment);

  assert.equal(uploadCount, 1);
  assert.equal(first.content[0]?.type, "file");
  assert.deepEqual(concurrent.content, first.content);
  assert.deepEqual(retry.content, first.content);
});

test("a successful sibling is not uploaded again after another attachment fails", async () => {
  const counts = new Map<string, number>();
  const adapter = new UnifiedAttachmentAdapter({
    upload: async (file) => {
      counts.set(file.name, (counts.get(file.name) ?? 0) + 1);
      if (file.name === "bad.txt") throw new Error("rejected");
      return descriptor("goodfile");
    },
    remove: async () => undefined,
  });
  const good = pending("good", "good.txt");
  const bad = pending("bad", "bad.txt");

  const results = await Promise.allSettled([adapter.send(good), adapter.send(bad)]);
  assert.equal(results[0]?.status, "fulfilled");
  assert.equal(results[1]?.status, "rejected");

  await adapter.send(good);
  await assert.rejects(adapter.send(bad), /rejected/);
  assert.equal(counts.get("good.txt"), 1);
  assert.equal(counts.get("bad.txt"), 2);
});

test("remove aborts an in-flight upload and deletes a late successful object", async () => {
  let signal: AbortSignal | undefined;
  let settleUpload: ((value: ImmutableObjectDescriptor) => void) | undefined;
  const removed: string[] = [];
  const adapter = new UnifiedAttachmentAdapter({
    upload: (_file, _purpose, options) => {
      signal = options?.signal;
      return new Promise((resolve) => { settleUpload = resolve; });
    },
    remove: async (objectId) => { removed.push(objectId); },
  });
  const attachment = pending("attachment-remove");
  const sending = adapter.send(attachment);

  const removing = adapter.remove(attachment);
  assert.equal(signal?.aborted, true);
  settleUpload?.(descriptor("latefile"));
  await sending;
  await removing;

  assert.deepEqual(removed, ["obj_latefile"]);
});

test("a failed Pi gateway turn restores the same immutable attachment for retry", async () => {
  const adapter = new UnifiedAttachmentAdapter({
    upload: async () => descriptor("pi-turn"),
    remove: async () => undefined,
  });
  const attachment = pending("pi-turn");
  await adapter.send(attachment);

  const firstClaim = adapter.claimForPiTurn();
  assert.deepEqual(firstClaim, [{ ...descriptor("pi-turn"), attachment_id: "pi-turn" }]);
  assert.deepEqual(adapter.claimForPiTurn(), []);

  adapter.restorePiTurn(firstClaim);
  const retryClaim = adapter.claimForPiTurn();
  assert.deepEqual(retryClaim, firstClaim);
  adapter.markPiTurnAccepted(retryClaim);
  assert.deepEqual(adapter.claimForPiTurn(), []);
});
