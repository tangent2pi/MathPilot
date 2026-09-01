import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { installProblemDetails,isProblemDetails } from "@mathpilot/internal-service/fastify";

test("PostgreSQL domain rejections map to stable messages without exposing database detail", async () => {
  process.env.MATHPILOT_ENVIRONMENT = "development";
  const { commandErrorFromUnknown } = await import("../src/learning-command/service.ts");
  const secret = "secret SQL token /srv/api-private.ts";
  const cases = [
    { message: `version conflict: ${secret}`, code: "version_conflict" },
    { message: `idempotency mismatch: ${secret}`, code: "idempotency_conflict" },
    { message: `raise exception ${secret}`, code: "domain_conflict" },
  ];
  for (const input of cases) {
    const mapped = commandErrorFromUnknown({ code: "P0001", message: input.message });
    assert.ok(mapped);
    assert.equal(mapped.code, input.code);
    assert.equal(mapped.status, 409);
    assert.doesNotMatch(mapped.message, /secret|SQL|token|private/);
  }
});

test("Selection conflicts expose stable diagnostics and structured current version", async () => {
  const [{ SelectionCommandError }, { learningProblemFromError }] = await Promise.all([
    import("../src/learning-selection.ts"),
    import("../src/learning-http.ts"),
  ]);
  const mapped = learningProblemFromError(new SelectionCommandError(
    409,
    "selection_version_conflict",
    "Conversation thread version changed",
    "secret SQL says thread version is /srv/private.ts",
    17,
  ));
  assert.deepEqual(mapped, {
    status: 409,
    code: "selection_version_conflict",
    title: "Conversation thread version changed",
    current_version: 17,
  });
  assert.doesNotMatch(JSON.stringify(mapped), /secret|SQL|private/);
});

test("Learning PostgreSQL mapping is encapsulated from non-Learning routes", async () => {
  const { learningProblemFromError } = await import("../src/learning-http.ts");
  const app = Fastify();
  installProblemDetails(app);
  app.register(async (learningApp) => {
    installProblemDetails(learningApp,learningProblemFromError,{ installNotFound:false });
    learningApp.get("/api/learning/failure",async () => {
      throw Object.assign(new Error("secret SQL token /srv/learning"),{ code:"P0001" });
    });
  });
  app.get("/api/classes/failure",async () => {
    throw Object.assign(new Error("secret SQL token /srv/classes"),{ code:"P0001" });
  });

  const learning = await app.inject("/api/learning/failure");
  assert.equal(learning.statusCode,409);
  assert.equal(learning.headers["content-type"],"application/problem+json; charset=utf-8");
  assert.equal(learning.json().code,"domain_conflict");

  const outside = await app.inject("/api/classes/failure");
  assert.equal(outside.statusCode,500);
  assert.equal(outside.headers["content-type"],"application/problem+json; charset=utf-8");
  assert.equal(outside.json().code,"internal_server_error");
  assert.ok(isProblemDetails(outside.json()));
  assert.doesNotMatch(outside.body,/secret|SQL|token|classes/);
  await app.close();
});
