/**
 * 工作区文件系统（设计 §5.1 宿主侧骨架，架构修订 v4 §2"管理 agent 的文件系统"）。
 *
 * 每个 Agent Session 独立工作区：<WORKSPACE_ROOT>/<tenant>/<sessionRef>/
 *   AGENTS.md        策略源编译的工作区标准文件（通用纪律 + 工作区地图 + 当前任务 Prompt）
 *   task/task.json   任务上下文（只读挂载语义）
 *   output/          输出区（可写；后续 Artifact 目录落在此处）
 *   tmp/             临时区（可写，结束即清理）
 *
 * 租户按路径隔离（tenantId 参与目录层级）。工作区在会话关闭前保留，使多轮
 * Teaching Agent 能持续读取同一份题卡/OCR/对话辅助文件；临时区由显式清理处理。
 */
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, chmod, chown, copyFile, cp, lstat, mkdir, readFile, realpath, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? path.resolve(".runtime/workspaces");
const CONTENT_ARTIFACT_ROOT = process.env.CONTENT_ARTIFACT_ROOT ?? path.resolve(".runtime/content-artifacts");
const PI_SESSION_ROOT = process.env.PI_SESSION_ROOT ?? path.resolve(".runtime/pi-sessions");

export interface Workspace {
  /** 任务工作区绝对路径 */
  root: string;
  taskId: string;
}

export interface WorkspaceInput {
  /** content 服务持久化根下的相对对象键；禁止绝对路径与 .. */
  artifactRef: string;
  /** Agent 工作区 input/ 下的相对路径 */
  workspacePath: string;
}

export interface WorkspaceInlineFile {
  /** input/ 下的相对路径 */
  workspacePath: string;
  content: string;
}

export interface WorkspaceSessionEvidence {
  /** 同租户的已结束 Session；只允许继承其 output。 */
  sessionRef: string;
  /** `output` 或其下的相对路径。 */
  sourcePath: string;
  /** 当前工作区 input/ 下的目标路径。 */
  workspacePath: string;
}

export type WorkspaceLifecycle = "continuing" | "terminal";

interface InventoryEntry {
  path: string;
  byte_size: number;
  sha256: string;
  retention: "audit" | "published" | "result" | "source_copy" | "temporary" | "candidate";
}

const WORKSPACE_MAP = `重要：Bash 沙箱中唯一有效的工作区根目录是 /workspace。即使 Session 元数据或 transcript 显示 /var/lib/agmath 等宿主路径，也绝不能在 Bash 中使用；一律写成 /workspace/... 或 ./...。

当前目录就是本 Session 的 /workspace：
- ./AGENTS.md：任务纪律、工作区地图、输出契约
- ./input/original/：上传的原始文档，只读语义
- ./input/ocr/：OCR 分页 Markdown、layout JSON、图片与 fragments.jsonl，只读语义
- ./input/question|student|session/：按任务固化的题目、学生事实与会话引用，只读语义
- PostgreSQL：按 database Skill 使用 psql/Python；PG* 已绑定本租户/学生的只读身份
- ./task/runs/：本 Session 各轮任务上下文
- /opt/agmath-skills/：全部标准能力 Skill；按任务目标自主读取 SKILL.md、模板与验证脚本
- ./output/：输出区（KTQ/ER 必须先写文件、运行 Skill 验证器，再由 respond 引用文件）
- ./tmp/：临时区`;

export { WORKSPACE_MAP };

