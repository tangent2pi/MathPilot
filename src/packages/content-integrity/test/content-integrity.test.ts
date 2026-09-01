import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import sharp from "sharp";
import { CONTENT_POLICIES } from "../src/policy.ts";
import {
  canonicalJson,
  identifyImageBytes,
  materializeVerified,
  resolveAndMaterializeObjects,
  sealContent,
} from "../src/node.ts";
import { publishStorageObject } from "../src/publication.ts";

test("canonical JSON has one digest independent of object insertion order", () => {
  assert.deepEqual(canonicalJson({ z: 2, a: [1, true] }), canonicalJson({ a: [1, true], z: 2 }));
});

test("candidate JSON seals to RFC 8785 bytes while retaining raw-source provenance", async () => {
  const source=Buffer.from('{ "z": 2, "a": [1, true] }\n',"utf8");
  const sealed=await sealContent(Readable.from(source),CONTENT_POLICIES.candidate,{
    declaredMimeType:"application/json",expectedBytes:source.byteLength,
  });
  try {
    const expected=canonicalJson({ a:[1,true],z:2 });
    assert.equal((await readFile(sealed.storedPath,"utf8")),expected.json);
    assert.equal(sealed.stored.sha256,expected.sha256);
    assert.notEqual(sealed.source.sha256,sealed.stored.sha256);
  } finally {
    await sealed.cleanup();
  }
});

test("strict image sealing decodes and normalizes source bytes to metadata-free WebP", async () => {
  const source = await sharp({ create: { width: 16, height: 12, channels: 4, background: "#2f6feb" } }).png().toBuffer();
  const sealed = await sealContent(Readable.from(source), CONTENT_POLICIES.avatar, {
    declaredMimeType: "image/png",
    expectedBytes: source.byteLength,
  });
  try {
    const stored = await readFile(sealed.storedPath);
    assert.equal(sealed.source.mimeType, "image/png");
    assert.equal(sealed.stored.mimeType, "image/webp");
    assert.equal(await identifyImageBytes(stored), "image/webp");
  } finally {
    await sealed.cleanup();
  }
});

test("verified materialization is bounded, hash checked, and atomically visible", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mathpilot-materialize-"));
  const bytes = Buffer.from("{\"safe\":true}", "utf8");
  const sealed = await sealContent(Readable.from(bytes), CONTENT_POLICIES.candidate, {
    declaredMimeType: "application/json",
    expectedBytes: bytes.byteLength,
  });
  const target = path.join(root, "audit.json");
  try {
    await materializeVerified(createReadStream(sealed.storedPath), {
      byte_size: sealed.stored.byteSize,
      sha256: sealed.stored.sha256,
      mime_type: sealed.stored.mimeType,
    }, target);
    assert.deepEqual(await readFile(target), bytes);
    await assert.rejects(materializeVerified(Readable.from(Buffer.from("wrong")), {
      byte_size: sealed.stored.byteSize,
      sha256: sealed.stored.sha256,
      mime_type: sealed.stored.mimeType,
    }, path.join(root, "bad.json")), /immutable descriptor|exceeds/);
  } finally {
    await Promise.all([sealed.cleanup(), rm(root, { recursive: true, force: true })]);
  }
});

test("bounded stream capture cancels a stalled producer when its request aborts", async () => {
  const controller = new AbortController();
  let returned = false;
  const stalled: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
        return: async () => {
          returned = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
  setImmediate(() => controller.abort());
  await assert.rejects(
    sealContent(stalled, CONTENT_POLICIES.candidate, {
      declaredMimeType: "application/json",
      signal: controller.signal,
    }),
    /aborted/,
  );
  assert.equal(returned, true);
});

test("object projection rejects its aggregate budget before resolving Storage", async () => {
  const descriptor = (objectId: string) => ({
    object_id: objectId,
    object_ref: `storage-object:${objectId}`,
    version_id: `version-${objectId}`,
    sha256: "a".repeat(64),
    byte_size: 10,
    mime_type: "text/plain",
    original_name: `${objectId}.txt`,
    source: {
      version_id: `source-${objectId}`,
      sha256: "a".repeat(64),
      byte_size: 10,
      mime_type: "text/plain",
    },
    expires_at: null,
  });
  let resolved = false;
  await assert.rejects(resolveAndMaterializeObjects({
    objects: [
      { descriptor: descriptor("obj_budget01"), destination: "/unused/one" },
      { descriptor: descriptor("obj_budget02"), destination: "/unused/two" },
    ],
    maximumAggregateBytes: 15,
    signal: AbortSignal.timeout(1000),
    async resolve() {
      resolved = true;
      throw new Error("resolve must not run");
    },
  }), /exceeds 15 bytes/);
  assert.equal(resolved, false);
});

test("shared publication validates sealed bytes and removes an unclaimed mismatch", async () => {
  const calls: string[] = [];
  await assert.rejects(publishStorageObject({
    request:{ purpose:"candidate",original_name:"result.json",mime_type:"application/json",byte_size:2 },
    expectedStored:{ sha256:"a".repeat(64),byteSize:2,mimeType:"application/json" },
    adapter:{
      async initialize() {
        calls.push("init");
        return { object_id:"obj_publish01",expires_at:new Date(Date.now()+60_000).toISOString(),
          upload:{ method:"POST",url:"https://objects.example/upload",fields:{} } };
      },
      async upload() { calls.push("upload"); },
      async complete() {
        calls.push("complete");
        return { object_id:"obj_publish01",object_ref:"storage-object:obj_publish01",version_id:"v1",
          sha256:"b".repeat(64),byte_size:2,mime_type:"application/json",original_name:"result.json",
          source:{ version_id:"s1",sha256:"c".repeat(64),byte_size:2,mime_type:"application/json" },expires_at:null };
      },
      async removeUnclaimed() { calls.push("cleanup"); },
    },
  }), /differs from the sealed bytes/);
  assert.deepEqual(calls,["init","upload","complete","cleanup"]);
});
