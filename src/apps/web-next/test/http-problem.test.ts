import assert from "node:assert/strict";
import test from "node:test";
import { responseJson, responseProblem } from "../src/lib/http-problem.ts";

test("the shared browser decoder prefers safe Problem detail and ignores legacy error bodies", async () => {
  const problem = await responseProblem(new Response(JSON.stringify({
    type: "urn:mathpilot:problem:version-conflict",
    title: "Version conflict",
    detail: "Refresh and retry.",
    status: 409,
    code: "version_conflict",
    current_version: 8,
  }), { status: 409, headers: { "content-type": "application/problem+json" } }));
  assert.equal(problem.message, "Refresh and retry.");
  assert.equal(problem.code, "version_conflict");
  assert.equal(problem.currentVersion, 8);

  const legacy = await responseProblem(new Response(JSON.stringify({ error: "secret legacy detail" }), {
    status: 502,
    headers: { "content-type": "application/json" },
  }), "服务不可用");
  assert.equal(legacy.message, "服务不可用（502）");
  assert.doesNotMatch(legacy.message, /secret|legacy/);

  const wrongMediaType = await responseProblem(new Response(JSON.stringify({
    type: "urn:mathpilot:problem:private-error",
    title: "secret title",
    status: 400,
    code: "private_error",
  }), { status: 400, headers: { "content-type": "application/json" } }), "请求无效");
  assert.equal(wrongMediaType.message, "请求无效（400）");
  assert.doesNotMatch(wrongMediaType.message, /secret/);
});

test("the shared decoder preserves successful empty response semantics", async () => {
  assert.equal(await responseJson<void>(new Response(null, { status: 204 })), undefined);
  assert.equal(await responseJson<void>(new Response(null, { status: 200, headers: { "content-length": "0" } })), undefined);
  assert.deepEqual(await responseJson<{ ok: boolean }>(new Response('{"ok":true}', { status: 200 })), { ok: true });
});
