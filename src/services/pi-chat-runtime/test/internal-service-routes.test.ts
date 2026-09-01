import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  InternalAssertionCodec,
  createInternalServiceRuntime,
} from "@mathpilot/internal-service";
import { installProblemDetails, isProblemDetails } from "@mathpilot/internal-service/fastify";
import { internalServiceTestEnvironment } from "@mathpilot/internal-service/testing";
import { registerPiChatRoutes } from "../src/pi-chat-routes.ts";

const teacher = Object.freeze({
  tenantId: "tnt_pi_identity_test",
  userId: "usr_pi_identity_test",
  roles: ["teacher"] as const,
});

test("Pi exposes only signed Content dispatch routes", async () => {
  const source = internalServiceTestEnvironment();
  const content = createInternalServiceRuntime("content-next", source);
  const pi = createInternalServiceRuntime("pi-chat-runtime", source);
  const app = Fastify();
  installProblemDetails(app);
  registerPiChatRoutes(
    app,
    { client: {} } as never,
    { async close() {} } as never,
    pi,
  );

  const body = {};
  const token = await new InternalAssertionCodec(content.configuration).issue(
    "content-to-pi",
    teacher,
    { method: "POST", path: "/internal/er-start", body },
  );
  const accepted = await app.inject({
    method: "POST",
    url: "/internal/er-start",
    headers: {
      authorization: `Bearer ${token}`,
      "x-tenant-id": "forged-tenant",
      "x-user-id": "forged-user",
      "x-user-roles": "student",
      "x-mathpilot-runtime-secret": "forged-secret",
    },
    payload: body,
  });
  assert.equal(accepted.statusCode, 422);
  assert.match(accepted.headers["content-type"] ?? "", /^application\/problem\+json/);
  assert.equal(accepted.headers["cache-control"], "no-store");
  assert.equal(isProblemDetails(accepted.json()), true);
  assert.equal(accepted.json().code, "invalid_er_handoff");

  const replayed = await app.inject({
    method: "POST",
    url: "/internal/er-start",
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
  assert.equal(replayed.statusCode, 401);
  assert.equal(replayed.json().code, "internal_service_authentication_failed");

  const unsigned = await app.inject({
    method: "POST",
    url: "/internal/review-feedback",
    headers: {
      "x-tenant-id": teacher.tenantId,
      "x-user-id": teacher.userId,
      "x-user-roles": "teacher",
    },
    payload: body,
  });
  assert.equal(unsigned.statusCode, 401);

  const retiredSurface = await app.inject({ method: "GET", url: "/pi/models" });
  assert.equal(retiredSurface.statusCode, 404);
  await app.close();
});
