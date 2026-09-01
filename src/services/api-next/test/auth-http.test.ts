import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { isProblemDetails } from "@mathpilot/contracts";
import { forwardBetterAuthResponse } from "../src/auth-http.ts";

test("Better Auth 4xx stays provider-owned while the adapter adds boundary safety", async () => {
  const app = Fastify();
  app.get("/rejected", async (_request, reply) => forwardBetterAuthResponse(reply, new Response(
    JSON.stringify({ code: "INVALID_PASSWORD", message: "provider contract" }),
    {
      status: 400,
      headers: {
        "content-type": "application/json",
        "set-cookie": "mathpilot.session=cleared; Path=/; HttpOnly",
      },
    },
  )));
  const response = await app.inject("/rejected");
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { code: "INVALID_PASSWORD", message: "provider contract" });
  assert.match(response.headers["content-type"] ?? "", /^application\/json/);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.match(String(response.headers["set-cookie"]), /mathpilot\.session=cleared/);
  await app.close();
});

test("Better Auth rate limiting exposes the standard retry header", async () => {
  const app = Fastify();
  app.get("/limited", async (_request, reply) => forwardBetterAuthResponse(reply, new Response(
    JSON.stringify({ message: "Too many requests" }),
    { status: 429, headers: { "content-type": "application/json", "x-retry-after": "17" } },
  )));
  const response = await app.inject("/limited");
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers["retry-after"], "17");
  assert.equal(response.headers["cache-control"], "no-store");
  await app.close();
});

test("Better Auth server failures become a safe canonical Problem", async () => {
  const app = Fastify();
  app.get("/failed", async (_request, reply) => forwardBetterAuthResponse(reply, new Response(
    "secret SQL token /srv/auth-private.ts",
    { status: 503, headers: { "content-type": "text/plain", "set-cookie": "mathpilot.session=cleared; Path=/" } },
  )));
  const response = await app.inject("/failed");
  assert.equal(response.statusCode, 500);
  assert.match(response.headers["content-type"] ?? "", /^application\/problem\+json/);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(isProblemDetails(response.json()), true);
  assert.equal(response.json().code, "authentication_service_failed");
  assert.doesNotMatch(response.body, /secret|SQL|token|private/);
  assert.match(String(response.headers["set-cookie"]), /mathpilot\.session=cleared/);
  await app.close();
});
