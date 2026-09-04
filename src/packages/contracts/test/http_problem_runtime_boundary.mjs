import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const runtimeSources = await Promise.all([
  new URL("../src/http-problem.ts", import.meta.url),
  new URL("../src/generated/problem-details-validator.ts", import.meta.url),
].map((url) => readFile(url, "utf8")));
const runtime = runtimeSources.join("\n");

for (const forbidden of [
  /new\s+Function\b/,
  /\beval\s*\(/,
  /new\s+Ajv/,
  /\.compile\s*\(/,
  /(?:^|[;}\n])\s*require\s*\(/,
]) {
  assert.doesNotMatch(runtime, forbidden, `public Problem validator runtime contains ${forbidden}`);
}

const { default: validateProblemDetails } = await import(
  new URL("../src/generated/problem-details-validator.ts", import.meta.url)
);
const { publicProblemMessage,readProblemDetails } = await import(new URL("../src/http-problem.ts", import.meta.url));
assert.equal(validateProblemDetails({
  type: "urn:mathpilot:problem:unicode-check",
  title: "数学智元请求失败",
  status: 400,
  code: "unicode_check",
  detail: "请检查输入后重试。",
}), true);
assert.equal(validateProblemDetails({
  type: "urn:mathpilot:problem:unicode-check",
  title: "数".repeat(161),
  status: 400,
  code: "unicode_check",
}), false);
const problem = {
  type: "urn:mathpilot:problem:unicode-check",
  title: "数学智元请求失败",
  status: 409,
  code: "unicode_check",
};
const response = (status, contentType, body) => ({
  status,
  headers:{ get:(name) => name.toLowerCase()==="content-type" ? contentType : null },
  async json() { return body; },
});
assert.deepEqual(
  await readProblemDetails(response(409,"application/problem+json; charset=utf-8",problem)),
  problem,
);
assert.equal(await readProblemDetails(response(500,"application/problem+json",problem)),undefined);
let canceled = false;
assert.equal(await readProblemDetails({
  ...response(409,"application/json",{ error:"secret" }),
  body:{ async cancel() { canceled = true; } },
}),undefined);
assert.equal(canceled,true);
assert.equal(await readProblemDetails(response(500,"application/problem+json",{ error:"secret" })),undefined);
assert.equal(publicProblemMessage({ ...problem,detail:"请刷新后重试" }),"请刷新后重试");
assert.equal(publicProblemMessage({ ...problem,status:500,detail:"secret SQL /srv/private" }),problem.title);
console.log("PASS: public Problem validator is standalone and CSP-safe");
