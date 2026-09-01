import assert from "node:assert/strict";
import test from "node:test";
import { fetchCurrentAccount } from "../src/lib/current-account.ts";
import { HttpProblemError } from "../src/lib/http-problem.ts";

test("the current-account request uses the shared Problem decoder", async () => {
  await assert.rejects(
    fetchCurrentAccount(undefined, async () => new Response(JSON.stringify({
      type: "urn:mathpilot:problem:authentication-required",
      title: "Authentication required",
      status: 401,
      code: "authentication_required",
    }), { status: 401, headers: { "content-type": "application/problem+json" } })),
    (error: unknown) => error instanceof HttpProblemError && error.code === "authentication_required",
  );
});

test("the current-account request never exposes a non-Problem error body", async () => {
  await assert.rejects(
    fetchCurrentAccount(undefined, async () => new Response('{"error":"secret account SQL path"}', {
      status: 500,
      headers: { "content-type": "application/json" },
    })),
    (error: unknown) => error instanceof HttpProblemError && !/secret|SQL|path/.test(error.message),
  );
});
