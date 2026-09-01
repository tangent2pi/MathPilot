/**
 * One launcher for every MCP capability. Sandbox Runtime owns the Linux
 * sandbox implementation; this file only selects a capability policy.
 */
import { chmod, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { mathPilotSandboxConfig, safeSandboxEnvironment, spawnOfficialSandbox } from "../sandbox-runtime.ts";

type Capability = "core" | "search" | "ocr";

const definitions = {
  core: {
    executable: "/opt/qwen-mm/bin/qwen-mm-plugins-core",
    packageRoot: "/opt/qwen-mm",
    allowedDomains: [] as string[],
    nonSecretEnv: [] as string[],
    credentials: [] as Array<{ name: string; host: string }>,
  },
  search: {
    executable: "/opt/qwen-mm/bin/qwen-mm-plugins-search",
    packageRoot: "/opt/qwen-mm",
    allowedDomains: ["google.serper.dev", "api.tavily.com", "api.exa.ai", "uguu.se"],
    nonSecretEnv: ["QWEN_MM_SEARCH_BACKEND"],
    credentials: [
      { name: "SERPER_API_KEY", host: "google.serper.dev" },
      { name: "TAVILY_API_KEY", host: "api.tavily.com" },
      { name: "EXA_API_KEY", host: "api.exa.ai" },
    ],
  },
  ocr: {
    executable: "/opt/paddleocr-mcp/bin/paddleocr_mcp",
    packageRoot: "/opt/paddleocr-mcp",
    allowedDomains: [] as string[],
    nonSecretEnv: [
      "PADDLEOCR_MCP_MODEL",
      "PADDLEOCR_MCP_PPOCR_SOURCE",
      "PADDLEOCR_MCP_AISTUDIO_BASE_URL",
      "PADDLEOCR_MCP_AISTUDIO_REQUEST_TIMEOUT",
      "PADDLEOCR_MCP_AISTUDIO_POLL_TIMEOUT",
    ],
    credentials: [] as Array<{ name: string; host: string }>,
  },
} as const;

const parseCapability = (value: string | undefined): Capability => {
  if (value === "core" || value === "search" || value === "ocr") return value;
  throw new Error("capability must be core, search, or ocr");
};

const urlHost = (value: string | undefined, fallback: string): string => {
  const parsed = new URL(value || fallback);
  if (parsed.protocol !== "https:") throw new Error("OCR API base URL must use HTTPS");
  return parsed.hostname;
};

const inside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
};

const resolveWorkspace = async (): Promise<string> => {
  const configuredRoot = await realpath(process.env.PI_CHAT_WORKSPACE_ROOT ?? "/var/lib/mathpilot/pi-chat/sessions");
  const workspace = await realpath(process.cwd());
  if (!inside(configuredRoot, workspace)) throw new Error("capability cwd escapes the Pi workspace root");
  for (const relative of ["input", "output", "tmp"]) {
    if (!(await stat(path.join(workspace, relative))).isDirectory()) {
      throw new Error(`workspace is missing ${relative}/`);
    }
  }
  return workspace;
};

const safeEnvironment = (
  capability: Capability,
  home: string,
): NodeJS.ProcessEnv => {
  const definition = definitions[capability];
  const extra: Record<string,string> = {
    XDG_CACHE_HOME:home,PYTHONUNBUFFERED:"1",PYTHONDONTWRITEBYTECODE:"1",
  };
  for (const name of definition.nonSecretEnv) {
    const value = process.env[name];
    if (value !== undefined) extra[name] = value;
  }
  return safeSandboxEnvironment({ home,path:`${definition.packageRoot}/bin:/usr/local/bin:/usr/bin:/bin`,extra });
};

const capabilityConfig = (
  capability: Capability,
  workspace: string,
  executionRoot: string,
): SandboxRuntimeConfig => {
  const definition = definitions[capability];
  const ocrHost = capability === "ocr"
    ? urlHost(
        process.env.PADDLEOCR_MCP_AISTUDIO_BASE_URL,
        "https://paddleocr.aistudio-app.com",
      )
    : "";
  const allowedDomains = capability === "ocr"
    ? [ocrHost, "*.bcebos.com"]
    : [...definition.allowedDomains];
  const credentials = capability === "ocr"
    ? [{ name: "PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN", host: ocrHost }]
    : [...definition.credentials];
  const workspaceWrites = capability === "search"
    ? [executionRoot]
    : [path.join(workspace, "output"), path.join(workspace, "tmp")];

  return mathPilotSandboxConfig({
    workspace,allowedDomains,
    allowRead:[path.join(workspace,"AGENTS.md"),path.join(workspace,"input"),path.join(workspace,"task"),definition.packageRoot],
    allowWrite:workspaceWrites,
    ...(credentials.length>0 ? { credentials:{ envVars:credentials.map(({ name,host }) => ({ name,mode:"mask" as const,injectHosts:[host] })) } } : {}),
  });
};

const run = async (): Promise<number> => {
  const capability = parseCapability(process.argv[2]);
  const workspace = await resolveWorkspace();
  let temporaryRoot: string | undefined;
  const executionRoot = capability === "search"
    ? (temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "mathpilot-search-")))
    : workspace;
  const home = capability === "search" ? executionRoot : path.join(workspace, "tmp");

  try {
    if (temporaryRoot) {
      await chmod(temporaryRoot, 0o700);
    }
    const config = capabilityConfig(capability, workspace, executionRoot);
    await SandboxManager.initialize(config);
    const definition = definitions[capability];
    const child = await spawnOfficialSandbox({
      command:`exec ${definition.executable}`,cwd:executionRoot,config,
      env:safeEnvironment(capability,home),stdio:"inherit",
    });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    process.once("SIGINT", forward);
    process.once("SIGTERM", forward);
    try {
      return await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (childCode, childSignal) => resolve(childCode ?? (childSignal ? 1 : 0)));
      });
    } finally {
      process.removeListener("SIGINT", forward);
      process.removeListener("SIGTERM", forward);
      SandboxManager.cleanupAfterCommand();
    }
  } finally {
    await SandboxManager.reset().catch(() => undefined);
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  }
};

run()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    process.stderr.write(`MathPilot capability sandbox failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
