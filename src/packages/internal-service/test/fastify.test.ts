import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { installProblemDetails, isProblemDetails, sendProblem, startFastifyService } from "../src/fastify.ts";

function fakeApp(events: string[], listen: () => Promise<void>): FastifyInstance {
  const onClose: Array<() => void | Promise<void>> = [];
  const app = {
    get() { return app; },
    setErrorHandler() { return app; },
    setNotFoundHandler() { return app; },
    addHook(name: string, hook: () => void | Promise<void>) {
      assert.equal(name, "onClose");
      onClose.push(hook);
      return app;
    },
    listen,
    async close() {
      events.push("app.close");
      for (const hook of onClose) await hook();
    },
  };
  return app as unknown as FastifyInstance;
}

type InjectedResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

const assertProblem = (response: InjectedResponse) => {
  assert.match(String(response.headers["content-type"]), /^application\/problem\+json/);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(isProblemDetails(response.json()), true);
};

test("shared Problem Details handler normalizes parser, validation, body limit, not-found and unknown failures", async () => {
  const app = Fastify({ bodyLimit: 16 });
  installProblemDetails(app);
  app.post("/validated", {
    schema: { body: { type: "object", required: ["name"], properties: { name: { type: "string" } } } },
  }, async () => ({ ok: true }));
  app.get("/unknown", async () => { throw new Error("secret SQL token /srv/private.ts"); });

  const invalidJson = await app.inject({ method: "POST", url: "/validated", headers: { "content-type": "application/json" }, payload: "{" });
  assert.equal(invalidJson.statusCode, 400); assertProblem(invalidJson);
  assert.equal(invalidJson.json().code, "invalid_json_body");

  const invalidContentLength = await app.inject({
    method: "POST",
    url: "/validated",
    headers: { "content-type": "application/json", "content-length": "3" },
    payload: "{}",
  });
  assert.equal(invalidContentLength.statusCode, 400); assertProblem(invalidContentLength);
  assert.equal(invalidContentLength.json().code, "invalid_content_length");

  const invalidShape = await app.inject({ method: "POST", url: "/validated", payload: {} });
  assert.equal(invalidShape.statusCode, 422); assertProblem(invalidShape);
  assert.equal(invalidShape.json().code, "request_validation_failed");

  const tooLarge = await app.inject({ method: "POST", url: "/validated", payload: { name: "x".repeat(40) } });
  assert.equal(tooLarge.statusCode, 413); assertProblem(tooLarge);
  assert.equal(tooLarge.json().code, "request_body_too_large");

  const missing = await app.inject({ method: "GET", url: "/missing" });
  assert.equal(missing.statusCode, 404); assertProblem(missing);
  assert.equal(missing.json().code, "route_not_found");

  const unknown = await app.inject({ method: "GET", url: "/unknown" });
  assert.equal(unknown.statusCode, 500); assertProblem(unknown);
  assert.equal(unknown.json().code, "internal_server_error");
  assert.doesNotMatch(unknown.body, /secret|SQL|token|private/);
  await app.close();
});

test("known adapters still use the sole encoder and approved extensions", async () => {
  const app = Fastify();
  installProblemDetails(app, (error) => error instanceof Error && error.name === "KnownError" ? {
    status: 409, code: "version_conflict", title: "Version conflict", current_version: 7,
  } : undefined);
  app.get("/known", async () => { const error = new Error("private domain explanation"); error.name = "KnownError"; throw error; });
  app.get("/direct", async (_request, reply) => sendProblem(reply, { status: 403, code: "access_denied", title: "Access denied" }));
  app.get("/invalid-descriptor", async (_request, reply) => sendProblem(reply, {
    status: 409, code: "INVALID CODE", title: "must not reach the wire",
  } as never));
  const known = await app.inject("/known");
  assertProblem(known); assert.deepEqual(known.json(), {
    type: "urn:mathpilot:problem:version-conflict", title: "Version conflict", status: 409,
    code: "version_conflict", current_version: 7,
  });
  const direct = await app.inject("/direct"); assertProblem(direct);
  const invalid = await app.inject("/invalid-descriptor"); assertProblem(invalid);
  assert.deepEqual(invalid.json(), {
    type: "urn:mathpilot:problem:internal-server-error",
    title: "Internal server error",
    status: 500,
    code: "internal_server_error",
  });
  await app.close();
});

test("transport errors take precedence over a catch-all domain mapper", async () => {
  const app = Fastify({ bodyLimit: 8 });
  installProblemDetails(app, () => ({ status: 500, code: "domain_failed", title: "Domain failed" }));
  app.post("/body", async () => ({ ok: true }));
  app.get("/domain", async () => { throw new Error("domain detail"); });
  const body = await app.inject({ method: "POST", url: "/body", payload: { value: "too long" } });
  assert.equal(body.statusCode, 413); assert.equal(body.json().code, "request_body_too_large");
  const domain = await app.inject("/domain");
  assert.equal(domain.statusCode, 500); assert.equal(domain.json().code, "domain_failed");
  await app.close();
});

test("register failure closes the app and invokes already-owned resources", async () => {
  const events: string[] = [];
  const app = fakeApp(events, async () => { events.push("unexpected.listen"); });

  await assert.rejects(
    startFastifyService({
      name: "register-failure-test",
      port: 3000,
      register(server) {
        server.addHook("onClose", async () => { events.push("resources.closed"); });
        events.push("register.failed");
        throw new Error("registration failed");
      },
    }, { createApp: () => app }),
    /registration failed/,
  );

  assert.deepEqual(events, ["register.failed", "app.close", "resources.closed"]);
});

test("listener failure uses the same close path and forwards bodyLimit", async () => {
  const events: string[] = [];
  const app = fakeApp(events, async () => {
    events.push("listen.failed");
    throw new Error("address already in use");
  });

  await assert.rejects(
    startFastifyService({
      name: "listener-failure-test",
      port: 3001,
      bodyLimit: 2 * 1024 * 1024,
      register(server) {
        server.addHook("onClose", async () => { events.push("resources.closed"); });
      },
    }, {
      createApp(options) {
        assert.equal(options.bodyLimit, 2 * 1024 * 1024);
        return app;
      },
    }),
    /address already in use/,
  );

  assert.deepEqual(events, ["listen.failed", "app.close", "resources.closed"]);
});
