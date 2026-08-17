/**
 * 任务策略装载（架构修订 v4：模型身份与动作由 prompts/skills 管理）。
 *
 * policies/ 即 pi Skills 目录：agent.md 为通用纪律，tasks/*.md 为任务技能
 * （SKILL.md 规范 frontmatter：name/description），tasks.manifest.json 注册
 * prompt_version 与主/辅模型角色。提示编译使用 pi 原生格式化机制
 * （formatSkillInvocation / formatSkillsForSystemPrompt），占位符 {{key}}
 * 由本装载器在加载时注入任务上下文。
 *
 * 角色隔离（设计 §4.1）：systemPrompt 只含通用纪律 + 当前任务技能，
 * 不列出其他任务的技能（KTQ 看不到 Dream 的提示）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { formatSkillInvocation, formatSkillsForSystemPrompt, type Skill } from "@earendil-works/pi-agent-core";

export type TaskType =
  | "teach_grade"      // Teaching Agent：模型主判答
  | "teach_summary"    // Teaching Agent：教学总结（双产物之一）
  | "ktq_extract"      // KTQ Extraction Agent：内容抽取
  | "er_research"      // ER Research Agent：错因/规则调研
  | "dream_profile";   // Dream/Profile Update Agent：长期画像最终更新

export interface TaskContext {
  question?: string;
  rubric?: string;
  userData?: string;
  fragments?: string;
  frozenProjection?: string;
  profileWindow?: string;
  priorSnapshot?: string;
  schemaNote?: string;
}

interface TaskPolicy {
  file: string;
  prompt_version: string;
  role: "main" | "aux";
}

/** 策略根：policies/（Docker 镜像复制全仓库；本地为仓库根） */
const POLICIES_DIR = fileURLToPath(new URL("../../../../policies/", import.meta.url));

const manifest = JSON.parse(
  readFileSync(`${POLICIES_DIR}tasks.manifest.json`, "utf8"),
) as { schema: string; tasks: Record<TaskType, TaskPolicy> };

for (const [key, p] of Object.entries(manifest.tasks)) {
  if (!key || !p || !p.file || !p.prompt_version || (p.role !== "main" && p.role !== "aux")) {
    throw new Error(`policy manifest: invalid entry for ${key}`);
  }
}

const basePolicy = readFileSync(`${POLICIES_DIR}agent.md`, "utf8");

/** 解析 SKILL.md 前导（--- name / description ---）；无前导时退化为文件名 */
function parseFrontmatter(text: string): { name: string; description: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) return { name: "", description: "", body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]!] = kv[2]!;
  }
  return { name: meta.name ?? "", description: meta.description ?? "", body: m[2]! };
}

interface LoadedTask {
  skill: Skill;
  version: string;
  role: "main" | "aux";
}

const taskCache = new Map<TaskType, LoadedTask>();

function loadTask(taskType: TaskType): LoadedTask {
  const cached = taskCache.get(taskType);
  if (cached) return cached;
  const entry = manifest.tasks[taskType];
  if (!entry) throw new Error(`policy manifest: unknown task ${taskType}`);
  const raw = readFileSync(`${POLICIES_DIR}${entry.file}`, "utf8");
  const { name, description, body } = parseFrontmatter(raw);
  const loaded: LoadedTask = {
    skill: {
      name: name || taskType,
      description,
      content: body,
      filePath: `${POLICIES_DIR}${entry.file}`,
    },
    version: entry.prompt_version,
    role: entry.role,
  };
  taskCache.set(taskType, loaded);
  return loaded;
}

/** 任务 → 模型角色（主/辅助；manifest 单一来源） */
export function taskRole(taskType: TaskType): "main" | "aux" {
  return loadTask(taskType).role;
}

/** 任务 → prompt_version（写入血缘/判答/画像决策的审计字段） */
export function taskPromptVersion(taskType: TaskType): string {
  return loadTask(taskType).version;
}

/**
 * 编译 systemPrompt（AGENTS.md）：通用纪律 + 工作区地图 + 当前任务技能。
 * 上下文经 {{key}} 占位符注入技能正文；技能调用与技能索引均使用 pi 原生格式。
 * 角色隔离：只注入当前任务技能，不列出其他任务技能。
 */
export function compileSystemPrompt(taskType: TaskType, ctx: TaskContext, workspaceMap: string): string {
  const { skill } = loadTask(taskType);
  let content = skill.content;
  for (const [key, value] of Object.entries(ctx)) {
    content = content.replaceAll(`{{${key}}}`, value ?? "(未提供)");
  }
  const active: Skill = { ...skill, content };
  const workspaceSection = `## 工作区（设计 §5.1）\n${workspaceMap.trim()}\n`;
  // 单技能注入：当前任务的全部内容（文件层落地后改为仅索引 + 按需读取，§5.3）
  return `${basePolicy}\n\n${workspaceSection}\n${formatSkillInvocation(active)}`;
}

/** 技能索引（阶段 B 文件层：systemPrompt 仅列名称与触发说明，模型按需读取） */
export function skillIndex(taskType: TaskType): string {
  return formatSkillsForSystemPrompt([loadTask(taskType).skill]);
}
