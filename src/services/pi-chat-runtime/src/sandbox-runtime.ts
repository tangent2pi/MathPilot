import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

const SANDBOX_RUNTIME_VENDOR = path.join(
  path.dirname(createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime/package.json")),
  "vendor",
);

// Exact host runtime files needed by dynamically linked tools and TLS/DNS.
// In particular, do not re-expose the whole /etc tree after deny-root.
const SYSTEM_RUNTIME_READ_PATHS = [
  "/usr","/bin","/lib","/lib64",
  "/etc/ld.so.cache","/etc/passwd","/etc/group","/etc/nsswitch.conf",
  "/etc/hosts","/etc/resolv.conf","/etc/localtime","/etc/ssl/certs","/etc/ca-certificates",
];

export interface MathPilotSandboxPolicy {
  readonly workspace: string;
  readonly allowedDomains: readonly string[];
  readonly allowRead: readonly string[];
  readonly allowWrite: readonly string[];
  readonly denyRead?: readonly string[];
  readonly denyWrite?: readonly string[];
  readonly credentials?: NonNullable<SandboxRuntimeConfig["credentials"]>;
}

export const mathPilotSandboxConfig = (policy: MathPilotSandboxPolicy): SandboxRuntimeConfig => ({
  network:{
    allowedDomains:[...policy.allowedDomains],deniedDomains:[],strictAllowlist:true,
    allowAllUnixSockets:true,
    ...(policy.allowedDomains.length>0 ? { tlsTerminate:{} } : {}),
  },
  filesystem:{
    denyRead:["/","/sys",path.join(policy.workspace,".agent"),...(policy.denyRead ?? [])],
    allowRead:[...policy.allowRead,SANDBOX_RUNTIME_VENDOR,...SYSTEM_RUNTIME_READ_PATHS],
    allowWrite:[...policy.allowWrite],
    denyWrite:[path.join(policy.workspace,"input"),path.join(policy.workspace,".agent"),...(policy.denyWrite ?? [])],
  },
  ...(policy.credentials ? { credentials:policy.credentials } : {}),
  enableWeakerNestedSandbox:false,
});

export const safeSandboxEnvironment = (input: {
  readonly home: string;
  readonly path: string;
  readonly extra?: Readonly<Record<string,string>>;
}): NodeJS.ProcessEnv => ({
  HOME:input.home,TMPDIR:input.home,PATH:input.path,LANG:"C.UTF-8",LC_ALL:"C.UTF-8",
  ...(input.extra ?? {}),
});

export const spawnOfficialSandbox = async (input: {
  readonly command: string;
  readonly cwd: string;
  readonly config: SandboxRuntimeConfig;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal | undefined;
  readonly detached?: boolean | undefined;
  readonly stdio: "inherit" | ["ignore" | "pipe", "ignore" | "pipe", "pipe"];
}): Promise<ChildProcess> => {
  input.signal?.throwIfAborted();
  const descriptor = await SandboxManager.wrapWithSandboxArgv(
    input.command,"/bin/bash",input.config,input.signal,input.cwd,
  );
  if (input.signal?.aborted) {
    SandboxManager.cleanupAfterCommand();
    input.signal.throwIfAborted();
  }
  try {
    return spawn(descriptor.argv[0]!,descriptor.argv.slice(1),{
      cwd:input.cwd,env:input.env,stdio:input.stdio,detached:input.detached,
    });
  } catch (error) {
    SandboxManager.cleanupAfterCommand();
    throw error;
  }
};
