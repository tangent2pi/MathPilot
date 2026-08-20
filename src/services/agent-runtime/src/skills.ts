/**
 * 任务 Prompt 策略装载。
 *
 * policies/agent.md 是统一运行纪律，policies/tasks/*.md 是一次运行的任务目标；
 * 它们不是可发现的 Skill。正式 Skill 只来自 skills/<name>/SKILL.md，并由 Pi 的
 * ResourceLoader 按需展示和读取。tasks.manifest.json 单一注册 prompt_version、
 * 主/辅助模型角色与策略文件，占位符 {{key}} 在工作区创建前注入。
 *
 * 角色隔离（设计 §4.1）：AGENTS.md 只含通用纪律、工作区地图与当前任务 Prompt，
 * 不包含其他任务的目标（KTQ 看不到 Dream 的任务内容）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type TaskType =
  | "teach_grade"      // Teaching Agent：模型主判答
  | "teach_interact"   // Teaching Agent：多轮帮助/步骤检查/自由问答
  | "teach_summary"    // Teaching Agent：教学总结（双产物之一）
  | "continuity_summary" // 辅助模型：题间递归连续学习摘要
  | "ktq_extract"      // KTQ Extraction Agent：内容抽取
  | "er_research"      // ER Research Agent：错因/规则调研
  | "dream_profile"     // Dream/Profile Update Agent：长期画像最终更新
  | "diagnose"         // Teaching Agent：错因归因（DIAGNOSE，§8.3）
  | "session_decision"  // Teaching Agent：会话结束目标判定（§10.1）
  | "plan";             // 学习计划转写（§10.3）

export interface TaskContext {
  question?: string;
  rubric?: string;
  userData?: string;
  fragments?: string;
  frozenProjection?: string;
  profileWindow?: string;
  priorSnapshot?: string;
  diagnosisContext?: string;
  schemaNote?: string;
  verdict?: string;
  studentProfile?: string;
  planDraft?: string;
  sessionSummary?: string;
  studentProjection?: string;
  previousContinuity?: string;
  currentSession?: string;
  scientificEvaluation?: string;
  teachingSummary?: string;
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

/** 解析任务策略前导（--- name / description ---）；无前导时退化为任务键 */
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
  name: string;
  description: string;
  content: string;
  filePath: string;
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
    name: name || taskType,
    description,
    content: body,
    filePath: `${POLICIES_DIR}${entry.file}`,
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
 * 编译 AGENTS.md：通用纪律 + 工作区地图 + 当前任务 Prompt。
 * 可发现能力由 ResourceLoader 从正式 Skill 目录加载，不在这里硬编码或重复注入。
 */
export function compileSystemPrompt(taskType: TaskType, ctx: TaskContext, workspaceMap: string): string {
  const task = loadTask(taskType);
  let content = task.content;
  for (const [key, value] of Object.entries(ctx)) {
    content = content.replaceAll(`{{${key}}}`, value ?? "(未提供)");
  }
  content = content.replace(/\{\{[A-Za-z0-9_]+\}\}/g, "(未提供)");
  const workspaceSection = `## 工作区（设计 §5.1）\n${workspaceMap.trim()}\n`;
  const taskSection = `## 当前任务\n\n任务：${task.name}\n${task.description ? `目标：${task.description}\n\n` : ""}${content.trim()}\n`;
  return `${basePolicy}\n\n${workspaceSection}\n${taskSection}`;
}
