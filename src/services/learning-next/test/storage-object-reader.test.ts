import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createInternalServiceRuntime, type InternalServiceRuntime } from "@mathpilot/internal-service";
import { internalServiceTestEnvironment } from "@mathpilot/internal-service/testing";
import { StorageNextObjectReader } from "../src/storage-object-reader.ts";

test("learning-next reads a frozen object through its signed storage edge and the presigned data plane", async () => {
  const content = Buffer.from("authorized vision attachment", "utf8");
  const digest = createHash("sha256").update(content).digest("hex");
  const object = {
    path: "attachments/problem.txt",
    descriptor: {
      object_id: "obj_abcdefgh",
      object_ref: "storage-object:obj_abcdefgh",
      version_id: "canonical-version-1",
      mime_type: "text/plain",
      byte_size: content.byteLength,
      sha256: digest,
      original_name: "problem.txt",
      source: {
        version_id: "source-version-1",
        mime_type: "text/plain",
        byte_size: content.byteLength,
        sha256: digest,
      },
      expires_at: null,
    },
  };
  const actor = Object.freeze({
    tenantId: "tnt_primary01",
    userId: "usr_student01",
    roles: ["student"] as const,
  });
  const receiver = createInternalServiceRuntime(
    "storage-next",
    internalServiceTestEnvironment(),
  );
  let serverFailure: unknown;
  let downloadUrl = "";
  let assertedActor: unknown;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url === "/download/obj_abcdefgh") {
        response.statusCode = 200;
        response.end(content);
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      assert.equal(request.url, "/internal/objects/resolve");
      assert.equal(request.headers["x-mathpilot-runtime-secret"], undefined);
      assert.equal(request.headers["x-tenant-id"], undefined);
      assert.equal(request.headers["x-user-id"], undefined);
      assert.equal(request.headers["x-user-roles"], undefined);
      const context = await receiver.authenticate(
        ["learning-to-storage"],
        request.headers.authorization,
        { method: request.method!, path: request.url!, body },
      );
      assertedActor = context.actor;
      assert.deepEqual(body, { object_refs: [object.descriptor.object_ref] });
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        objects: [{
          ...object.descriptor,
          download: {
            url: downloadUrl,
            expires_at: "2026-09-01T12:00:00.000Z",
          },
        }],
      }));
    })().catch((error) => {
      serverFailure = error;
      response.statusCode = 500;
      response.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  downloadUrl = `${baseUrl}/download/obj_abcdefgh`;
  const caller = createInternalServiceRuntime("learning-next", internalServiceTestEnvironment({
    MATHPILOT_INTERNAL_STORAGE_URL: baseUrl,
  }));
  const reader = new StorageNextObjectReader(caller);
  const directory = await mkdtemp(path.join(os.tmpdir(), "mathpilot-storage-reader-test-"));
  const destination = path.join(directory, "problem.txt");

  try {
    await reader.materialize({
      tenantId: actor.tenantId,
      accountUserId: actor.userId,
      roles: actor.roles,
      objects: [{ object, destination }],
      signal: new AbortController().signal,
    });
    if (serverFailure) throw serverFailure;
    assert.deepEqual(await readFile(destination), content);
    assert.deepEqual(assertedActor, actor);
  } finally {
    await rm(directory, { recursive: true, force: true });
    server.close();
    await once(server, "close");
  }
});

test("learning-next rejects descriptor drift before download and cancels mismatched bodies", async () => {
  const content = Buffer.from("frozen", "utf8");
  const digest = createHash("sha256").update(content).digest("hex");
  const object = {
    path: "attachments/frozen.txt",
    descriptor: {
      object_id: "obj_frozen001",
      object_ref: "storage-object:obj_frozen001",
      version_id: "version-1",
      sha256: digest,
      byte_size: content.byteLength,
      mime_type: "text/plain",
      original_name: "frozen.txt",
      source: {
        version_id: "source-version-1",
        sha256: digest,
        byte_size: content.byteLength,
        mime_type: "text/plain",
      },
      expires_at: null,
    },
  };
  let resolvedExpiresAt: string | null = "2026-09-01T12:00:00.000Z";
  const runtime = {
    request: async () => new Response(JSON.stringify({
      objects: [{
        ...object.descriptor,
        expires_at: resolvedExpiresAt,
        download: {
          url: "https://storage.invalid/object",
          expires_at: "2026-09-01T12:00:00.000Z",
        },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  } as unknown as InternalServiceRuntime;
  const reader = new StorageNextObjectReader(runtime);
  const directory = await mkdtemp(path.join(os.tmpdir(), "mathpilot-storage-reader-drift-"));
  const originalFetch = globalThis.fetch;
  let downloadStarted = false;
  try {
    globalThis.fetch = (async () => {
      downloadStarted = true;
      throw new Error("descriptor drift must fail before download");
    }) as typeof fetch;
    await assert.rejects(reader.materialize({
      tenantId: "tnt_primary01",
      accountUserId: "usr_student01",
      roles: ["student"],
      objects: [{ object, destination: path.join(directory, "drift.txt") }],
      signal: new AbortController().signal,
    }), /metadata does not match/);
    assert.equal(downloadStarted, false);

    resolvedExpiresAt = null;
    let bodyCancelled = false;
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      cancel() { bodyCancelled = true; },
    }), {
      status: 200,
      headers: { "content-length": String(content.byteLength + 1) },
    })) as typeof fetch;
    await assert.rejects(reader.materialize({
      tenantId: "tnt_primary01",
      accountUserId: "usr_student01",
      roles: ["student"],
      objects: [{ object, destination: path.join(directory, "size.txt") }],
      signal: new AbortController().signal,
    }), /Content-Length does not match/);
    assert.equal(bodyCancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