export async function createWorkspace(
  tenantId: string,
  taskId: string,
  taskContext: Record<string, unknown>,
  agentsMd: string,
  inputs: readonly WorkspaceInput[] = [],
  inlineFiles: readonly WorkspaceInlineFile[] = [],
  sessionEvidence: readonly WorkspaceSessionEvidence[] = [],
): Promise<Workspace> {
  const safeTenant = safeSegment(tenantId, "tenantId");
  const safeTask = safeSegment(taskId, "sessionRef");
  const tenantRoot = path.join(WORKSPACE_ROOT, safeTenant);
  const root = path.join(WORKSPACE_ROOT, safeTenant, safeTask);
  await mkdir(path.join(root, "task", "runs"), { recursive: true });
  await mkdir(path.join(root, "input"), { recursive: true });
  await mkdir(path.join(root, "output"), { recursive: true });
  await mkdir(path.join(root, "tmp"), { recursive: true });
  // agent-runtime 容器内 Bash 先以 nobody 启动 Bubblewrap。父目录只允许遍历、不允许
  // 枚举；当前 Session 根只允许该 UID 读取，显式写区才可写。真正的路径/网络隔离由
  // runtime.ts 的 Bubblewrap mount + namespace 策略强制执行。
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    await chmod(WORKSPACE_ROOT, 0o711);
    await chmod(tenantRoot, 0o711);
    await chown(root, 65534, 65534);
    await chmod(root, 0o500);
    await chown(path.join(root, "output"), 65534, 65534);
    await chown(path.join(root, "tmp"), 65534, 65534);
    await chmod(path.join(root, "output"), 0o700);
    await chmod(path.join(root, "tmp"), 0o700);
  }
  await writeFile(path.join(root, "AGENTS.md"), agentsMd, "utf8");
  const runName = `${new Date().toISOString().replaceAll(":", "-")}-${crypto.randomUUID().slice(0, 8)}.json`;
  await writeFile(path.join(root, "task", "runs", runName), JSON.stringify(taskContext, null, 2), "utf8");
  await writeFile(path.join(root, "task", "latest.json"), JSON.stringify(taskContext, null, 2), "utf8");
  for (const input of inputs) await materializeInput(root, input);
  for (const file of inlineFiles) {
    const relative = safeRelative(file.workspacePath, "workspaceFile.workspacePath");
    const target = path.join(root, "input", relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }
  for (const evidence of sessionEvidence) await materializeSessionEvidence(safeTenant, safeTask, root, evidence);
  await mkdir(path.join(root, ".agent", "capsule", "runs"), { recursive: true });
  const inputProvenance = {
    schema: "agmath.workspace-inputs/v1",
    recorded_at: new Date().toISOString(),
    task_run: runName,
    artifacts: inputs.map((item) => ({ artifact_ref: item.artifactRef, workspace_path: `input/${item.workspacePath}` })),
    inline_files: inlineFiles.map((item) => ({ workspace_path: `input/${item.workspacePath}` })),
    session_evidence: sessionEvidence.map((item) => ({
      source_session_ref: item.sessionRef, source_path: item.sourcePath, workspace_path: `input/${item.workspacePath}`,
    })),
  };
  await appendFile(path.join(root, ".agent", "capsule", "input-provenance.jsonl"), `${JSON.stringify(inputProvenance)}\n`, "utf8");
  return { root, taskId };
}

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error(`${label} contains unsafe characters`);
  return value;
}

function safeRelative(value: string, label: string): string {
  if (!value || path.isAbsolute(value)) throw new Error(`${label} must be relative`);
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) throw new Error(`${label} escapes root`);
  return normalized;
}

async function materializeInput(workspaceRoot: string, input: WorkspaceInput): Promise<void> {
  const artifactRef = safeRelative(input.artifactRef, "artifactRef");
  const workspacePath = safeRelative(input.workspacePath, "workspacePath");
  const source = path.join(CONTENT_ARTIFACT_ROOT, artifactRef);
  const target = path.join(workspaceRoot, "input", workspacePath);
  const artifactRoot = await realpath(CONTENT_ARTIFACT_ROOT);
  const sourceReal = await realpath(source);
  if (sourceReal !== artifactRoot && !sourceReal.startsWith(`${artifactRoot}${path.sep}`)) {
    throw new Error("artifactRef escapes content artifact root");
  }
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(sourceReal, target);
}

