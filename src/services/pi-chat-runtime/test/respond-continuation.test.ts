import assert from "node:assert/strict";
import test from "node:test";
import respond from "../extensions/respond.ts";

test("respond lets the agent produce a final natural-language reply", async () => {
  let registered: any;
  await respond({ registerTool(tool: any) { registered = tool; } } as any);
  assert.equal(registered.name, "respond");
  const result = await registered.execute("call", { output: { ok: true } }, undefined, undefined, { cwd: "/unused" });
  assert.notEqual(result.terminate, true);
  assert.ok(registered.description.includes("不结束对话"));
});
