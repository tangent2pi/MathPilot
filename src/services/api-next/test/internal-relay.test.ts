import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import {
  createInternalServiceRuntime,
  type InternalEdgeId,
  type InternalServiceId,
} from "@mathpilot/internal-service";
import { internalServiceTestEnvironment } from "@mathpilot/internal-service/testing";
import Fastify from "fastify";
import { relayContent, relayStorage } from "../src/internal-relay.ts";

const actor = Object.freeze({
  tenantId: "tnt_primary01",
  userId: "usr_teacher01",
  roles: ["teacher"] as const,
});

const scenarios = [
  {
    name: "content",
    edge: "api-to-content" as InternalEdgeId,
    receiver: "content-next" as InternalServiceId,
    targetEnv: "MATHPILOT_INTERNAL_CONTENT_URL",
    browserPath: "/api/content/candidates?cursor=next",
    internalPath: "/candidates?cursor=next",
    relay: relayContent,
  },
  {
    name: "storage",
    edge: "api-to-storage" as InternalEdgeId,
    receiver: "storage-next" as InternalServiceId,
    targetEnv: "MATHPILOT_INTERNAL_STORAGE_URL",
    browserPath: "/api/storage/objects/obj_abcdefgh/presign-get?download=1",
    internalPath: "/internal/objects/obj_abcdefgh/presign-get?download=1",
    relay: relayStorage,
  },
] as const;

for (const scenario of scenarios) {
  test(`api-next relays ${scenario.name} through a request-bound signed edge assertion`, async () => {
    let serverFailure: unknown;
    let observedPath: string | undefined;
    const payload = { audience: "browser", nested: { answer: 42 } };
    const receiver = createInternalServiceRuntime(
      scenario.receiver,
      internalServiceTestEnvironment(),
    );
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        observedPath = request.url;
        assert.equal(request.headers["x-mathpilot-runtime-secret"], undefined);
        assert.equal(request.headers["x-tenant-id"], undefined);
        assert.equal(request.headers["x-user-id"], undefined);
        assert.equal(request.headers["x-user-roles"], undefined);
        const context = await receiver.authenticate(
          [scenario.edge],
          request.headers.authorization,
          { method: request.method!, path: request.url!, body },
        );
        response.statusCode = 207;
        response.setHeader("content-type", "application/json");
        response.setHeader("cache-control", "private, no-store");
        response.setHeader("x-content-type-options", "upstream-must-not-own-this");
        response.setHeader("etag", '"relay-v1"');
        response.setHeader("last-modified", "Tue, 01 Sep 2026 00:00:00 GMT");
        response.end(JSON.stringify({ actor: context.actor, body }));
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
    const source = internalServiceTestEnvironment({
      [scenario.targetEnv]: `http://127.0.0.1:${address.port}`,
    });
    const caller = createInternalServiceRuntime("api-next", source);
    const app = Fastify();
    app.post(`/api/${scenario.name}/*`, async (request, reply) =>
      scenario.relay(caller, actor, request, reply));

    try {
      const response = await app.inject({
        method: "POST",
        url: scenario.browserPath,
        payload,
      });
      if (serverFailure) throw serverFailure;
      assert.equal(response.statusCode, 207);
      assert.equal(response.headers["cache-control"], "private, no-store");
      assert.equal(response.headers["x-content-type-options"], undefined);
      assert.equal(response.headers.etag, '"relay-v1"');
      assert.equal(response.headers["last-modified"], "Tue, 01 Sep 2026 00:00:00 GMT");
      assert.equal(observedPath, scenario.internalPath);
      assert.deepEqual(response.json(), { actor, body: payload });
    } finally {
      await app.close();
      server.close();
      await once(server, "close");
    }
  });
}

test("relay preserves conforming Problems and replaces non-conforming upstream errors", async () => {
  const conforming = JSON.stringify({
    type: "urn:mathpilot:problem:candidate-rate-limited",
    title: "Candidate rate limited",
    status: 429,
    code: "candidate_rate_limited",
  });
  const server = createServer((request, response) => {
    if (request.url === "/conforming") {
      response.writeHead(429, {
        "content-type": "application/problem+json; charset=utf-8",
        "cache-control": "public, max-age=3600",
        "content-disposition": "attachment; filename=secret.json",
        "retry-after": "23",
      });
      response.end(conforming);
      return;
    }
    response.writeHead(500, { "content-type": "application/json" });
    response.end('{"error":"secret SQL token /srv/content.ts"}');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const runtime = createInternalServiceRuntime("api-next", internalServiceTestEnvironment({
    MATHPILOT_INTERNAL_CONTENT_URL: `http://127.0.0.1:${address.port}`,
  }));
  const app = Fastify();
  app.get("/api/content/*", (request, reply) => relayContent(runtime, actor, request, reply));
  try {
    const accepted = await app.inject("/api/content/conforming");
    assert.equal(accepted.statusCode, 429);
    assert.equal(accepted.body, conforming);
    assert.match(accepted.headers["content-type"] ?? "", /^application\/problem\+json/);
    assert.equal(accepted.headers["cache-control"], "no-store");
    assert.equal(accepted.headers["retry-after"], "23");
    assert.equal(accepted.headers["content-disposition"], undefined);

    const rejected = await app.inject("/api/content/non-conforming");
    assert.equal(rejected.statusCode, 502);
    assert.equal(rejected.json().code, "invalid_upstream_response");
    assert.doesNotMatch(rejected.body, /secret|SQL|token|content\.ts/);
  } finally {
    await app.close(); server.close(); await once(server, "close");
  }
});
