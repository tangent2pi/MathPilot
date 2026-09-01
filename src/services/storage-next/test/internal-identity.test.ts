import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  InternalAssertionCodec,
  createInternalServiceRuntime,
  type InternalActor,
  type InternalEdgeId,
  type InternalServiceId,
} from "@mathpilot/internal-service";
import { internalServiceTestEnvironment } from "@mathpilot/internal-service/testing";
import {
  registerStorageRoutes,
  type RunWithPrincipal,
  type StorageObjectOperations,
  type StorageQueryClient,
} from "../src/storage-routes.ts";
import type { Principal } from "../src/lib.ts";

const signedActor = Object.freeze({
  tenantId: "tnt_signed",
  userId: "usr_signed",
  roles: ["teacher"] as const,
});

const initBody = Object.freeze({
  purpose: "candidate",
  mime_type: "application/json",
  byte_size: 17,
  original_name: "audit.json",
  audience: "runtime",
});

interface Harness {
  app: ReturnType<typeof Fastify>;
  actors: Principal[];
}

function storageObjects(): StorageObjectOperations {
  return {
    publicOrigin: "http://minio.public.test:9000",
    async presignedPut() { return "http://minio.public.test:9000/upload"; },
    async presignedInternalPut() { return "http://minio.internal.test:9000/upload"; },
    async presignedGet() { return "http://minio.public.test:9000/download"; },
    async presignedInternalGet() { return "http://minio.internal.test:9000/download"; },
    async verify() {
      return { stat: { etag: "etag-test", versionId: "version-test" }, sha256: "a".repeat(64) };
    },
  };
}

function createHarness(rowsForQuery: (text: string) => unknown[] = () => []): Harness {
  const actors: Principal[] = [];
  const client: StorageQueryClient = {
    async query<Row>(text: string) { return { rows: rowsForQuery(text) as Row[] }; },
  };
  const runWithPrincipal: RunWithPrincipal = async (principal, operation) => {
    actors.push(principal);
    return operation(client);
  };
  const identity = createInternalServiceRuntime("storage-next", internalServiceTestEnvironment());
  const app = Fastify();
  registerStorageRoutes(app, { identity, objects: storageObjects(), runWithPrincipal });
  return { app, actors };
}

async function assertion(
  caller: InternalServiceId,
  edge: InternalEdgeId,
  path: string,
  body: unknown,
  actor: InternalActor = signedActor,
): Promise<string> {
  const runtime = createInternalServiceRuntime(caller, internalServiceTestEnvironment());
  return new InternalAssertionCodec(runtime.configuration).issue(edge, actor, {
    method: "POST",
    path,
    body,
  });
}

test("production init route trusts the signed actor, not forged principal headers, and rejects missing or replayed assertions", async () => {
  const harness = createHarness();
  const token = await assertion("api-next", "api-to-storage", "/internal/objects/init", initBody);
  const headers = {
    authorization: `Bearer ${token}`,
    "x-tenant-id": "tnt_forged",
    "x-user-id": "usr_forged",
    "x-user-roles": "student",
    "x-mathpilot-storage-audience": "public",
  };

  const accepted = await harness.app.inject({
    method: "POST",
    url: "/internal/objects/init",
    headers,
    payload: initBody,
  });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.json().upload_url, "http://minio.internal.test:9000/upload");
  assert.deepEqual(harness.actors, [signedActor]);

  const replayed = await harness.app.inject({
    method: "POST",
    url: "/internal/objects/init",
    headers,
    payload: initBody,
  });
  assert.equal(replayed.statusCode, 401);
  assert.equal(replayed.json().code, "internal_service_authentication_failed");

  const missing = await harness.app.inject({
    method: "POST",
    url: "/internal/objects/init",
    payload: initBody,
  });
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.json().code, "internal_service_authentication_failed");
  assert.equal(harness.actors.length, 1);
  await harness.app.close();
});

test("route edge policy admits both storage writers and the learning reader but rejects a valid cross-edge assertion", async () => {
  const harness = createHarness();

  const piInitToken = await assertion("pi-chat-runtime", "pi-to-storage", "/internal/objects/init", initBody);
  const piInit = await harness.app.inject({
    method: "POST",
    url: "/internal/objects/init",
    headers: { authorization: `Bearer ${piInitToken}` },
    payload: initBody,
  });
  assert.equal(piInit.statusCode, 200);

  const learningCrossEdge = await assertion("learning-next", "learning-to-storage", "/internal/objects/init", initBody);
  const rejected = await harness.app.inject({
    method: "POST",
    url: "/internal/objects/init",
    headers: { authorization: `Bearer ${learningCrossEdge}` },
    payload: initBody,
  });
  assert.equal(rejected.statusCode, 401);

  const completePath = "/internal/objects/obj_test0001/complete";
  const completeBody = {};
  const piCompleteToken = await assertion("pi-chat-runtime", "pi-to-storage", completePath, completeBody);
  const complete = await harness.app.inject({
    method: "POST",
    url: completePath,
    headers: { authorization: `Bearer ${piCompleteToken}` },
    payload: completeBody,
  });
  assert.equal(complete.statusCode, 404);
  assert.equal(complete.json().error, "object not found");

  const readPath = "/internal/objects/obj_test0001/presign-get";
  const readBody = { audience: "runtime" };
  const learningReadToken = await assertion("learning-next", "learning-to-storage", readPath, readBody);
  const read = await harness.app.inject({
    method: "POST",
    url: readPath,
    headers: { authorization: `Bearer ${learningReadToken}` },
    payload: readBody,
  });
  assert.equal(read.statusCode, 404);
  assert.equal(read.json().error, "object not found");
  assert.equal(harness.actors.length, 3);
  await harness.app.close();
});

test("presign audience remains a post-authentication storage contract", async () => {
  const readyObject = {
    object_id: "obj_test0001",
    tenant_id: signedActor.tenantId,
    owner_user_id: signedActor.userId,
    bucket_name: "mathpilot-working",
    object_key: "candidate/obj_test0001/audit.json",
    state: "ready",
    original_name: "audit.json",
    mime_type: "application/json",
    byte_size: 17,
    sha256: "a".repeat(64),
    version_id: "version-test",
    etag: "etag-test",
  };
  const harness = createHarness((text) => text.startsWith("select object_id") ? [readyObject] : []);
  const path = "/internal/objects/obj_test0001/presign-get";
  const body = { audience: "unknown-value" };
  const token = await assertion("api-next", "api-to-storage", path, body);
  const response = await harness.app.inject({
    method: "POST",
    url: path,
    headers: {
      authorization: `Bearer ${token}`,
      "x-tenant-id": "tnt_forged",
      "x-user-id": "usr_forged",
    },
    payload: body,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().download_url, "http://minio.public.test:9000/download");
  assert.deepEqual(harness.actors, [signedActor]);
  await harness.app.close();
});
