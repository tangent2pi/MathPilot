// Run inside the learning image with cwd /app/src/services/learning-next:
// node --import tsx /app/deploy/dev/agent-tools-smoke.mjs (bind-mount deploy/dev read-only).
// No model calls or database writes; verifies the reused plugin against the real container sandbox.
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import sandboxExtension from "../../src/services/pi-chat-runtime/extensions/sandbox.ts";

const requireRuntime = createRequire(new URL("../../src/services/pi-chat-runtime/package.json", import.meta.url));
const { SandboxManager } = await import(requireRuntime.resolve("@anthropic-ai/sandbox-runtime"));
const root = process.env.LEARNING_NEXT_RUNTIME_ROOT ?? "/tmp";
const cwd = await mkdtemp(path.join(root, "agent-tool-smoke-"));
await Promise.all(["input", "output", "tmp"].map((name) => mkdir(path.join(cwd, name))));
const tools = new Map();
try {
  await sandboxExtension({ registerTool: (tool) => tools.set(tool.name, tool) }, cwd);
  assert.deepEqual([...tools.keys()].sort(), ["bash", "edit", "read", "write"]);
  const call = (name, args) => tools.get(name).execute("smoke", args, new AbortController().signal, undefined, { cwd });
  const calculation = await call("bash", { command: "python3 -c 'import sympy; print(sympy.simplify((sympy.sqrt(2))**2))'", timeout: 15 });
  assert.match(JSON.stringify(calculation.content), /2/);
  await call("write", { path: "output/probe.txt", content: "mathpilot-sandbox-ok" });
  const read = await call("read", { path: "output/probe.txt" });
  assert.match(JSON.stringify(read.content), /mathpilot-sandbox-ok/);
  const isolation = await call("bash", { command: "test ! -r /app/package.json && test -z \"$MODEL_API_KEY\" && echo isolation-ok", timeout: 15 });
  assert.match(JSON.stringify(isolation.content), /isolation-ok/);
  console.log(JSON.stringify({ sandbox: "ok", tools: [...tools.keys()], symbolic_calculation: "ok", write_read: "ok", host_isolation: "ok" }));
} finally {
  await SandboxManager.reset();
}
