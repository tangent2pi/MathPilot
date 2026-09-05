/**
 * Pi native file tools executed through Anthropic's official Sandbox Runtime.
 * The runtime owns Bubblewrap argument construction; this extension only
 * supplies the MathPilot policy and a scrubbed child environment.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
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

const skillsRoot = () => process.env.PI_CHAT_SANDBOX_SKILLS_ROOT
  ?? (process.env.PI_CODING_AGENT_DIR
    ? path.join(process.env.PI_CODING_AGENT_DIR, "skills")
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../skills"));
const SANDBOX_RUNTIME_VENDOR = path.join(
  path.dirname(createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime/package.json")),
  "vendor",
);
const SYSTEM_READ_PATHS = ["/usr", "/bin", "/lib", "/lib64", "/etc"];

export const sandboxToolConfig = (cwd: string): SandboxRuntimeConfig => ({
  // The outer development container cannot run SRT's optional nested seccomp
  // helper. Host Unix sockets remain absent behind the private network
  // namespace and deny-root filesystem policy.
  network: {
    allowedDomains: [],
    deniedDomains: [],
    strictAllowlist: true,
    allowAllUnixSockets: true,
  },
  filesystem: {
    // SRT implements this as deny-root then allow-back. This prevents a tool
    // from discovering /app, /opt, /var/lib siblings, or host credentials.
    denyRead: ["/", "/sys", path.join(cwd, ".agent")],
    allowRead: [
      path.join(cwd, "AGENTS.md"),
      path.join(cwd, "input"),
      path.join(cwd, "task"),
      skillsRoot(),
      SANDBOX_RUNTIME_VENDOR,
      ...SYSTEM_READ_PATHS,
    ],
    allowWrite: [path.join(cwd, "output"), path.join(cwd, "tmp")],
    denyWrite: [path.join(cwd, "input"), path.join(cwd, ".agent")],
  },
  enableWeakerNestedSandbox: false,
});

const safeChildEnv = (cwd: string): NodeJS.ProcessEnv => ({
  HOME: path.join(cwd, "tmp"),
  TMPDIR: path.join(cwd, "tmp"),
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
});

const spawnOfficialSandbox = async (
  command: string,
  cwd: string,
  options: {
    detached?: boolean;
    signal?: AbortSignal | undefined;
    stdio: ["ignore" | "pipe", "ignore" | "pipe", "pipe"];
  },
): Promise<ChildProcess> => {
  const descriptor = await SandboxManager.wrapWithSandboxArgv(
    command,
    "/bin/bash",
    sandboxToolConfig(cwd),
    options.signal,
    cwd,
  );
  // Strong Linux mode handles uid 0 explicitly: SRT creates a user namespace
  // and drops all capabilities before executing the command.
  return spawn(descriptor.argv[0]!, descriptor.argv.slice(1), {
    cwd,
    detached: options.detached,
    stdio: options.stdio,
    env: safeChildEnv(cwd),
  });
};

const shellArg = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const runSandboxed = (command: string, cwd: string, signal?: AbortSignal): Promise<string> =>
  new Promise((resolve, reject) => {
    void spawnOfficialSandbox(command, cwd, { signal, stdio: ["pipe", "pipe", "pipe"] })
      .then((child) => {
        let stdout = "";
        let stderr = "";
        const onAbort = () => child.kill("SIGKILL");
        signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout!.on("data", (data) => (stdout += data));
        child.stderr!.on("data", (data) => (stderr += data));
        child.on("error", reject);
        child.on("close", (code) => {
          SandboxManager.cleanupAfterCommand();
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) reject(new Error("aborted"));
          else if (code === 0) resolve(stdout);
          else reject(new Error(`sandbox command failed (${code}): ${stderr || stdout}`));
        });
      })
      .catch(reject);
  });

const sandboxedBashOps = (): BashOperations => ({
  async exec(command, execCwd, { onData, signal, timeout }) {
    const child = await spawnOfficialSandbox(command, execCwd, {
      detached: true,
      signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return new Promise((resolve, reject) => {
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      const kill = () => {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      };
      if (timeout !== undefined && timeout > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          kill();
        }, timeout * 1000);
      }
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.on("error", reject);
      const onAbort = () => kill();
      signal?.addEventListener("abort", onAbort, { once: true });
      child.on("close", (code) => {
        SandboxManager.cleanupAfterCommand();
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
    return Buffer.from(await runSandboxed(`cat -- ${shellArg(absolutePath)}`, cwd), "utf8");
  },
  async access(absolutePath) {
    await runSandboxed(`test -r ${shellArg(absolutePath)}`, cwd);
  },
  async detectImageMimeType(absolutePath) {
    try {
      const hex = (await runSandboxed(`head -c 16 -- ${shellArg(absolutePath)} | xxd -p`, cwd)).trim();
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
    const child = await spawnOfficialSandbox(`cat > ${shellArg(absolutePath)}`, cwd, {
      stdio: ["pipe", "ignore", "pipe"],
    });
    return new Promise((resolve, reject) => {
      let stderr = "";
      child.stderr?.on("data", (data) => (stderr += data));
      child.on("error", reject);
      child.on("close", (code) => {
        SandboxManager.cleanupAfterCommand();
        if (code === 0) resolve();
        else reject(new Error(`write failed (${code}): ${stderr}`));
      });
      child.stdin!.end(content);
    });
  },
  async mkdir(directory) {
    await runSandboxed(`mkdir -p -- ${shellArg(directory)}`, cwd);
  },
});

const sandboxedEditOps = (cwd: string): EditOperations => ({
  readFile: sandboxedReadOps(cwd).readFile,
  writeFile: sandboxedWriteOps(cwd).writeFile,
  access: sandboxedReadOps(cwd).access,
});

export default async (pi: ExtensionAPI, cwd = process.cwd()) => {
  await SandboxManager.initialize(sandboxToolConfig(cwd));

  pi.registerTool({
    ...createBashTool(cwd, { operations: sandboxedBashOps() }),
    execute: (id, params, signal, onUpdate, ctx) =>
      createBashTool(ctx.cwd, { operations: sandboxedBashOps() }).execute(id, params, signal, onUpdate),
  });
  pi.registerTool({
    ...createReadTool(cwd),
    execute: (id, params, signal, onUpdate, ctx) =>
      createReadTool(ctx.cwd, { operations: sandboxedReadOps(ctx.cwd) }).execute(id, params, signal, onUpdate),
  });
  pi.registerTool({
    ...createWriteTool(cwd),
    execute: (id, params, signal, onUpdate, ctx) =>
      createWriteTool(ctx.cwd, { operations: sandboxedWriteOps(ctx.cwd) }).execute(id, params, signal, onUpdate),
  });
  pi.registerTool({
    ...createEditTool(cwd),
    execute: (id, params, signal, onUpdate, ctx) =>
      createEditTool(ctx.cwd, { operations: sandboxedEditOps(ctx.cwd) }).execute(id, params, signal, onUpdate),
  });
};
