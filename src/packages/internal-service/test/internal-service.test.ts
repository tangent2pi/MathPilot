import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import canonicalize from "canonicalize";
import Fastify from "fastify";
import { SignJWT, base64url } from "jose";
import {
  InternalServiceAssertionError,
  InternalAssertionCodec,
  canonicalJsonDigest,
  createInternalServiceRuntime,
  developmentKeyringForEdge,
  loadInternalServiceConfiguration,
  serviceIssuer,
  validateInternalDeploymentConfiguration,
} from "../src/index.ts";
import { internalServiceContext, internalServiceGuard, isProblemDetails } from "../src/fastify.ts";
import {
  internalServiceTestEnvironment,
  testKeyForEdge,
  testKeyringForEdge,
} from "../src/testing.ts";

const actor = Object.freeze({ tenantId: "tnt_test", userId: "usr_teacher", roles: ["teacher"] as const });
const request = Object.freeze({ method: "POST", path: "/internal/check?b=2&a=1", body: { z: 2, a: [1, true] } });

test("configuration is production-default, explicit, edge-local, and rotation-aware", () => {
  assert.throws(() => loadInternalServiceConfiguration("api-next", {}), /MATHPILOT_INTERNAL_REPLAY_MODE/);
  const development = loadInternalServiceConfiguration("api-next", {
    MATHPILOT_ENVIRONMENT: "development",
    MATHPILOT_INTERNAL_CONTENT_URL: "http://content-next:3016",
    MATHPILOT_INTERNAL_PI_URL: "http://pi-chat-runtime:3105",
    MATHPILOT_INTERNAL_STORAGE_URL: "http://storage-next:3017",
    MATHPILOT_INTERNAL_GROUP_URL: "http://group-next:3018",
  });
  assert.equal(development.keyrings.get("api-to-content")?.activeKeyId, "dev-v1");
  assert.throws(() => loadInternalServiceConfiguration("api-next", {
    ...internalServiceTestEnvironment(),
    MATHPILOT_ENVIRONMENT: "production",
    MATHPILOT_INTERNAL_API_TO_CONTENT_KEYRING: developmentKeyringForEdge("api-to-content"),
  }), /public development key/);
  assert.throws(() => loadInternalServiceConfiguration("api-next", {
    ...internalServiceTestEnvironment(),
    MATHPILOT_ENVIRONMENT: "production",
    MATHPILOT_INTERNAL_API_TO_CONTENT_KEYRING: developmentKeyringForEdge("pi-to-storage"),
  }), /public development key/);
  assert.throws(() => loadInternalServiceConfiguration("api-next", {
    ...internalServiceTestEnvironment(),
    MATHPILOT_INTERNAL_API_TO_CONTENT_KEYRING: JSON.stringify({
      active: "constructor",
      keys: { "test-v1": testKeyForEdge("api-to-content") },
    }),
  }), /including its active key/);
  assert.throws(() => loadInternalServiceConfiguration("api-next", {
    ...internalServiceTestEnvironment(),
    MATHPILOT_ENVIRONMENT: "production",
  }), /test fixture key/);

  const rotating = loadInternalServiceConfiguration("api-next", {
    ...internalServiceTestEnvironment(),
    MATHPILOT_INTERNAL_API_TO_CONTENT_KEYRING: testKeyringForEdge("api-to-content", "test-v2", ["test-v1", "test-v2"]),
  });
  assert.deepEqual([...rotating.keyrings.get("api-to-content")!.keys.keys()].sort(), ["test-v1", "test-v2"]);
});

test("deployment preflight rejects key reuse across otherwise disjoint edges", () => {
  const source = internalServiceTestEnvironment();
  source.MATHPILOT_INTERNAL_LEARNING_TO_STORAGE_KEYRING = source.MATHPILOT_INTERNAL_API_TO_CONTENT_KEYRING;
  assert.throws(() => validateInternalDeploymentConfiguration(source), /independent/);
  assert.doesNotThrow(() => validateInternalDeploymentConfiguration(internalServiceTestEnvironment()));
});

