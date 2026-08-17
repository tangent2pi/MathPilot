/**
 * 任务策略装载器（设计 §5.1：仓库 policies/ 是版本化策略源）。
 *
 * agent-runtime 启动时装载 manifest 与全部任务策略文件；缺失/损坏即启动失败，
 * 不静默回退（Review-001）。每 Session 创建时把 policies/agent.md 与任务策略
 * 编译为工作区标准 AGENTS.md（即 systemPrompt），按 manifest 选择主/辅助模型。
 * 模型行为一律通过策略、Skills 与工作区文件控制，不在 Agent 循环内限制动作。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type TaskType =
  | "teach_grade"      // Teaching Agent：模型主判答
  | "teach_summary"    // Teaching Agent：教学总结（双产物之一）
  | "ktq_extract"      // KTQ Extraction Agent：内容抽取
  | "er_research"      // ER Research Agent：错因/规则调研
  | "dream_profile";   // Dream/Profile Update Agent：长期画像最终更新

export interface TaskContext {
  /** 题目与评分点（判答/总结） */
  question?: string;
  rubric?: string;
  /** 学生作答等不可信数据 */
  userData?: string;
  /** 来源片段（KTQ，含 fragment_id） */
  fragments?: string;
  /** 冻结 KTQ 投影（ER） */
  frozenProjection?: string;
  /** Dream：画像窗口双产物 */
  profileWindow?: string;
  /** 已发布快照摘要 */
  priorSnapshot?: string;
  /** 输出契约说明（JSON Schema 摘要） */
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

const taskTypes = Object.keys(manifest.tasks) as TaskType[];
for (const t of taskTypes) {
  if (!t) throw new Error(`policy manifest: empty task key`);
  const p = manifest.tasks[t];
  if (!p || !p.file || !p.prompt_version || (p.role !== "main" && p.role !== "aux")) {
    throw new Error(`policy manifest: invalid entry for ${t}`);
  }
}

const basePolicy = readFileSync(`${POLICIES_DIR}agent.md`, "utf8");

const taskCache = new Map<TaskType, { content: string; version: string; role: "main" | "aux" }>();

function loadTaskPolicy(taskType: TaskType): { content: string; version: string; role: "main" | "aux" } {
  const cached = taskCache.get(taskType);
  if (cached) return cached;
  const entry = manifest.tasks[taskType];
  if (!entry) throw new Error(`policy manifest: unknown task ${taskType}`);
  const content = readFileSync(`${POLICIES_DIR}${entry.file}`, "utf8");
  const loaded = { content, version: entry.prompt_version, role: entry.role };
  taskCache.set(taskType, loaded);
  return loaded;
}

/** 编译任务提示：通用纪律 + 任务策略，注入任务上下文（{{key}} 占位符） */
export function compileTaskPrompt(taskType: TaskType, ctx: TaskContext): string {
  const { content } = loadTaskPolicy(taskType);
  let compiled = `${basePolicy}\n\n${content}`;
  for (const [key, value] of Object.entries(ctx)) {
    compiled = compiled.replaceAll(`{{${key}}}`, value ?? "(未提供)");
  }
  return compiled;
}

/** 任务 → 模型角色（主/辅助；manifest 单一来源） */
export function taskRole(taskType: TaskType): "main" | "aux" {
  return loadTaskPolicy(taskType).role;
}

/** 任务 → prompt_version（写入血缘/判答/画像决策的审计字段） */
export function taskPromptVersion(taskType: TaskType): string {
  return loadTaskPolicy(taskType).version;
}
