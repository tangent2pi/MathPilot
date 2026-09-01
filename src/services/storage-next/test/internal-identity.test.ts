import assert from "node:assert/strict";
import { Readable } from "node:stream";
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
import { ContentIntegrityError } from "@mathpilot/content-integrity/node";

const signedActor = Object.freeze({
  tenantId: "tnt_signed",
  userId: "usr_signed",
  roles: ["teacher"] as const,
});

const publicInitBody = Object.freeze({
  purpose: "thread",
  mime_type: "text/plain",
  byte_size: 17,
  original_name: "audit.json",
});

const candidateInitBody = Object.freeze({
  purpose: "candidate",
  mime_type: "application/json",
  byte_size: 17,
  original_name: "audit.json",
});

interface Harness {
  app: ReturnType<typeof Fastify>;
  actors: Principal[];
  queries: Array<{ text: string; values: readonly unknown[] | undefined }>;
}

function storageObjects(): StorageObjectOperations {
  return {
    async createUploadPolicy(input) {
      return {
        url: input.audience === "public"
          ? "http://minio.public.test:9000/upload"
          : "http://minio.internal.test:9000/upload",
        fields: { key: input.key, "Content-Type": input.mimeType },
      };
    },
    async statSource() {
      return { size: 17, etag: "source-etag", lastModified: new Date(), metadata: {}, versionId: "source-version" };
    },
    async openSource() { return Readable.from([Buffer.from("{\"answer\":true}")]); },
    async putCanonical() { return { etag: "stored-etag", versionId: "stored-version" }; },
    async removeVersion() {},
    async presignedDownload(input) {
      return input.audience === "public"
        ? "http://minio.public.test:9000/download"
        : "http://minio.internal.test:9000/download";
    },
  };
}

function createHarness(
  rowsForQuery: (text: string, values: readonly unknown[] | undefined) => unknown[] = () => [],
  objects: StorageObjectOperations = storageObjects(),
): Harness {
  const actors: Principal[] = [];
  const queries: Harness["queries"] = [];
  const client: StorageQueryClient = {
    async query<Row>(text: string, values?: readonly unknown[]) {
      queries.push({ text, values });
      return { rows: rowsForQuery(text, values) as Row[] };
    },
  };
  const runWithPrincipal: RunWithPrincipal = async (principal, operation) => {
    actors.push(principal);
    return operation(client);
  };
  const identity = createInternalServiceRuntime("storage-next", internalServiceTestEnvironment());
  const app = Fastify();
  registerStorageRoutes(app, { identity, objects, runWithPrincipal });
  return { app, actors, queries };
}

async function assertion(
  caller: InternalServiceId,
  edge: InternalEdgeId,
  path: string,
  body: unknown,
  actor: InternalActor = signedActor,
  method: "POST" | "DELETE" = "POST",
): Promise<string> {
  const runtime = createInternalServiceRuntime(caller, internalServiceTestEnvironment());
  return new InternalAssertionCodec(runtime.configuration).issue(edge, actor, {
    method,
    path,
    body,
  });
}

test("production init route trusts the signed actor, not forged principal headers, and rejects missing or replayed assertions", async () => {
  const harness = createHarness();
  const token = await assertion("api-next", "api-to-storage", "/internal/objects/init", publicInitBody);
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
    payload: publicInitBody,
  });
  assert.equal(accepted.statusCode, 201);
  assert.equal(accepted.json().upload.url, "http://minio.public.test:9000/upload");
  assert.equal(accepted.json().upload.method, "POST");
  assert.equal(
    accepted.json().upload.fields.key,
    `quarantine/${signedActor.tenantId}/thread/${accepted.json().object_id}/source`,
  );
  assert.deepEqual(harness.actors, [signedActor]);

  const replayed = await harness.app.inject({
    method: "POST",
    url: "/internal/objects/init",
    headers,
    payload: publicInitBody,
  });
  assert.equal(replayed.statusCode, 401);
  assert.equal(replayed.json().code, "internal_service_authentication_failed");

  const missing = await harness.app.inject({
    method: "POST",
    url: "/internal/objects/init",
    payload: publicInitBody,
  });
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.json().code, "internal_service_authentication_failed");
  assert.equal(harness.actors.length, 1);
  await harness.app.close();
});

