/**
 * Pi native file tools executed through Anthropic's official Sandbox Runtime.
 * The runtime owns Bubblewrap argument construction; this extension only
 * supplies the MathPilot policy and a scrubbed child environment.
 */
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { CONTENT_POLICIES } from "@mathpilot/content-integrity";
import { identifyImageBytes } from "@mathpilot/content-integrity/node";
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
import { mathPilotSandboxConfig, safeSandboxEnvironment, spawnOfficialSandbox } from "../src/sandbox-runtime.ts";

const skillsRoot = () => process.env.PI_CHAT_SANDBOX_SKILLS_ROOT
  ?? (process.env.PI_CODING_AGENT_DIR
    ? path.join(process.env.PI_CODING_AGENT_DIR, "skills")
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../skills"));
const MAXIMUM_READ_BYTES = CONTENT_POLICIES.thread.maximumSourceBytes;
const MAXIMUM_TEXT_OUTPUT_BYTES = 1024 * 1024;
const MAXIMUM_ERROR_BYTES = 64 * 1024;
const FILE_OPERATION_TIMEOUT_MS = 30_000;

export const sandboxToolConfig = (cwd: string): SandboxRuntimeConfig => mathPilotSandboxConfig({
  // The outer development container cannot run SRT's optional nested seccomp
  // helper. Host Unix sockets remain absent behind the private network
  // namespace and deny-root filesystem policy.
  workspace:cwd,
  allowedDomains:[],
  allowRead:[path.join(cwd,"AGENTS.md"),path.join(cwd,"input"),path.join(cwd,"task"),skillsRoot()],
  allowWrite:[path.join(cwd,"output"),path.join(cwd,"tmp")],
});

const spawnSandboxTool = async (
  command: string,
  cwd: string,
  options: {
    detached?: boolean;
    signal?: AbortSignal | undefined;
    stdio: ["ignore" | "pipe", "ignore" | "pipe", "pipe"];
  },
): Promise<ChildProcess> => {
  return spawnOfficialSandbox({
    command,cwd,config:sandboxToolConfig(cwd),signal:options.signal,detached:options.detached,stdio:options.stdio,
    env:safeSandboxEnvironment({
      home:path.join(cwd,"tmp"),path:"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    }),
  });
};

const shellArg = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export const collectBoundedBytes = async (
  source: AsyncIterable<Uint8Array>,
  maximumBytes: number,
): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let byteSize = 0;
  for await (const value of source) {
    const chunk = Buffer.from(value);
    byteSize += chunk.byteLength;
    if (byteSize > maximumBytes) {
      throw new Error(`sandbox output exceeds ${maximumBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, byteSize);
};

const runSandboxedBytes = async (
  command: string,
  cwd: string,
  maximumBytes: number,
  options: {
    signal?: AbortSignal | undefined;
    stdin?: string | Uint8Array | undefined;
  } = {},
): Promise<Buffer> => {
  const child = await spawnSandboxTool(command, cwd, {
    signal: options.signal,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const onAbort = () => child.kill("SIGKILL");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 0));
  });
  try {
    const stdoutPromise = collectBoundedBytes(child.stdout!, maximumBytes).catch((error) => {
      child.kill("SIGKILL");
      throw error;
    });
    const stderrPromise = collectBoundedBytes(child.stderr!, MAXIMUM_ERROR_BYTES).catch((error) => {
      child.kill("SIGKILL");
      throw error;
    });
    const stdinPromise = new Promise<void>((resolve, reject) => {
      const stdin = child.stdin!;
      const failed = (error: Error) => {
        stdin.removeListener("error", failed);
        child.kill("SIGKILL");
        reject(error);
      };
      const completed = () => {
        stdin.removeListener("error", failed);
        resolve();
      };
      stdin.once("error", failed);
      if (options.stdin === undefined) stdin.end(completed);
      else stdin.end(options.stdin, completed);
    });
    const [stdout, stderr, code] = await Promise.all([stdoutPromise, stderrPromise, stdinPromise, exited])
      .then(([stdout, stderr, , code]) => [stdout, stderr, code] as const);
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error ? options.signal.reason : new Error("aborted");
    }
    if (code !== 0) {
      const detail = (stderr.byteLength > 0 ? stderr : stdout).toString("utf8");
      throw new Error(`sandbox command failed (${code}): ${detail}`);
    }
    return stdout;
  } catch (error) {
    child.kill("SIGKILL");
    await exited.catch(() => undefined);
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    SandboxManager.cleanupAfterCommand();
  }
};

const runSandboxedText = async (command: string, cwd: string, signal?: AbortSignal): Promise<string> =>
  new TextDecoder("utf-8", { fatal: true }).decode(
    await runSandboxedBytes(command, cwd, MAXIMUM_TEXT_OUTPUT_BYTES, { signal }),
  );

const fileOperationSignal = (signal?: AbortSignal): AbortSignal => signal
  ? AbortSignal.any([signal, AbortSignal.timeout(FILE_OPERATION_TIMEOUT_MS)])
  : AbortSignal.timeout(FILE_OPERATION_TIMEOUT_MS);

const readSandboxedBytes = (absolutePath: string, cwd: string, signal?: AbortSignal): Promise<Buffer> =>
  runSandboxedBytes(
    `cat -- ${shellArg(absolutePath)}`,
    cwd,
    MAXIMUM_READ_BYTES,
    { signal: fileOperationSignal(signal) },
  );

export const detectVerifiedImageMimeType = (bytes: Uint8Array): Promise<string | undefined> =>
  identifyImageBytes(bytes, MAXIMUM_READ_BYTES);

export const detectSandboxedImageMimeType = async (
  read: () => Promise<Uint8Array>,
): Promise<string | undefined> => detectVerifiedImageMimeType(await read());

const sandboxedBashOps = (): BashOperations => ({
  async exec(command, execCwd, { onData, signal, timeout }) {
    const child = await spawnSandboxTool(command, execCwd, {
      detached: true,
      signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return new Promise((resolve, reject) => {
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      let finished = false;
      const kill = () => {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      };
      const finish = (): boolean => {
        if (finished) return false;
        finished = true;
        SandboxManager.cleanupAfterCommand();
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        return true;
      };
      const onAbort = () => kill();
      if (timeout !== undefined && timeout > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          kill();
        }, timeout * 1000);
      }
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.once("error", (error) => {
        if (finish()) reject(error);
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      child.once("close", (code) => {
        if (!finish()) return;
        if (signal?.aborted) reject(new Error("aborted"));
        else if (timedOut) reject(new Error(`timeout:${timeout}`));
        else resolve({ exitCode: code ?? 0 });
      });
    });
  },
});

const sandboxedReadOps = (cwd: string, signal?: AbortSignal): ReadOperations => ({
  async readFile(absolutePath) {
    return readSandboxedBytes(absolutePath, cwd, signal);
  },
  async access(absolutePath) {
    await runSandboxedText(
      `test -r ${shellArg(absolutePath)}`,
      cwd,
      fileOperationSignal(signal),
    );
  },
  async detectImageMimeType(absolutePath) {
    return detectSandboxedImageMimeType(() => readSandboxedBytes(absolutePath, cwd, signal));
  },
});

const sandboxedWriteOps = (cwd: string, signal?: AbortSignal): WriteOperations => ({
  async writeFile(absolutePath, content) {
    await runSandboxedBytes(
      `cat > ${shellArg(absolutePath)}`,
      cwd,
      MAXIMUM_TEXT_OUTPUT_BYTES,
      { signal: fileOperationSignal(signal), stdin: content },
    );
  },
  async mkdir(directory) {
    await runSandboxedText(
      `mkdir -p -- ${shellArg(directory)}`,
      cwd,
      fileOperationSignal(signal),
    );
  },
});

const sandboxedEditOps = (cwd: string, signal?: AbortSignal): EditOperations => ({
  readFile: sandboxedReadOps(cwd, signal).readFile,
  writeFile: sandboxedWriteOps(cwd, signal).writeFile,
  access: sandboxedReadOps(cwd, signal).access,
});

export default async (pi: ExtensionAPI) => {
  await SandboxManager.initialize(sandboxToolConfig(process.cwd()));

  pi.registerTool({
    ...createBashTool(process.cwd(), { operations: sandboxedBashOps() }),
    execute: (id, params, signal, onUpdate, ctx) =>
      createBashTool(ctx.cwd, { operations: sandboxedBashOps() }).execute(id, params, signal, onUpdate),
  });
  pi.registerTool({
    ...createReadTool(process.cwd()),
    execute: (id, params, signal, onUpdate, ctx) =>
      createReadTool(ctx.cwd, { operations: sandboxedReadOps(ctx.cwd, signal) }).execute(id, params, signal, onUpdate),
  });
  pi.registerTool({
    ...createWriteTool(process.cwd()),
    execute: (id, params, signal, onUpdate, ctx) =>
      createWriteTool(ctx.cwd, { operations: sandboxedWriteOps(ctx.cwd, signal) }).execute(id, params, signal, onUpdate),
  });
  pi.registerTool({
    ...createEditTool(process.cwd()),
    execute: (id, params, signal, onUpdate, ctx) =>
      createEditTool(ctx.cwd, { operations: sandboxedEditOps(ctx.cwd, signal) }).execute(id, params, signal, onUpdate),
  });
};