test("a signed assertion binds edge, actor, method, path, canonical JSON body, expiry, and jti", async () => {
  const source = internalServiceTestEnvironment();
  const caller = createInternalServiceRuntime("api-next", source);
  const receiver = createInternalServiceRuntime("content-next", source);
  const issued = await new InternalAssertionCodec(caller.configuration).issue("api-to-content", actor, request);
  const context = await receiver.authenticate(["api-to-content"], `Bearer ${issued}`, request);
  assert.deepEqual(context.actor, actor);
  assert.equal(context.edge, "api-to-content");
  assert.equal(context.caller, "api-next");
  assert.equal(context.audience, "content-next");
  assert.match(context.assertionId, /^[0-9a-f-]{36}$/);

  await assert.rejects(receiver.authenticate(["api-to-content"], `Bearer ${issued}`, request), (error: unknown) =>
    error instanceof InternalServiceAssertionError && error.reason === "assertion_replayed");
});

test("an assertion cannot cross an edge or mutate method, path, or JSON body", async () => {
  const source = internalServiceTestEnvironment();
  const caller = createInternalServiceRuntime("api-next", source);
  const token = await new InternalAssertionCodec(caller.configuration).issue("api-to-content", actor, request);

  for (const binding of [
    { ...request, method: "PATCH" },
    { ...request, path: "/internal/other" },
    { ...request, body: { z: 3, a: [1, true] } },
  ]) {
    const receiver = createInternalServiceRuntime("content-next", source);
    await assert.rejects(receiver.authenticate(["api-to-content"], `Bearer ${token}`, binding), (error: unknown) =>
      error instanceof InternalServiceAssertionError && error.reason === "request_binding_mismatch");
  }
  await assert.rejects(
    createInternalServiceRuntime("storage-next", source).authenticate(["api-to-storage"], `Bearer ${token}`, request),
    (error: unknown) => error instanceof InternalServiceAssertionError && error.reason === "edge_not_allowed",
  );
  const noBodyToken = await new InternalAssertionCodec(caller.configuration).issue("api-to-content", actor, {
    method: "POST", path: "/internal/check",
  });
  await assert.rejects(
    createInternalServiceRuntime("content-next", source).authenticate(
      ["api-to-content"],
      `Bearer ${noBodyToken}`,
      { method: "POST", path: "/internal/check", body: null },
    ),
    (error: unknown) => error instanceof InternalServiceAssertionError && error.reason === "request_binding_mismatch",
  );
  assert.equal(canonicalize({ z: 2, a: [1, true] }), canonicalize({ a: [1, true], z: 2 }));
});

test("wrong issuer, expired assertions, and unknown signing keys fail closed", async () => {
  const source = internalServiceTestEnvironment();
  const key = base64url.decode(testKeyForEdge("api-to-content"));
  const now = 2_000_000_000;
  const payload = {
    mathpilot_tenant_id: actor.tenantId,
    mathpilot_roles: actor.roles,
    mathpilot_edge: "api-to-content",
    mathpilot_method: request.method,
    mathpilot_path: request.path,
    mathpilot_body_sha256: canonicalJsonDigest(request.body),
  };
  const sign = (issuer: string, issuedAt: number, keyId = "test-v1") => new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "mathpilot-internal+jwt", kid: `api-to-content:${keyId}` })
    .setIssuer(issuer)
    .setAudience(serviceIssuer("content-next"))
    .setSubject(actor.userId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 60)
    .setJti("00000000-0000-4000-8000-000000000001")
    .sign(key);
  const receiver = createInternalServiceRuntime("content-next", source, { now: () => now });
  await assert.rejects(receiver.authenticate(["api-to-content"], `Bearer ${await sign(serviceIssuer("pi-chat-runtime"), now)}`, request));
  await assert.rejects(receiver.authenticate(["api-to-content"], `Bearer ${await sign(serviceIssuer("api-next"), now - 120)}`, request));
  await assert.rejects(receiver.authenticate(["api-to-content"], `Bearer ${await sign(serviceIssuer("api-next"), now, "unknown")}`, request));
});

