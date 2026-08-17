/**
 * 工作区文件系统（设计 §5.1 宿主侧骨架，架构修订 v4 §2"管理 agent 的文件系统"）。
 *
 * 每个任务独立工作区：<WORKSPACE_ROOT>/<tenant>/<taskId>/
 *   AGENTS.md        策略源编译的工作区标准文件（通用纪律 + 工作区地图 + 任务技能）
 *   task/task.json   任务上下文（只读挂载语义）
 *   output/          输出区（可写；后续 Artifact 目录落在此处）
 *   tmp/             临时区（可写，结束即清理）
 *
 * 租户按路径隔离（tenantId 参与目录层级）；任务结束即整目录清理。
 * 沙箱落地后本目录成为沙箱只读挂载源，语义不变（§5.1）。
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? path.resolve(".runtime/workspaces");

export interface Workspace {
  /** 任务工作区绝对路径 */
  root: string;
  taskId: string;
}

const WORKSPACE_MAP = `- /workspace/AGENTS.md：本文件（任务纪律、工作区地图、输出契约）
- /workspace/task/：当前任务上下文（task.json），只读
- /workspace/output/：输出区（可写；正式输出一律经 respond 工具，本区为后续 Artifact 目录）
- /workspace/tmp/：临时区（可写，结束即清理）`;

export { WORKSPACE_MAP };

export async function createWorkspace(
  tenantId: string,
  taskId: string,
  taskContext: Record<string, unknown>,
  agentsMd: string,
): Promise<Workspace> {
  const root = path.join(WORKSPACE_ROOT, tenantId, taskId);
  await mkdir(path.join(root, "task"), { recursive: true });
  await mkdir(path.join(root, "output"), { recursive: true });
  await mkdir(path.join(root, "tmp"), { recursive: true });
  await writeFile(path.join(root, "AGENTS.md"), agentsMd, "utf8");
  await writeFile(path.join(root, "task", "task.json"), JSON.stringify(taskContext, null, 2), "utf8");
  return { root, taskId };
}

/** 任务结束即清理（模型历史与工作区都不跨任务共享，设计 §4.1） */
export async function destroyWorkspace(ws: Workspace): Promise<void> {
  await rm(ws.root, { recursive: true, force: true });
}
