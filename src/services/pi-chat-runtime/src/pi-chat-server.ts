import { chmod, cp, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createPiNodeClient, getPiThreadSupervisor } from "@assistant-ui/react-pi/node";
import type { PiClient } from "@assistant-ui/react-pi";
import { assemblePiChatWorkspace } from "./pi-chat-workspace.ts";

const EXTENSIONS_SOURCE = process.env.PI_CHAT_EXTENSIONS_SOURCE
  ?? fileURLToPath(new URL("../extensions", import.meta.url));
const EXTENSIONS_NODE_MODULES = fileURLToPath(new URL("../node_modules", import.meta.url));
const CAPABILITIES_SOURCE = process.env.PI_CHAT_CAPABILITIES_SOURCE
  ?? fileURLToPath(new URL("./capabilities", import.meta.url));
// 注入 Pi 对话所需的 Skills：仅通过 agentDir 插件式注入，
// 不修改 Pi；不包含“下一题”fork、后台判答或 Dream 编排。
const SKILLS_SOURCE = process.env.PI_CHAT_SKILLS_SOURCE
  ?? fileURLToPath(new URL("../skills", import.meta.url));

// Pi 对话 runtime 使用显式注入的 DeepSeek 主模型；后台任务可独立选择
// 同一 provider 下的副模型。协议、端点、密钥和两个模型 ID 都由宿主配置。
const PROVIDER = "mathpilot-deepseek";

const requiredModelSetting = (name: "MODEL_API_BASE" | "MODEL_API_KEY" | "MODEL_ID_MAIN" | "MODEL_ID_AUX"): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required by pi-chat-runtime`);
  return value;
};

async function syncDirectory(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  const sourceEntries = await readdir(source, { withFileTypes: true });
  for (const entry of sourceEntries) {
    await cp(path.join(source, entry.name), path.join(target, entry.name), { recursive: true, force: true });
  }
}

async function rewriteSkillPaths(root: string, skillsRoot: string): Promise<void> {
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (/\.(md|py|sh|json|txt)$/.test(entry.name)) {
        const current = await readFile(file, "utf8").catch(() => "");
        const next = current.replaceAll("{{SKILLS_ROOT}}", skillsRoot).replaceAll("/opt/mathpilot-skills", skillsRoot).replaceAll("/workspace/", "./");
        if (next !== current) await writeFile(file, next, "utf8");
      }
    }
  };
  await walk(root);
}

async function makeModelReadable(root: string): Promise<void> {
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Skill projection may not contain symlinks: ${file}`);
      if (entry.isDirectory()) {
        await walk(file);
        await chmod(file, 0o555);
      } else if (entry.isFile()) {
        const info = await lstat(file);
        await chmod(file, info.mode & 0o111 ? 0o555 : 0o444);
      }
    }
  };
  await walk(root);
  await chmod(root, 0o555);
}

