import assert from "node:assert/strict";
import test from "node:test";
import {
  InternalAssertionCodec,
  createInternalServiceRuntime,
  type InternalActor,
  type InternalEdgeId,
  type InternalServiceRuntime,
} from "@mathpilot/internal-service";
import { internalServiceContext, internalServiceGuard } from "@mathpilot/internal-service/fastify";
import { internalServiceTestEnvironment } from "@mathpilot/internal-service/testing";
import Fastify from "fastify";
import type { CandidateRepository } from "../src/candidate-repository.ts";
import { dispatchErCommands, type ErCommandRepository } from "../src/command-dispatch.ts";
import { registerContentNextRoutes } from "../src/routes.ts";

const signedTeacher = Object.freeze({
  tenantId: "tnt_signed",
  userId: "usr_signed_teacher",
  roles: ["teacher"] as const,
});

async function bearer(
  caller: InternalServiceRuntime,
  edge: InternalEdgeId,
  actor: InternalActor,
  method: string,
  path: string,
  body?: unknown,
): Promise<string> {
  const assertion = await new InternalAssertionCodec(caller.configuration).issue(edge, actor, {
    method,
    path,
    ...(body === undefined ? {} : { body }),
  });
  return `Bearer ${assertion}`;
}

test("content routes accept only their signed edge, consume assertions once, and ignore forged principal headers", async () => {
  const source = internalServiceTestEnvironment();
  const receiver = createInternalServiceRuntime("content-next", source);
  const api = createInternalServiceRuntime("api-next", source);
  const pi = createInternalServiceRuntime("pi-chat-runtime", source);
  const observedActors: InternalActor[] = [];
  const repository = {
    async listPackages(actor: InternalActor) {
      observedActors.push(actor);
      return [{ package_id: "pkg_test" }];
    },
    async frozenKtq(actor: InternalActor) {
      observedActors.push(actor);
      return { candidate_set_id: "cnd_test", frozen: true };
    },
  } as unknown as CandidateRepository;
  const app = Fastify();
  registerContentNextRoutes(app, repository, receiver);

  const apiAuthorization = await bearer(api, "api-to-content", signedTeacher, "GET", "/packages");
  const acceptedApi = await app.inject({
    method: "GET",
    url: "/packages",
    headers: {
      authorization: apiAuthorization,
      "x-tenant-id": "tnt_forged",
      "x-user-id": "usr_forged",
      "x-user-roles": "student",
    },
  });
  assert.equal(acceptedApi.statusCode, 200);
  assert.deepEqual(acceptedApi.json(), { packages: [{ package_id: "pkg_test" }] });
  assert.deepEqual(observedActors[0], signedTeacher);

  const replayed = await app.inject({ method: "GET", url: "/packages", headers: { authorization: apiAuthorization } });
  assert.equal(replayed.statusCode, 401);
  assert.equal(replayed.json().code, "internal_service_authentication_failed");

  const wrongApiEdge = await app.inject({
    method: "GET",
    url: "/packages",
    headers: { authorization: await bearer(pi, "pi-to-content", signedTeacher, "GET", "/packages") },
  });
  assert.equal(wrongApiEdge.statusCode, 401);

  const missing = await app.inject({ method: "GET", url: "/packages" });
  assert.equal(missing.statusCode, 401);

  const frozenPath = "/internal/candidates/cnd_test/frozen";
  const acceptedPi = await app.inject({
    method: "GET",
    url: frozenPath,
    headers: { authorization: await bearer(pi, "pi-to-content", signedTeacher, "GET", frozenPath) },
  });
  assert.equal(acceptedPi.statusCode, 200);
  assert.deepEqual(acceptedPi.json(), { candidate_set_id: "cnd_test", frozen: true });
  assert.deepEqual(observedActors[1], signedTeacher);

  const wrongPiEdge = await app.inject({
    method: "GET",
    url: frozenPath,
    headers: { authorization: await bearer(api, "api-to-content", signedTeacher, "GET", frozenPath) },
  });
  assert.equal(wrongPiEdge.statusCode, 401);

  await app.close();
});

test("each Content-to-Pi database retry gets a fresh assertion", async () => {
  const source = internalServiceTestEnvironment();
  const receivedAssertionIds: string[] = [];
  const receiver = createInternalServiceRuntime("pi-chat-runtime", source);
  const pi = Fastify();
  let requests = 0;
  pi.post(
    "/internal/er-start",
    { preHandler: internalServiceGuard(receiver, ["content-to-pi"]) },
    async (request, reply) => {
      receivedAssertionIds.push(internalServiceContext(request).assertionId);
      requests += 1;
      return requests === 1 ? reply.code(503).send({ error: "retry" }) : { accepted: true };
    },
  );
  const address = await pi.listen({ host: "127.0.0.1", port: 0 });
  try {
    const caller = createInternalServiceRuntime("content-next", {
      ...source,
      MATHPILOT_INTERNAL_PI_URL: address,
    });
    let attempts = 0;
    let dispatched = 0;
    const repository: ErCommandRepository = {
      async pendingCommands() {
        return [{
          command_id: "cmd_test",
          tenant_id: signedTeacher.tenantId,
          owner_user_id: signedTeacher.userId,
          approved_ktq_candidate_set_id: "cnd_test",
          target_thread_id: "thr_test",
          attempt_count: attempts,
        }];
      },
      async markCommandAttempt() { attempts += 1; },
      async markCommandDispatched() { dispatched += 1; },
    };
    const log = { error: () => undefined };

    await dispatchErCommands(repository, caller, log);
    await dispatchErCommands(repository, caller, log);

    assert.equal(attempts, 1);
    assert.equal(dispatched, 1);
    assert.equal(receivedAssertionIds.length, 2);
    assert.notEqual(receivedAssertionIds[0], receivedAssertionIds[1]);
  } finally {
    await pi.close();
  }
});