async function materializeSessionEvidence(
  tenantId: string,
  currentSessionRef: string,
  workspaceRoot: string,
  evidence: WorkspaceSessionEvidence,
): Promise<void> {
  const sourceSession = safeSegment(evidence.sessionRef, "sessionEvidence.sessionRef");
  if (sourceSession === currentSessionRef) throw new Error("session evidence must come from a different Session");
  const sourceRelative = safeRelative(evidence.sourcePath, "sessionEvidence.sourcePath");
  if (sourceRelative !== "output" && !sourceRelative.startsWith(`output${path.sep}`)) {
    throw new Error("session evidence source must be output or below output/");
  }
  const destinationRelative = safeRelative(evidence.workspacePath, "sessionEvidence.workspacePath");
  const sourceRoot = path.join(WORKSPACE_ROOT, tenantId, sourceSession);
  const source = path.join(sourceRoot, sourceRelative);
  const sourceRootReal = await realpath(sourceRoot);
  const sourceReal = await realpath(source);
  if (sourceReal !== sourceRootReal && !sourceReal.startsWith(`${sourceRootReal}${path.sep}`)) {
    throw new Error("session evidence escapes source workspace");
  }
  let files = 0, bytes = 0;
  const inspect = async (target: string): Promise<void> => {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error("session evidence symlinks are forbidden");
    if (info.isFile()) {
      files += 1; bytes += info.size;
      if (files > 1000 || bytes > 256 * 1024 * 1024) throw new Error("session evidence exceeds copy budget");
      return;
    }
    if (!info.isDirectory()) throw new Error("unsupported session evidence entry");
    for (const child of await readdir(target)) await inspect(path.join(target, child));
  };
  await inspect(sourceReal);
  const destination = path.join(workspaceRoot, "input", destinationRelative);
  await mkdir(path.dirname(destination), { recursive: true });
  // 失败 Session 会完整保留现场。同一 ER Session 重试时重新物化由来源 Session
  // 决定的不可变证据，避免旧的半复制目录让重试在模型启动前失败。
  await rm(destination, { recursive: true, force: true });
  await cp(sourceReal, destination, { recursive: true, force: false, errorOnExist: true });
}

export async function readWorkspaceEvents(tenantId: string, sessionRef: string): Promise<string> {
  const file = path.join(WORKSPACE_ROOT, safeSegment(tenantId, "tenantId"), safeSegment(sessionRef, "sessionRef"), ".agent", "events.jsonl");
  return readFile(file, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return "";
    throw err;
  });
}

export async function appendWorkspaceEvent(tenantId: string, sessionRef: string, event: Record<string, unknown>): Promise<void> {
  const file = path.join(WORKSPACE_ROOT, safeSegment(tenantId, "tenantId"), safeSegment(sessionRef, "sessionRef"), ".agent", "events.jsonl");
  await appendFile(file, `${JSON.stringify(event)}\n`, "utf8");
}

/** 宿主侧只读定位；所有调用者仍须通过租户与 sessionRef 校验。 */
export function workspacePath(tenantId: string, sessionRef: string): string {
  return path.join(WORKSPACE_ROOT, safeSegment(tenantId, "tenantId"), safeSegment(sessionRef, "sessionRef"));
}

