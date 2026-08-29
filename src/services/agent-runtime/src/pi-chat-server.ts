import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createPiNodeClient } from "@assistant-ui/react-pi/node";
import type { PiClient } from "@assistant-ui/react-pi";

const EXTENSIONS_SOURCE = process.env.PI_CHAT_EXTENSIONS_SOURCE
  ?? fileURLToPath(new URL("../extensions", import.meta.url));
const EXTENSIONS_NODE_MODULES = fileURLToPath(new URL("../node_modules", import.meta.url));
// 恢复 Claude 已验证的六个 Pi skill：仅通过 agentDir 插件式注入，
// 不修改 Pi；不包含“下一题”fork、后台判答或 Dream 编排。
const SKILLS_SOURCE = process.env.PI_CHAT_SKILLS_SOURCE
  ?? fileURLToPath(new URL("../skills", import.meta.url));

// Pi 对话 runtime 沿用 Claude 原型中已验证的 DeepSeek 配置；它与 agent-runtime
// 既有批处理任务的主/辅模型配置相互独立，不能读取 MODEL_ID_MAIN 回退到 Qwen。
const PROVIDER = "mathpilot-deepseek";
const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL_ID = "deepseek-v4-flash-vision-exp";

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
        const next = current.replaceAll("/opt/mathpilot-skills", skillsRoot).replaceAll("/workspace/", "./");
        if (next !== current) await writeFile(file, next, "utf8");
      }
    }
  };
  await walk(root);
}

export interface PiChatRuntime {
  client: PiClient;
  runtimeRoot: string;
  sessionsRoot: string;
  agentSessionsRoot: string;
  skillsRoot: string;
}

/**
 * Claude 原型的正式开发宿主：官方 PiThreadSupervisor + agentDir 插件发现。
 * 不修改 Pi；沙盒、respond 与后续能力均通过 extensions/skills 注入。
 */
export async function createPiChatRuntime(): Promise<PiChatRuntime> {
  // 默认放在 agent-runtime 包内，使复制后的插件可向上解析该包锁定的依赖；
  // 启动过程不执行 npm install，也不需要修改 Pi 的插件加载器。
  const runtimeRoot = process.env.PI_CHAT_RUNTIME_ROOT
    ?? process.env.MATHPILOT_RUNTIME
    ?? path.join(os.homedir(), ".mathpilot", "runtime");
  const agentDir = path.join(runtimeRoot, "agent");
  const sessionsRoot = path.join(runtimeRoot, "sessions");
  const extensionsRoot = path.join(agentDir, "extensions");
  const agentSessionsRoot = path.join(agentDir, "sessions");
  const skillsRoot = path.join(agentDir, "skills");

  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_SESSION_DIR = agentSessionsRoot;
  // extensions/skills 是声明式注入缓存，不是会话事实；启动时重建以免旧插件残留。
  await Promise.all([
    rm(extensionsRoot, { recursive: true, force: true }),
    rm(skillsRoot, { recursive: true, force: true }),
  ]);
  await Promise.all([
    mkdir(sessionsRoot, { recursive: true }),
    mkdir(agentSessionsRoot, { recursive: true }),
    mkdir(skillsRoot, { recursive: true }),
    syncDirectory(EXTENSIONS_SOURCE, extensionsRoot),
  ]);
  // 插件仍由 Pi 官方 ResourceLoader 从 agentDir 发现；这里只把宿主锁定的依赖
  // 暴露给运行时副本，避免每次启动 npm install，也不让新服务依赖 web-next。
  await symlink(EXTENSIONS_NODE_MODULES, path.join(extensionsRoot, "node_modules"), "dir");
  if (SKILLS_SOURCE) {
    await syncDirectory(SKILLS_SOURCE, skillsRoot);
    await rewriteSkillPaths(skillsRoot, skillsRoot);
  }

  const apiKey = process.env.MODEL_API_KEY ?? "";
  const baseUrl = process.env.MODEL_API_BASE ?? DEFAULT_BASE_URL;
  const modelId = process.env.MODEL_ID ?? DEFAULT_MODEL_ID;
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      [PROVIDER]: {
        baseUrl,
        api: "openai-completions",
        apiKey: "$MODEL_API_KEY",
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: modelId, reasoning: true, input: ["text", "image"] }],
      },
    },
  }, null, 2));
  const authPath = path.join(agentDir, "auth.json");
  if (apiKey) await writeFile(authPath, JSON.stringify({ [PROVIDER]: { type: "api_key", key: apiKey } }, null, 2));
  else await rm(authPath, { force: true });

  const models = await ModelRuntime.create({
    authPath,
    modelsPath: path.join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
  await models.refresh({ allowNetwork: false });
  const model = models.getModel(PROVIDER, modelId);
  return {
    client: createPiNodeClient({ workspacePath: sessionsRoot, agentDir, model }),
    runtimeRoot,
    sessionsRoot,
    agentSessionsRoot,
    skillsRoot,
  };
}