test("untrusted key identifiers cannot create high-cardinality observations", async () => {
  const source = internalServiceTestEnvironment();
  const key = base64url.decode(testKeyForEdge("api-to-content"));
  const payload = {
    mathpilot_tenant_id: actor.tenantId,
    mathpilot_roles: actor.roles,
    mathpilot_edge: "api-to-content",
    mathpilot_method: request.method,
    mathpilot_path: request.path,
    mathpilot_body_sha256: canonicalJsonDigest(request.body),
  };
  const receiver = createInternalServiceRuntime("content-next", source);
  for (const keyId of ["unknown-a", "unknown-b", "x".repeat(33)]) {
    const token = await new SignJWT(payload)
      .setProtectedHeader({ alg: "HS256", typ: "mathpilot-internal+jwt", kid: `api-to-content:${keyId}` })
      .setIssuer(serviceIssuer("api-next"))
      .setAudience(serviceIssuer("content-next"))
      .setSubject(actor.userId)
      .setIssuedAt()
      .setExpirationTime("60s")
      .setJti("00000000-0000-4000-8000-000000000001")
      .sign(key);
    await assert.rejects(receiver.authenticate(["api-to-content"], `Bearer ${token}`, request));
  }
  const observations = receiver.observations();
  assert.equal(Object.keys(observations).length, 2);
  assert.equal(observations["assertion_rejected:api-to-content:none:unknown_key_id"], 2);
  assert.equal(observations["assertion_rejected:api-to-content:none:invalid_key_id"], 1);
  assert.equal(Object.keys(observations).some((keyName) => keyName.includes("unknown-a") || keyName.includes("unknown-b")), false);
});

test("the shared client refuses redirects instead of forwarding an assertion", async () => {
  let captureRequests = 0;
  const server = createServer((incoming, response) => {
    if (incoming.url === "/redirect") {
      response.statusCode = 307;
      response.setHeader("location", "/capture");
      response.end();
      return;
    }
    captureRequests += 1;
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const caller = createInternalServiceRuntime("api-next", internalServiceTestEnvironment({
    MATHPILOT_INTERNAL_CONTENT_URL: `http://127.0.0.1:${address.port}`,
  }));
  try {
    await assert.rejects(caller.request("api-to-content", actor, "/redirect"));
    assert.equal(captureRequests, 0);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("rotation accepts a previous key while new assertions use only the active key", async () => {
  const previousSource = internalServiceTestEnvironment({
    MATHPILOT_INTERNAL_API_TO_CONTENT_KEYRING: testKeyringForEdge("api-to-content", "test-v1", ["test-v1"]),
  });
  const rotatingSource = internalServiceTestEnvironment({
    MATHPILOT_INTERNAL_API_TO_CONTENT_KEYRING: testKeyringForEdge("api-to-content", "test-v2", ["test-v1", "test-v2"]),
  });
  const oldToken = await new InternalAssertionCodec(loadInternalServiceConfiguration("api-next", previousSource)).issue("api-to-content", actor, request);
  const receiver = createInternalServiceRuntime("content-next", rotatingSource);
  assert.equal((await receiver.authenticate(["api-to-content"], `Bearer ${oldToken}`, request)).keyId, "test-v1");
  const newToken = await new InternalAssertionCodec(loadInternalServiceConfiguration("api-next", rotatingSource)).issue("api-to-content", actor, request);
  assert.equal((await createInternalServiceRuntime("content-next", rotatingSource).authenticate(["api-to-content"], `Bearer ${newToken}`, request)).keyId, "test-v2");
});

test("Fastify guard maps every assertion failure once and ignores forged principal headers", async () => {
  const source = internalServiceTestEnvironment();
  const caller = createInternalServiceRuntime("api-next", source);
  const receiver = createInternalServiceRuntime("content-next", source);
  const app = Fastify();
  app.post("/internal/check", { preHandler: internalServiceGuard(receiver, ["api-to-content"]) }, async (request) => {
    const context = internalServiceContext(request);
    return context.actor;
  });
  const body = { value: 1 };
  const token = await new InternalAssertionCodec(caller.configuration).issue("api-to-content", actor, {
    method: "POST", path: "/internal/check", body,
  });
  const accepted = await app.inject({
    method: "POST",
    url: "/internal/check",
    headers: {
      authorization: `Bearer ${token}`,
      "x-tenant-id": "forged-tenant",
      "x-user-id": "forged-user",
      "x-user-roles": "student",
    },
    payload: body,
  });
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(accepted.json(), actor);
  const rejected = await app.inject({ method: "POST", url: "/internal/check", payload: body });
  assert.equal(rejected.statusCode, 401);
  assert.match(rejected.headers["content-type"] ?? "", /^application\/problem\+json/);
  assert.equal(rejected.headers["cache-control"], "no-store");
  assert.equal(rejected.headers["www-authenticate"], "Bearer");
  assert.equal(isProblemDetails(rejected.json()), true);
  assert.equal(rejected.json().code, "internal_service_authentication_failed");
  await app.close();
});