function retentionFor(relative: string): InventoryEntry["retention"] {
  if (relative.startsWith(".agent/published/")) return "published";
  if (relative.startsWith(".agent/") || relative === "AGENTS.md" || relative.startsWith("task/")) return "audit";
  if (relative.startsWith("input/")) return "source_copy";
  if (relative.startsWith("tmp/")) return "temporary";
  if (relative.startsWith("output/artifacts/")) return "candidate";
  return "result";
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

/**
 * 把当前租户/Session 的 Pi 原始 JSONL 归入同一 Workspace Capsule。调用者只传
 * Session 标识，不把宿主路径暴露给领域服务或前端。未标记终态时不得调用。
 */
export async function archivePiSessionTranscripts(
  tenantId: string,
  sessionRef: string,
  workspaceRoot = workspacePath(tenantId, sessionRef),
): Promise<string[]> {
  const safeTenant = safeSegment(tenantId, "tenantId");
  const safeSession = safeSegment(sessionRef, "sessionRef");
  const expectedWorkspace = path.resolve(workspacePath(safeTenant, safeSession));
  if (path.resolve(workspaceRoot) !== expectedWorkspace) throw new Error("transcript archive workspace does not match Session");
  const sessionDirectory = path.resolve(PI_SESSION_ROOT, safeTenant, safeSession);
  const allowedRoot = path.resolve(PI_SESSION_ROOT, safeTenant);
  if (!sessionDirectory.startsWith(`${allowedRoot}${path.sep}`)) throw new Error("Pi Session directory escapes tenant root");
  const sources = (await readdir(sessionDirectory, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return [];
    throw err;
  }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(sessionDirectory, entry.name))
    .sort();
  if (!sources.length) return [];

  const archiveDirectory = path.join(expectedWorkspace, ".agent", "capsule", "transcripts");
  await mkdir(archiveDirectory, { recursive: true });
  const references: string[] = [];
  for (const source of sources) {
    const sourceInfo = await stat(source);
    const sourceHash = await hashFile(source);
    const archiveName = `${path.basename(source)}.${sourceHash.slice(0, 12)}.gz`;
    const archive = path.join(archiveDirectory, archiveName);
    const temporary = `${archive}.${crypto.randomUUID()}.tmp`;
    try {
      await pipeline(createReadStream(source), createGzip({ level: 9 }), createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
      await rename(temporary, archive).catch(async (err: NodeJS.ErrnoException) => {
        if (err.code !== "EEXIST") throw err;
        await rm(temporary, { force: true });
      });
    } catch (err) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw err;
    }
    const record = {
      schema: "agmath.pi-transcript-archive/v1",
      source_name: path.basename(source),
      archive: `.agent/capsule/transcripts/${archiveName}`,
      raw_byte_size: sourceInfo.size,
      raw_sha256: sourceHash,
      archived_at: new Date().toISOString(),
    };
    await appendFile(path.join(archiveDirectory, "index.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
    await rm(source);
    references.push(`capsule://session/${safeSession}/transcripts/${archiveName}`);
  }
  await rmdir(sessionDirectory).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOTEMPTY" && err.code !== "ENOENT") throw err;
  });
  return references;
}

async function inventoryFiles(root: string): Promise<InventoryEntry[]> {
  const entries: InventoryEntry[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (relative.startsWith(".agent/capsule/runs/")) continue;
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const info = await stat(absolute);
        entries.push({ path: relative, byte_size: info.size, sha256: await hashFile(absolute), retention: retentionFor(relative) });
      }
    }
  };
  await visit(root);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

async function restoreWritableDirectories(root: string): Promise<void> {
  await mkdir(path.join(root, "input"), { recursive: true });
  await mkdir(path.join(root, "output"), { recursive: true });
  await mkdir(path.join(root, "tmp"), { recursive: true });
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    for (const relative of ["output", "tmp"]) {
      const directory = path.join(root, relative);
      await chown(directory, 65534, 65534);
      await chmod(directory, 0o700);
    }
  }
}

/**
 * 把一次 Pi 运行固化为可审计 Capsule。完成的 terminal Session 去掉可从正式
 * Artifact 重建的输入副本；continuing Session 保留 input 供后续回合使用。
 * 失败现场保留到显式/TTL 清理，旧的无 Capsule 工作区不会被触碰。
 */
