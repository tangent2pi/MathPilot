import assert from "node:assert/strict";
import test from "node:test";
import { dispatchAutoPrivateApprovals } from "./command-dispatch.ts";

test("background polling never approves teacher candidates", async () => {
  let reads = 0;
  let approvals = 0;
  await dispatchAutoPrivateApprovals({ pendingAutoPrivateCandidates: async () => { reads++; return []; }, decide: async () => { approvals++; return {}; } } as any, { error() {} });
  assert.equal(reads, 0);
  assert.equal(approvals, 0);
});
