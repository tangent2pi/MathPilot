/**
 * 四工具沙箱插件：Pi 原生工具构造器 + 官方 sandbox-runtime，按线程 cwd 隔离。
 * 能力通过 agentDir/extensions 注入，不修改 Pi 本体。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type BashOperations,
  type EditOperations,
  type ExtensionAPI,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";

const USER_HOME = os.homedir();
const skillsRoot = () => process.env.PI_CODING_AGENT_DIR
  ? path.join(process.env.PI_CODING_AGENT_DIR, "skills")
  : "/opt/mathpilot-skills";
const SANDBOX_RUNTIME_VENDOR = path.join(
  path.dirname(createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime/package.json")),
  "vendor",
);

const strictConfig = (cwd: string): SandboxRuntimeConfig => ({
  network: { allowedDomains: [], deniedDomains: [] },
  filesystem: {
    denyRead: [USER_HOME],
    allowRead: [cwd, skillsRoot(), SANDBOX_RUNTIME_VENDOR],
    allowWrite: [cwd],
    // Evidence and host-owned audit/publication state are never model-writable.
    denyWrite: [path.join(cwd, "input"), path.join(cwd, ".agent")],
  },
});

const runWrapped = (command: string, cwd: string, signal?: AbortSignal): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", command], { cwd, stdio: ["pipe", "pipe", "pipe"], signal });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`sandbox command failed (${code}): ${stderr || stdout}`));
    });
  });

const sandboxedBashOps = (): BashOperations => ({
  async exec(command, execCwd, { onData, signal, timeout }) {
    const wrapped = await SandboxManager.wrapWithSandbox(command, undefined, strictConfig(execCwd), signal);
    return new Promise((resolve, reject) => {
      const child = spawn("bash", ["-c", wrapped], {
        cwd: execCwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      if (timeout !== undefined && timeout > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }, timeout * 1000);
      }
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.on("error", reject);
      const onAbort = () => {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) reject(new Error("aborted"));
        else if (timedOut) reject(new Error(`timeout:${timeout}`));
        else resolve({ exitCode: code ?? 0 });
      });
    });
  },
});

const sandboxedReadOps = (cwd: string): ReadOperations => ({
  async readFile(absolutePath) {
    const wrapped = await SandboxManager.wrapWithSandbox(
      `cat ${JSON.stringify(absolutePath)}`, undefined, strictConfig(cwd));
    return Buffer.from(await runWrapped(wrapped, cwd), "utf8");
  },
  async access(absolutePath) {
    const wrapped = await SandboxManager.wrapWithSandbox(
      `test -r ${JSON.stringify(absolutePath)}`, undefined, strictConfig(cwd));
    await runWrapped(wrapped, cwd);
  },
  async detectImageMimeType(absolutePath) {
    const wrapped = await SandboxManager.wrapWithSandbox(
      `head -c 16 ${JSON.stringify(absolutePath)} | xxd -p`, undefined, strictConfig(cwd));
    try {
      const hex = (await runWrapped(wrapped, cwd)).trim();
      if (hex.startsWith("89504e47")) return "image/png";
      if (hex.startsWith("ffd8ff")) return "image/jpeg";
      if (hex.startsWith("52494646")) return "image/webp";
      return undefined;
    } catch {
      return undefined;
    }
  },
});

const sandboxedWriteOps = (cwd: string): WriteOperations => ({
  async writeFile(absolutePath, content) {
    const wrapped = await SandboxManager.wrapWithSandbox(
      `cat > ${JSON.stringify(absolutePath)}`, undefined, strictConfig(cwd));
    return new Promise((resolve, reject) => {
      const child = spawn("bash", ["-c", wrapped], { cwd, stdio: ["pipe", "ignore", "pipe"] });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`write failed: ${code}`))));
      child.stdin.end(content);
    });
  },
  async mkdir(directory) {
    const wrapped = await SandboxManager.wrapWithSandbox(
      `mkdir -p ${JSON.stringify(directory)}`, undefined, strictConfig(cwd));
    await runWrapped(wrapped, cwd);
  },
});

const sandboxedEditOps = (cwd: string): EditOperations => ({
  readFile: sandboxedReadOps(cwd).readFile,
  writeFile: sandboxedWriteOps(cwd).writeFile,
  access: sandboxedReadOps(cwd).access,
});

export default async (pi: ExtensionAPI) => {
  await SandboxManager.initialize({
    ...strictConfig(process.cwd()),
    enableWeakerNestedSandbox: process.env.MATHPILOT_PI_SANDBOX_NESTED === "true",
  });

  pi.registerTool({
    ...createBashTool(process.cwd(), { operations: sandboxedBashOps() }),
    execute: (id, params, signal, onUpdate, ctx) =>
      createBashTool(ctx.cwd, { operations: sandboxedBashOps() }).execute(id, params, signal, onUpdate),
  });
  pi.registerTool({
    ...createReadTool(process.cwd()),
    execute: (id, params, signal, onUpdate, ctx) =>
      createReadTool(ctx.cwd, { operations: sandboxedReadOps(ctx.cwd) }).execute(id, params, signal, onUpdate),
  });
  pi.registerTool({
    ...createWriteTool(process.cwd()),
    execute: (id, params, signal, onUpdate, ctx) =>
      createWriteTool(ctx.cwd, { operations: sandboxedWriteOps(ctx.cwd) }).execute(id, params, signal, onUpdate),
  });
  pi.registerTool({
    ...createEditTool(process.cwd()),
    execute: (id, params, signal, onUpdate, ctx) =>
      createEditTool(ctx.cwd, { operations: sandboxedEditOps(ctx.cwd) }).execute(id, params, signal, onUpdate),
  });
};