export async function finalizeWorkspaceRun(
  tenantId: string,
  sessionRef: string,
  options: { status: "completed" | "failed"; lifecycle: WorkspaceLifecycle; taskType: string; detail?: string },
): Promise<{ manifest: string; bytesBefore: number; bytesRetained: number }> {
  const root = workspacePath(tenantId, sessionRef);
  const rootReal = await realpath(root);
  const workspaceRootReal = await realpath(WORKSPACE_ROOT);
  if (!rootReal.startsWith(`${workspaceRootReal}${path.sep}`)) throw new Error("workspace escapes root");
  const inventory = await inventoryFiles(rootReal);
  const bytesBefore = inventory.reduce((total, item) => total + item.byte_size, 0);
  const now = new Date();
  const runId = `${now.toISOString().replaceAll(":", "-")}-${crypto.randomUUID().slice(0, 8)}`;
  const manifestRelative = `.agent/capsule/runs/${runId}.json`;
  const manifest = {
    schema: "agmath.session-capsule/v1",
    tenant_id: tenantId,
    session_ref: sessionRef,
    task_type: options.taskType,
    status: options.status,
    lifecycle: options.lifecycle,
    finalized_at: now.toISOString(),
    ...(options.detail ? { detail: options.detail.slice(0, 1000) } : {}),
    ...(options.status === "failed" ? { failure_retain_until: new Date(now.getTime() + 72 * 60 * 60 * 1000).toISOString() } : {}),
    inventory,
  };
  await mkdir(path.join(rootReal, ".agent", "capsule", "runs"), { recursive: true });
  await writeFile(path.join(rootReal, manifestRelative), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  if (options.status === "completed") {
    await rm(path.join(rootReal, "tmp"), { recursive: true, force: true });
    await rm(path.join(rootReal, "output", "artifacts"), { recursive: true, force: true });
    if (options.lifecycle === "terminal") await rm(path.join(rootReal, "input"), { recursive: true, force: true });
    await restoreWritableDirectories(rootReal);
  }
  const retained = await inventoryFiles(rootReal);
  const state = {
    schema: "agmath.session-capsule-state/v1",
    session_ref: sessionRef,
    status: options.status,
    lifecycle: options.lifecycle,
    latest_manifest: manifestRelative,
    bytes_before: bytesBefore,
    bytes_retained: retained.reduce((total, item) => total + item.byte_size, 0),
    updated_at: new Date().toISOString(),
    ...(options.status === "failed" ? { failure_retain_until: manifest.failure_retain_until } : {}),
  };
  await writeFile(path.join(rootReal, ".agent", "capsule", "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return { manifest: manifestRelative, bytesBefore, bytesRetained: state.bytes_retained };
}

/** 仅处理本版本写过失败 Capsule 标记且保留期已到的工作区；旧目录和活动目录不参与。 */
export async function compactExpiredFailedWorkspaces(now = new Date()): Promise<{ compacted: number }> {
  let compacted = 0;
  const tenants = await readdir(WORKSPACE_ROOT, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return [];
    throw err;
  });
  for (const tenant of tenants) {
    if (!tenant.isDirectory() || !/^[A-Za-z0-9_-]{1,128}$/.test(tenant.name)) continue;
    const sessions = await readdir(path.join(WORKSPACE_ROOT, tenant.name), { withFileTypes: true });
    for (const session of sessions) {
      if (!session.isDirectory() || !/^[A-Za-z0-9_-]{1,128}$/.test(session.name)) continue;
      const root = path.join(WORKSPACE_ROOT, tenant.name, session.name);
      const stateFile = path.join(root, ".agent", "capsule", "state.json");
      const state = JSON.parse(await readFile(stateFile, "utf8").catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return "null";
        throw err;
      })) as { status?: string; failure_retain_until?: string; failure_compacted_at?: string } | null;
      if (!state || state.status !== "failed" || state.failure_compacted_at || !state.failure_retain_until) continue;
      const deadline = Date.parse(state.failure_retain_until);
      if (!Number.isFinite(deadline) || deadline > now.getTime()) continue;
      // 失败现场在保留期内保持原样；到期时先把原始 Pi JSONL 纳入同一 Capsule，
      // 再释放可重建输入和临时文件。归档失败则整次清理失败并留待下轮重试。
      const transcriptReferences = await archivePiSessionTranscripts(tenant.name, session.name, root);
      await rm(path.join(root, "input"), { recursive: true, force: true });
      await rm(path.join(root, "tmp"), { recursive: true, force: true });
      await rm(path.join(root, "output", "artifacts"), { recursive: true, force: true });
      await restoreWritableDirectories(root);
      const retained = await inventoryFiles(root);
      await writeFile(stateFile, `${JSON.stringify({
        ...state,
        failure_compacted_at: now.toISOString(),
        failure_transcript_refs: transcriptReferences,
        bytes_retained: retained.reduce((total, item) => total + item.byte_size, 0),
        updated_at: now.toISOString(),
      }, null, 2)}\n`, "utf8");
      compacted += 1;
    }
  }
  return { compacted };
}