test("route edge policy admits writers and gives each host reader a purpose-bounded resolve", async () => {
  const harness = createHarness();

  const piInitToken = await assertion("pi-chat-runtime", "pi-to-storage", "/internal/objects/init", candidateInitBody);
  const piInit = await harness.app.inject({
    method: "POST",
    url: "/internal/objects/init",
    headers: { authorization: `Bearer ${piInitToken}` },
    payload: candidateInitBody,
  });
  assert.equal(piInit.statusCode, 201);
  assert.equal(piInit.json().upload.url, "http://minio.internal.test:9000/upload");

  const learningCrossEdge = await assertion("learning-next", "learning-to-storage", "/internal/objects/init", candidateInitBody);
  const rejected = await harness.app.inject({
    method: "POST",
    url: "/internal/objects/init",
    headers: { authorization: `Bearer ${learningCrossEdge}` },
    payload: candidateInitBody,
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

  const readPath = "/internal/objects/resolve";
  const readBody = { object_refs: ["storage-object:obj_test0001"], download_intent: "attachment" };
  const learningReadToken = await assertion("learning-next", "learning-to-storage", readPath, readBody);
  const read = await harness.app.inject({
    method: "POST",
    url: readPath,
    headers: { authorization: `Bearer ${learningReadToken}` },
    payload: readBody,
  });
  assert.equal(read.statusCode, 404);
  assert.equal(read.json().error, "one or more objects were not found");

  const piReadToken = await assertion("pi-chat-runtime", "pi-to-storage", readPath, readBody);
  const piRead = await harness.app.inject({
    method: "POST",
    url: readPath,
    headers: { authorization: `Bearer ${piReadToken}` },
    payload: readBody,
  });
  assert.equal(piRead.statusCode, 404);
  assert.equal(piRead.json().error, "one or more objects were not found");
  const resolveQueries = harness.queries.filter((query) => query.text.includes("object_id=any"));
  assert.deepEqual(resolveQueries.at(-1)?.values?.[1], ["source", "thread"]);
  assert.equal(harness.actors.length, 4);
  await harness.app.close();
});

test("one edge-purpose policy applies to init, complete, and resolve", async () => {
  const candidateObject = {
    object_id: "obj_test0001",
    tenant_id: signedActor.tenantId,
    owner_user_id: signedActor.userId,
    bucket_name: "mathpilot-working",
    object_key: "objects/tnt_signed/candidate/obj_test0001/content",
    source_object_key: "quarantine/tnt_signed/candidate/obj_test0001/source",
    declared_byte_size: 17,
    declared_mime_type: "application/json",
    purpose: "candidate",
    state: "pending",
    original_name: "audit.json",
    mime_type: null,
    byte_size: null,
    sha256: null,
    version_id: null,
    etag: null,
    source_version_id: null,
    source_etag: null,
    source_sha256: null,
    source_byte_size: null,
    source_mime_type: null,
    expires_at: new Date(Date.now()+60_000),
    verification_lease_id: null,
    verification_started_at: null,
    verification_attempts: 0,
  };
  const harness = createHarness((text) => text.includes("object_id=any")
    ? []
    : text.startsWith("select object_id") ? [candidateObject] : []);

  const apiCandidateToken = await assertion("api-next", "api-to-storage", "/internal/objects/init", candidateInitBody);
  const apiCandidate = await harness.app.inject({
    method: "POST", url: "/internal/objects/init",
    headers: { authorization: `Bearer ${apiCandidateToken}` }, payload: candidateInitBody,
  });
  assert.equal(apiCandidate.statusCode, 403);
  assert.equal(apiCandidate.json().code, "purpose_not_allowed");

  const piThreadToken = await assertion("pi-chat-runtime", "pi-to-storage", "/internal/objects/init", publicInitBody);
  const piThread = await harness.app.inject({
    method: "POST", url: "/internal/objects/init",
    headers: { authorization: `Bearer ${piThreadToken}` }, payload: publicInitBody,
  });
  assert.equal(piThread.statusCode, 403);
  assert.equal(piThread.json().code, "purpose_not_allowed");

  const completePath = "/internal/objects/obj_test0001/complete";
  const completeToken = await assertion("api-next", "api-to-storage", completePath, {});
  const complete = await harness.app.inject({
    method: "POST", url: completePath,
    headers: { authorization: `Bearer ${completeToken}` }, payload: {},
  });
  assert.equal(complete.statusCode, 403);
  assert.equal(complete.json().code, "purpose_not_allowed");

  const resolvePath = "/internal/objects/resolve";
  const resolveBody = { object_refs:["storage-object:obj_test0001"], download_intent:"attachment" };
  const resolveToken = await assertion("api-next", "api-to-storage", resolvePath, resolveBody);
  const resolve = await harness.app.inject({
    method: "POST", url: resolvePath,
    headers: { authorization: `Bearer ${resolveToken}` }, payload: resolveBody,
  });
  assert.equal(resolve.statusCode, 404);
  const resolveQuery = harness.queries.find((query) => query.text.includes("object_id=any"));
  assert.deepEqual(resolveQuery?.values?.[1], ["thread","avatar"]);
  await harness.app.close();
});

test("complete acquires a stale verification lease with one bounded atomic CAS", async () => {
  const pendingCandidate = {
    object_id: "obj_test0002", tenant_id:signedActor.tenantId,owner_user_id:signedActor.userId,
    bucket_name:"mathpilot-working",object_key:"objects/tnt_signed/candidate/obj_test0002/content",
    source_object_key:"quarantine/tnt_signed/candidate/obj_test0002/source",
    declared_byte_size:17,declared_mime_type:"application/json",original_name:"audit.json",
    purpose:"candidate",state:"pending",version_id:null,etag:null,sha256:null,byte_size:null,mime_type:null,
    source_version_id:null,source_etag:null,source_sha256:null,source_byte_size:null,source_mime_type:null,
    expires_at:new Date(Date.now()+60_000),verification_lease_id:null,verification_started_at:null,
    verification_attempts:0,
  };
  const harness = createHarness((text) => text.startsWith("select object_id") ? [pendingCandidate] : []);
  const path = "/internal/objects/obj_test0002/complete";
  const token = await assertion("pi-chat-runtime","pi-to-storage",path,{});
  const response = await harness.app.inject({
    method:"POST",url:path,headers:{ authorization:`Bearer ${token}` },payload:{},
  });
  assert.equal(response.statusCode,409);
  assert.equal(response.json().code,"verification_race");
  const cas = harness.queries.find((query) => query.text.includes("verification_attempts=verification_attempts+1"));
  assert.ok(cas);
  assert.match(cas.text,/state='pending'/);
  assert.match(cas.text,/verification_started_at<=clock_timestamp\(\)-interval '10 minutes'/);
  assert.match(cas.text,/verification_attempts<\$4/);
  assert.deepEqual(cas.values?.[2],["candidate"]);
  assert.equal(cas.values?.[3],16);
  await harness.app.close();
});

test("retryable integrity failures return 500 and release the object to pending", async () => {
  const pendingCandidate = {
    object_id: "obj_test0003", tenant_id:signedActor.tenantId,owner_user_id:signedActor.userId,
    bucket_name:"mathpilot-working",object_key:"objects/tnt_signed/candidate/obj_test0003/content",
    source_object_key:"quarantine/tnt_signed/candidate/obj_test0003/source",
    declared_byte_size:17,declared_mime_type:"application/json",original_name:"audit.json",
    purpose:"candidate",state:"pending",version_id:null,etag:null,sha256:null,byte_size:null,mime_type:null,
    source_version_id:null,source_etag:null,source_sha256:null,source_byte_size:null,source_mime_type:null,
    expires_at:new Date(Date.now()+60_000),verification_lease_id:null,verification_started_at:null,
    verification_attempts:0,
  };
  const objects = storageObjects();
  const harness = createHarness((text) => {
    if (text.startsWith("select object_id")) return [pendingCandidate];
    if (text.includes("verification_attempts=verification_attempts+1")) {
      return [{ ...pendingCandidate,state:"verifying",verification_attempts:1 }];
    }
    return [];
  }, {
    ...objects,
    async statSource() {
      throw new ContentIntegrityError("image_transform_unavailable","temporary transform failure","retryable");
    },
  });
  const path = "/internal/objects/obj_test0003/complete";
  const token = await assertion("pi-chat-runtime","pi-to-storage",path,{});
  const response = await harness.app.inject({
    method:"POST",url:path,headers:{ authorization:`Bearer ${token}` },payload:{},
  });
  assert.equal(response.statusCode,500);
  assert.equal(response.json().code,"image_transform_unavailable");
  const released = harness.queries.find((query) => query.text.includes("update storage_object set state=$3"));
  assert.equal(released?.values?.[2],"pending");
  await harness.app.close();
});

test("delete delegates the same edge-purpose policy to the claim-aware database transition", async () => {
  const harness = createHarness((text) => text.includes("mathpilot_storage_request_owned_deletion")
    ? [{ accepted:true }]
    : []);

  const apiPath = "/internal/objects/obj_delete0001";
  const apiToken = await assertion("api-next","api-to-storage",apiPath,undefined,signedActor,"DELETE");
  const apiDelete = await harness.app.inject({
    method:"DELETE",url:apiPath,headers:{ authorization:`Bearer ${apiToken}` },
  });
  assert.equal(apiDelete.statusCode,202);

  const piPath = "/internal/objects/obj_delete0002";
  const piToken = await assertion("pi-chat-runtime","pi-to-storage",piPath,undefined,signedActor,"DELETE");
  const piDelete = await harness.app.inject({
    method:"DELETE",url:piPath,headers:{ authorization:`Bearer ${piToken}` },
  });
  assert.equal(piDelete.statusCode,202);

  const deletionQueries = harness.queries.filter((query) => query.text.includes("mathpilot_storage_request_owned_deletion"));
  assert.deepEqual(deletionQueries.map((query) => query.values?.[3]), [
    ["thread","avatar"],
    ["candidate"],
  ]);
  await harness.app.close();
});

test("the authenticated service edge, not a caller field or header, selects the data-plane endpoint", async () => {
  const readyObject = {
    object_id: "obj_test0001",
    tenant_id: signedActor.tenantId,
    owner_user_id: signedActor.userId,
    bucket_name: "mathpilot-working",
    object_key: "objects/tnt_signed/thread/obj_test0001/content",
    source_object_key: "quarantine/tnt_signed/thread/obj_test0001/source",
    declared_byte_size: 17,
    declared_mime_type: "text/plain",
    purpose: "thread",
    state: "ready",
    original_name: "audit.json",
    mime_type: "application/json",
    byte_size: 17,
    sha256: "a".repeat(64),
    version_id: "version-test",
    etag: "etag-test",
    source_version_id: "source-version-test",
    source_etag: "source-etag-test",
    source_sha256: "b".repeat(64),
    source_byte_size: 17,
    source_mime_type: "text/plain",
    expires_at: new Date(Date.now() + 60_000),
    verification_lease_id: null,
    verification_started_at: null,
    verification_attempts: 1,
  };
  const downloadRequests: Parameters<StorageObjectOperations["presignedDownload"]>[0][] = [];
  const operations: StorageObjectOperations = {
    ...storageObjects(),
    async presignedDownload(input) {
      downloadRequests.push(input);
      return input.audience === "public"
        ? "http://minio.public.test:9000/download"
        : "http://minio.internal.test:9000/download";
    },
  };
  const harness = createHarness((text) => text.includes("object_id=any") ? [readyObject] : [], operations);
  const path = "/internal/objects/resolve";
  const body = { object_refs: ["storage-object:obj_test0001"], download_intent: "attachment" };
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
  assert.equal(response.json().objects[0].download.url, "http://minio.public.test:9000/download");
  assert.equal(response.json().objects[0].version_id, "version-test");
  assert.equal(downloadRequests[0]?.intent, "attachment");
  assert.deepEqual(harness.actors, [signedActor]);
  await harness.app.close();
});

test("canonical WebP may be resolved inline while other content remains download-only", async () => {
  const readyImage = {
    object_id: "obj_image001",
    tenant_id: signedActor.tenantId,
    owner_user_id: signedActor.userId,
    bucket_name: "mathpilot-session",
    object_key: "objects/tnt_signed/thread/obj_image001/content",
    source_object_key: "quarantine/tnt_signed/thread/obj_image001/source",
    declared_byte_size: 17,
    declared_mime_type: "image/png",
    purpose: "thread",
    state: "ready",
    original_name: "photo.png",
    mime_type: "image/webp",
    byte_size: 17,
    sha256: "a".repeat(64),
    version_id: "version-image",
    etag: "etag-image",
    source_version_id: "source-version-image",
    source_etag: "source-etag-image",
    source_sha256: "b".repeat(64),
    source_byte_size: 17,
    source_mime_type: "image/png",
    expires_at: new Date(Date.now() + 60_000),
    verification_lease_id: null,
    verification_started_at: null,
    verification_attempts: 1,
  };
  const intents: string[] = [];
  const operations: StorageObjectOperations = {
    ...storageObjects(),
    async presignedDownload(input) {
      intents.push(input.intent);
      return "http://minio.public.test:9000/image";
    },
  };
  const inlineHarness = createHarness((text) => text.includes("object_id=any") ? [readyImage] : [], operations);
  const path = "/internal/objects/resolve";
  const inlineBody = { object_refs: ["storage-object:obj_image001"], download_intent: "inline" };
  const inlineToken = await assertion("api-next", "api-to-storage", path, inlineBody);
  const inline = await inlineHarness.app.inject({
    method: "POST", url: path, headers: { authorization: `Bearer ${inlineToken}` }, payload: inlineBody,
  });
  assert.equal(inline.statusCode, 200);
  assert.deepEqual(intents, ["inline"]);
  await inlineHarness.app.close();

  const unsafeHarness = createHarness((text) => text.includes("object_id=any")
    ? [{ ...readyImage, mime_type: "text/markdown" }]
    : [], operations);
  const unsafeToken = await assertion("api-next", "api-to-storage", path, inlineBody);
  const unsafe = await unsafeHarness.app.inject({
    method: "POST", url: path, headers: { authorization: `Bearer ${unsafeToken}` }, payload: inlineBody,
  });
  assert.equal(unsafe.statusCode, 422);
  assert.equal(unsafe.json().code, "object_not_inline_safe");
  assert.deepEqual(intents, ["inline"]);
  await unsafeHarness.app.close();
});