async function refreshExistingWorkspaces(sessionsRoot: string, skillsRoot: string): Promise<void> {
  for (const entry of await readdir(sessionsRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    await assemblePiChatWorkspace(path.join(sessionsRoot, entry.name), skillsRoot);
  }
}

export interface PiChatRuntime {
  client: PiClient;
  runtimeRoot: string;
  sessionsRoot: string;
  agentSessionsRoot: string;
  skillsRoot: string;
  foregroundModel: { provider: string; modelId: string };
  /** The pinned react-pi supervisor owns live SessionManagers. Canonical sync
   * must append through that same manager so its in-memory tree and JSONL stay
   * coherent; cold sessions are opened directly. */
  canonicalSession(threadId: string, sessionFile: string): CanonicalSessionAppender;
}

export interface CanonicalSessionAppender {
  manager: SessionManager;
  appendCustomMessage(message: { customType: string; content: string; display: boolean; details?: unknown }): Promise<void>;
}

export const canonicalSessionFromSupervisor = (
  supervisor: unknown,
  threadId: string,
  sessionFile: string,
): CanonicalSessionAppender => {
  const records = (supervisor as {
    records?: Map<string, { session?: {
      sessionManager?: SessionManager;
      isStreaming?: boolean;
      sendCustomMessage?: (
        message: Parameters<CanonicalSessionAppender["appendCustomMessage"]>[0],
        options?: { triggerTurn?: boolean },
      ) => Promise<void>;
    } }>;
  } | undefined)?.records;
  if (!(records instanceof Map)) throw new Error("react-pi supervisor record contract is unavailable");
  const live = records.get(threadId)?.session;
  if (live?.sessionManager) {
    if (typeof live.sendCustomMessage !== "function") throw new Error("react-pi live AgentSession contract is unavailable");
    return {
      manager: live.sessionManager,
      async appendCustomMessage(message) {
        if (live.isStreaming) throw new Error("Pi session is currently streaming");
        await live.sendCustomMessage!(message, { triggerTurn: false });
      },
    };
  }
  const manager = SessionManager.open(sessionFile);
  return {
    manager,
    async appendCustomMessage(message) {
      manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    },
  };
};

/**
 * Claude 原型的正式开发宿主：官方 PiThreadSupervisor + agentDir 插件发现。
 * 不修改 Pi；沙盒、respond 与后续能力均通过 extensions/skills 注入。
 */
export async function createPiChatRuntime(): Promise<PiChatRuntime> {
  // 默认放在独立的 Pi chat runtime 目录，使复制后的插件解析本服务锁定的依赖；
  // 启动过程不执行 npm install，也不需要修改 Pi 的插件加载器。
  const runtimeRoot = process.env.PI_CHAT_RUNTIME_ROOT
    ?? process.env.MATHPILOT_RUNTIME
    ?? path.join(os.homedir(), ".mathpilot", "runtime");
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await chmod(runtimeRoot, typeof process.getuid === "function" && process.getuid() === 0 ? 0o711 : 0o700);
  // Sandbox Runtime derives compatibility write paths from HOME while it
  // builds the sandbox descriptor. Keep those paths in the runtime volume
  // instead of exposing the container user's normal home.
  const sandboxHome = path.join(runtimeRoot, "sandbox-home");
  // This directory contains only disposable package/runtime caches. Recreate
  // it to remove ownership left by the retired setpriv launchers.
  await rm(sandboxHome, { recursive: true, force: true });
  await mkdir(sandboxHome, { recursive: true, mode: 0o700 });
  await chmod(sandboxHome, 0o700);
  process.env.HOME = sandboxHome;
  const agentDir = path.join(runtimeRoot, "agent");
  const sessionsRoot = path.join(runtimeRoot, "sessions");
  const extensionsRoot = path.join(agentDir, "extensions");
  const agentSessionsRoot = path.join(agentDir, "sessions");
  const agentSkillsRoot = path.join(agentDir, "skills");
  const sandboxSkillsRoot = path.join(runtimeRoot, "sandbox-skills");

  // The agent directory contains auth.json and must not be readable by other
  // users of the host/container.  Pi's AuthStorage also enforces 0600, but
  // this bootstrap writes the file directly before the SDK is constructed.
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await chmod(agentDir, 0o700);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_SESSION_DIR = agentSessionsRoot;
  // extensions/skills 是声明式注入缓存，不是会话事实；启动时重建以免旧插件残留。
  await Promise.all([
    rm(extensionsRoot, { recursive: true, force: true }),
    rm(agentSkillsRoot, { recursive: true, force: true }),
    rm(sandboxSkillsRoot, { recursive: true, force: true }),
  ]);
  await Promise.all([
    mkdir(sessionsRoot, { recursive: true, mode: 0o700 }),
    mkdir(agentSessionsRoot, { recursive: true, mode: 0o700 }),
    mkdir(agentSkillsRoot, { recursive: true, mode: 0o700 }),
    mkdir(sandboxSkillsRoot, { recursive: true, mode: 0o755 }),
    syncDirectory(EXTENSIONS_SOURCE, extensionsRoot),
  ]);
  // Capabilities are source-owned by the new Pi runtime, but are staged below
  // extensions so Pi's official agentDir discovery owns their lifecycle.
  await syncDirectory(CAPABILITIES_SOURCE, path.join(extensionsRoot, "capabilities"));
  await Promise.all([
    chmod(sessionsRoot, typeof process.getuid === "function" && process.getuid() === 0 ? 0o711 : 0o700),
    chmod(agentSessionsRoot, 0o700),
    chmod(agentSkillsRoot, 0o700),
    chmod(extensionsRoot, 0o700),
  ]);
  // 插件仍由 Pi 官方 ResourceLoader 从 agentDir 发现；这里只把宿主锁定的依赖
  // 暴露给运行时副本，避免每次启动 npm install，也不让新服务依赖 web-next。
  await symlink(EXTENSIONS_NODE_MODULES, path.join(extensionsRoot, "node_modules"), "dir");
  if (SKILLS_SOURCE) {
    await Promise.all([
      syncDirectory(SKILLS_SOURCE, agentSkillsRoot),
      syncDirectory(SKILLS_SOURCE, sandboxSkillsRoot),
    ]);
    await Promise.all([
      rewriteSkillPaths(agentSkillsRoot, sandboxSkillsRoot),
      rewriteSkillPaths(sandboxSkillsRoot, sandboxSkillsRoot),
    ]);
    await makeModelReadable(sandboxSkillsRoot);
  }
  process.env.PI_CHAT_SANDBOX_SKILLS_ROOT = sandboxSkillsRoot;
  await refreshExistingWorkspaces(sessionsRoot, sandboxSkillsRoot);

  const apiKey = requiredModelSetting("MODEL_API_KEY");
  const baseUrl = requiredModelSetting("MODEL_API_BASE");
  const mainModelId = requiredModelSetting("MODEL_ID_MAIN");
  const auxiliaryModelId = requiredModelSetting("MODEL_ID_AUX");
  const modelIds = [...new Set([mainModelId, auxiliaryModelId])];
  const modelsPath = path.join(agentDir, "models.json");
  await writeFile(modelsPath, JSON.stringify({
    providers: {
      [PROVIDER]: {
        baseUrl,
        api: "openai-responses",
        apiKey: "$MODEL_API_KEY",
        compat: {
          supportsDeveloperRole: false,
          supportsLongCacheRetention: false,
          supportsStrictMode: false,
          supportsOpenAIGrammarTools: false,
          sessionAffinityFormat: "openai-nosession",
        },
        models: modelIds.map((id) => ({ id, reasoning: true, input: ["text", "image"] })),
      },
    },
  }, null, 2), { encoding: "utf8", mode: 0o600 });
  await chmod(modelsPath, 0o600);
  const authPath = path.join(agentDir, "auth.json");
  await writeFile(authPath, JSON.stringify({ [PROVIDER]: { type: "api_key", key: apiKey } }, null, 2), { encoding: "utf8", mode: 0o600 });
  await chmod(authPath, 0o600);

  const models = await ModelRuntime.create({
    authPath,
    modelsPath,
    allowModelNetwork: false,
  });
  await models.refresh({ allowNetwork: false });
  const model = models.getModel(PROVIDER, mainModelId);
  if (!model) throw new Error(`configured main model ${PROVIDER}/${mainModelId} was not loaded`);
  if (!models.getModel(PROVIDER, auxiliaryModelId)) {
    throw new Error(`configured auxiliary model ${PROVIDER}/${auxiliaryModelId} was not loaded`);
  }
  const supervisor = getPiThreadSupervisor({ workspacePath: sessionsRoot, agentDir, model });
  const client = createPiNodeClient({ workspacePath: sessionsRoot, agentDir, model });
  return {
    client,
    runtimeRoot,
    sessionsRoot,
    agentSessionsRoot,
    skillsRoot: sandboxSkillsRoot,
    foregroundModel: { provider: PROVIDER, modelId: mainModelId },
    canonicalSession(threadId, sessionFile) {
      // react-pi 0.0.20 intentionally keeps records private. This narrow,
      // version-pinned adapter is the only host boundary that inspects it.
      return canonicalSessionFromSupervisor(supervisor, threadId, sessionFile);
    },
  };
}
