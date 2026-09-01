import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { createInternalServiceRuntime } from "@mathpilot/internal-service";
import { internalServiceTestEnvironment } from "@mathpilot/internal-service/testing";
import { StorageNextObjectReader } from "../src/storage-object-reader.ts";

test("learning-next reads a frozen object through its signed storage edge and the presigned data plane", async () => {
  const content = Buffer.from("authorized vision attachment", "utf8");
  const object = {
    path: "attachments/problem.png",
    objectId: "obj_abcdefgh",
    mimeType: "image/png",
    byteSize: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
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
      assert.equal(request.url, "/internal/objects/obj_abcdefgh/presign-get");
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
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        object_id: object.objectId,
        mime_type: object.mimeType,
        byte_size: object.byteSize,
        sha256: object.sha256,
        download_url: downloadUrl,
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

  try {
    const result = await reader.read({
      tenantId: actor.tenantId,
      accountUserId: actor.userId,
      roles: actor.roles,
      object,
      signal: new AbortController().signal,
    });
    if (serverFailure) throw serverFailure;
    assert.deepEqual(result, content);
    assert.deepEqual(assertedActor, actor);
  } finally {
    server.close();
    await once(server, "close");
  }
});
