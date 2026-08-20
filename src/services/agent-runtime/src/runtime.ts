/**
 * MathPilot 运行时插件（架构修订 v4 §2："一个插件管理运行时与状态"）。
 *
 * 任务会话生命周期、respond 结构化输出、工作区文件系统、租户绑定全部收进
 * 本模块；Agent 运行时（agent loop、流式、工具执行、transcript 状态）由
 * pi-coding-agent 原生承担。领域服务（learning/content/profile）只见
 * 一次 runTask 调用，不接触会话句柄。
 *
 * 一任务一 Agent 一工作区：模型历史与文件不跨任务共享（设计 §4.1/§5.1）。
 */
import { Agent } from "@earendil-works/pi-agent-core";
import { Type, type ImageContent } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createBashToolDefinition,
  DefaultResourceLoader,
  defineTool,
  type AgentSessionEvent,
  type ModelRuntime,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createMcpAdapter } from "pi-mcp-adapter";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import pg from "pg";
import { publishWorkspaceArtifacts, type PublishedArtifact } from "./artifact-publisher.ts";
import { compileSystemPrompt, taskPromptVersion, taskRole, type TaskContext, type TaskType } from "./skills.ts";
import {
  createWorkspace,
  archivePiSessionTranscripts,
  finalizeWorkspaceRun,
  type WorkspaceInlineFile,
  type WorkspaceInput,
  type WorkspaceSessionEvidence,
  type WorkspaceLifecycle,
  WORKSPACE_MAP,
  workspacePath,
} from "./workspace.ts";

const PI_SESSION_ROOT = process.env.PI_SESSION_ROOT ?? path.resolve(".runtime/pi-sessions");
const BWRAP_BIN = process.env.BWRAP_BIN ?? "/usr/bin/bwrap";
const SEARCH_MCP_COMMAND = process.env.SEARCH_MCP_COMMAND ?? "/usr/local/bin/qwen-mm-search-mcp";
const CORE_MCP_COMMAND = process.env.CORE_MCP_COMMAND ?? "/usr/local/bin/qwen-mm-core-mcp";
const PADDLEOCR_MCP_COMMAND = process.env.PADDLEOCR_MCP_COMMAND ?? "/usr/local/bin/mathpilot-paddleocr-mcp";
// Skill 的宿主路径、Bubblewrap 路径与 ResourceLoader 公布路径必须完全一致。
// 不允许通过环境变量重新指向一个只在宿主可见的目录，否则模型会收到 Bash 无法访问的 <location>。
const MATHPILOT_SKILL_ROOT = "/opt/mathpilot-skills";
const EDU_AGENT_SKILL_ROOT = path.join(MATHPILOT_SKILL_ROOT, "edu-agent");
const AGENT_DB_MASTER_SECRET = process.env.AGENT_DB_MASTER_SECRET ?? "";
const AGENT_DB_NAME = process.env.AGENT_DB_NAME ?? "mathpilot";
const AGENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const agentDatabasePool = AGENT_DATABASE_URL ? new pg.Pool({ connectionString: AGENT_DATABASE_URL, max: 2 }) : null;

interface ActiveRun {
  taskType: TaskType;
  messages: string[];
  acceptingMessages: boolean;
}
const activeRuns = new Map<string, ActiveRun>();

function activeRunKey(tenantId: string, sessionRef: string): string {
  return `${tenantId}\u0000${sessionRef}`;
}

/** 管理侧引导只排入已经运行的同一个 Pi Session；不会并发创建第二个 Agent loop。 */
export function queueActiveSessionMessage(
  tenantId: string,
  sessionRef: string,
  message: string,
): { queued: boolean; taskType?: TaskType; position?: number } {
  const active = activeRuns.get(activeRunKey(tenantId, sessionRef));
  if (!active?.acceptingMessages) return { queued: false };
  active.messages.push(message);
  return { queued: true, taskType: active.taskType, position: active.messages.length };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export interface TaskRunOptions {
  taskType: TaskType;
  /** 领域侧稳定引用（session_id / agent_run_id），用于审计关联 */
  sessionRef: string;
  tenantId: string;
  context: TaskContext;
  promptText?: string;
  inputArtifacts?: readonly WorkspaceInput[];
  workspaceFiles?: readonly WorkspaceInlineFile[];
  /** 将同租户前序 Session 的已固化 output 复制为本 Session 的只读输入；不共享 transcript 或可写目录。 */
  sessionEvidence?: readonly WorkspaceSessionEvidence[];
  /** 图片直接进入当前 Pi 主模型消息，不经 Qwen-MM-Plugins 的模型 API。 */
  promptImages?: readonly ImageContent[];
  /** 宿主强制的数据主体范围；模型不能在工具参数中改变租户或扩张主体。 */
  databaseScope?: { actorId?: string; studentId?: string; sessionId?: string; questionIds?: readonly string[] };
  /** continuing 保留 input 供同一教学 Session 后续回合；terminal 只保留审计、结果和已发布 Artifact。 */
  workspaceLifecycle?: WorkspaceLifecycle;
}

interface TaskRunSuccess {
  ok: true;
  outputJson?: unknown;
  outputText?: string;
  implementation: string;
  promptVersion: string;
  latencyMs: number;
  sessionId: string;
  sessionFile?: string;
  stats: {
    userMessages: number; assistantMessages: number; toolCalls: number; toolResults: number;
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
    cost: number;
  };
  events: RuntimeAgentEvent[];
  artifacts: PublishedArtifact[];
}

export type TaskRunResult = TaskRunSuccess | { ok: false; error: string; detail?: string };

/** respond 工具：最终结构化输出（输出契约由任务策略约定，领域服务层做语义校验） */
const respondTool = defineTool({
  name: "respond",
  label: "Respond",
  description: "提交最终结果。KTQ/ER 必须引用已经由对应 Skill 验证的工作区文件；其他任务可使用 output。",
  parameters: Type.Object({
    output: Type.Optional(Type.Unknown()),
    result_file: Type.Optional(Type.String()),
    validation_file: Type.Optional(Type.String()),
  }),
  execute: async (_toolCallId, params) => ({
    content: [{ type: "text", text: "responded" }],
    details: params,
    terminate: true,
  }),
});

interface RuntimeAgentEvent {
  seq: number;
  at: string;
  taskType: TaskType;
  type: "agent_start" | "turn_start" | "model_update" | "assistant_message" | "tool_start" | "tool_end" | "turn_end" | "agent_end" | "session_end" | "retry";
  label: string;
  status: "running" | "completed" | "failed" | "info";
  detail?: string;
  toolName?: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
}

function preview(value: unknown, max = 800): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text ?? "").replaceAll(/\s+/g, " ").slice(0, max);
}

function messageText(message: unknown): string {
  const m = message as { role?: string; content?: unknown };
  if (m.role !== "assistant" || !Array.isArray(m.content)) return "";
  return m.content
    .filter((p): p is { type: "text"; text: string } => Boolean(p && typeof p === "object" && (p as { type?: string }).type === "text"))
    .map((p) => p.text)
    .join("")
    .trim();
}

function normalizeEvent(event: AgentSessionEvent, taskType: TaskType, seq: number): RuntimeAgentEvent | null {
  const base = { seq, at: new Date().toISOString(), taskType };
  switch (event.type) {
    case "agent_start": return { ...base, type: "agent_start", label: "Pi Agent 开始", status: "running" };
    case "turn_start": return { ...base, type: "turn_start", label: "模型回合开始", status: "running" };
    case "message_update":
      // 不向前端暴露私有思维内容，只显示模型当前阶段。
      // 思考 delta 数量极大且没有可公开语义；前端用 turn_start 的进行态表达即可。
      return null;
    case "message_end": {
      const text = messageText(event.message);
      return text ? { ...base, type: "assistant_message", label: "Agent 回复", status: "completed", detail: text.slice(0, 4000) } : null;
    }
    case "tool_execution_start":
      return { ...base, type: "tool_start", label: `调用 ${event.toolName}`, status: "running", toolName: event.toolName,
        detail: event.toolName === "respond" ? "提交结构化结果" : preview(event.args) };
    case "tool_execution_end":
      return { ...base, type: "tool_end", label: `${event.toolName} ${event.isError ? "失败" : "完成"}`,
        status: event.isError ? "failed" : "completed", toolName: event.toolName,
        detail: event.toolName === "respond" ? "结构化结果已提交" : preview(event.result) };
    case "turn_end": {
      const m = event.message as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } };
      const u = m.usage;
      return { ...base, type: "turn_end", label: "模型回合完成", status: "completed",
        ...(u ? { usage: { input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0,
          total: (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) } } : {}) };
    }
    // Pi 的 agent_end 是一次 prompt 回合结束；同一业务 Session 仍可能消费教师引导继续下一回合。
    // 整个运行真正结束时由 runTask 另写 session_end。
    case "agent_end": return null;
    case "auto_retry_start": return { ...base, type: "retry", label: `模型重试 ${event.attempt}/${event.maxAttempts}`,
      status: "running", detail: event.errorMessage.slice(0, 500) };
    case "auto_retry_end": return { ...base, type: "retry", label: "模型重试结束", status: event.success ? "completed" : "failed",
      ...(event.finalError ? { detail: event.finalError.slice(0, 500) } : {}) };
    default: return null;
  }
}

/**
 * 固定能力壳：每种任务都看到相同的 Core / PaddleOCR / Search 工具目录。
 * 任务差异由工作区、Skill、Prompt、数据库 scope 与目标形成，而不是裁剪 Pi 工具。
 * 工作区检索仍只用 Bash 内的 rg/find；Search 只处理外部网络事实。
 */
function capabilityExtensionFactories(workspaceRoot: string) {
  const servers: Record<string, Record<string, unknown>> = {
    "qwen-mm-plugins-core": {
      command: CORE_MCP_COMMAND,
      args: [workspaceRoot],
      lifecycle: "eager",
      requestTimeoutMs: 90_000,
      directTools: ["read_image", "read_video", "media_info", "visualize", "crop", "draw_bbox", "save_view"],
      includeTools: ["read_image", "read_video", "media_info", "visualize", "crop", "draw_bbox", "save_view"],
      toolPrefix: "none",
    },
    "qwen-mm-plugins-search": {
      command: SEARCH_MCP_COMMAND,
      lifecycle: "eager",
      requestTimeoutMs: 60_000,
      directTools: ["web_search", "web_extractor", "image_search"],
      includeTools: ["web_search", "web_extractor", "image_search"],
      toolPrefix: "none",
    },
    "paddleocr-vl": {
      command: PADDLEOCR_MCP_COMMAND,
      args: [workspaceRoot],
      lifecycle: "eager",
      requestTimeoutMs: 660_000,
      directTools: ["paddleocr_vl"],
      includeTools: ["paddleocr_vl"],
      toolPrefix: "none",
    },
  };
  return [createMcpAdapter({
    config: {
      settings: {
        toolPrefix: "none",
        disableProxyTool: true,
        scriptMode: false,
        outputGuard: { maxBytes: 48 * 1024, maxLines: 1200, detailsMaxBytes: 16 * 1024 },
      },
      mcpServers: servers,
    },
  })];
}

async function waitForQwenTools(
  session: { getActiveToolNames(): string[] },
  timeoutMs = 15_000,
): Promise<void> {
  const required = ["read_image", "read_video", "media_info", "visualize", "crop", "draw_bbox", "save_view",
    "web_search", "web_extractor", "image_search", "paddleocr_vl"];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const active = new Set(session.getActiveToolNames());
    if (required.every((name) => active.has(name))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Agent shell tools unavailable after ${timeoutMs}ms: ${required.join(", ")}`);
}

function dbIdentity(taskType: TaskType, tenantId: string, scope: TaskRunOptions["databaseScope"]): { user: string; password: string; scope: string } | null {
  const safe = (value: string) => value.replaceAll(/[^A-Za-z0-9_]/g, "_");
  if (!AGENT_DB_MASTER_SECRET) return null;
  const identity = (user: string, identityScope: string) => ({
    user,
    // 每个登录身份独立凭据；沙箱看到当前密码也不能切换成其他租户/学生角色。
    password: createHash("sha256").update(`${AGENT_DB_MASTER_SECRET}:${user}`).digest("hex"),
    scope: identityScope,
  });
  if (scope?.studentId) {
    const user = `mathpilot_agent_${safe(tenantId)}_${safe(scope.studentId)}`;
    return user.length <= 63 ? identity(user, `student:${scope.studentId}`) : null;
  }
  if (!scope?.actorId) return null;
  const user = `mathpilot_agent_content_${safe(tenantId)}_${safe(scope.actorId)}`;
  return user.length <= 63 ? identity(user, `content:${scope.actorId}:${taskType}`) : null;
}

async function provisionDatabaseIdentity(
  databaseIdentity: { user: string; password: string; scope: string } | null,
  tenantId: string,
  scope: TaskRunOptions["databaseScope"],
): Promise<void> {
  if (!databaseIdentity || !agentDatabasePool) return;
  const subject = scope?.studentId ?? scope?.actorId;
  if (!subject) throw new Error("database identity subject missing");
  const scopeKind = scope?.studentId ? "teaching" : "content";
  const result = await agentDatabasePool.query<{ role_name: string }>(
    "select mathpilot_provision_agent_identity($1,$2,$3,$4)::text as role_name",
    [tenantId, scopeKind, subject, databaseIdentity.password],
  );
  if (result.rows[0]?.role_name !== databaseIdentity.user) {
    throw new Error("provisioned database identity mismatch");
  }
}

function sandboxedBashCommand(
  workspaceRoot: string,
  cwd: string,
  command: string,
  databaseIdentity: { user: string; password: string; scope: string } | null,
): string {
  const relativeCwd = path.relative(workspaceRoot, cwd);
  if (relativeCwd === ".." || relativeCwd.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCwd)) {
    throw new Error("bash cwd escapes workspace");
  }
  const sandboxCwd = relativeCwd ? `/workspace/${relativeCwd.split(path.sep).join("/")}` : "/workspace";
  const args = [
    BWRAP_BIN,
    "--unshare-all", "--die-with-parent", "--new-session",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/lib", "/lib",
    "--ro-bind", "/lib64", "/lib64",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--ro-bind", workspaceRoot, "/workspace",
    "--bind", path.join(workspaceRoot, "output"), "/workspace/output",
    "--bind", path.join(workspaceRoot, "tmp"), "/workspace/tmp",
    "--chdir", sandboxCwd,
    "--clearenv",
    "--setenv", "HOME", "/workspace/tmp",
    "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin",
    "--setenv", "LANG", "C.UTF-8",
    "--setenv", "EDU_SKILL_ROOT", EDU_AGENT_SKILL_ROOT,
    // Debian 的 /usr/bin/chromium 是会 source /etc/chromium.d/* 的包装器；沙箱
    // 不暴露整套 /etc，因此直接固定到只读 /usr 下的真实浏览器二进制。
    "--setenv", "HYPERFRAMES_BROWSER_PATH", "/usr/lib/chromium/chromium",
    "--setenv", "HYPERFRAMES_FFMPEG_PATH", "/usr/bin/ffmpeg",
    "--setenv", "HYPERFRAMES_FFPROBE_PATH", "/usr/bin/ffprobe",
    "--setenv", "HYPERFRAMES_SKIP_SKILLS", "1",
    "--setenv", "HYPERFRAMES_NO_TELEMETRY", "1",
  ];
  for (const readable of ["/etc/alternatives", "/etc/fonts", "/etc/ssl/certs"]) {
    if (existsSync(readable)) args.push("--ro-bind", readable, readable);
  }
  if (existsSync(MATHPILOT_SKILL_ROOT)) {
    args.push("--ro-bind", MATHPILOT_SKILL_ROOT, "/opt/mathpilot-skills");
    args.push("--setenv", "MATHPILOT_SKILL_ROOT", "/opt/mathpilot-skills");
  }
  if (databaseIdentity && existsSync("/var/run/mathpilot-db/.s.PGSQL.5432")) {
    args.push("--ro-bind", "/var/run/mathpilot-db", "/var/run/mathpilot-db");
    args.push("--setenv", "PGHOST", "/var/run/mathpilot-db");
    args.push("--setenv", "PGPORT", "5432");
    args.push("--setenv", "PGDATABASE", AGENT_DB_NAME);
    args.push("--setenv", "PGUSER", databaseIdentity.user);
    args.push("--setenv", "PGPASSWORD", databaseIdentity.password);
    args.push("--setenv", "PGOPTIONS", "-c statement_timeout=15000 -c default_transaction_read_only=on");
    args.push("--setenv", "MATHPILOT_DB_SCOPE", databaseIdentity.scope);
  }
  args.push("/bin/sh", "-lc", command);
  return `exec setpriv --reuid=65534 --regid=65534 --clear-groups --no-new-privs ${args.map(shellQuote).join(" ")}`;
}

async function sessionManagerFor(cwd: string, tenantId: string, sessionRef: string): Promise<SessionManager> {
  const sessionDir = path.join(PI_SESSION_ROOT, tenantId, sessionRef);
  await mkdir(sessionDir, { recursive: true });
  const files = (await readdir(sessionDir)).filter((f) => f.endsWith(".jsonl")).sort();
  const latest = files.at(-1);
  return latest
    ? SessionManager.open(path.join(sessionDir, latest), sessionDir, cwd)
    : SessionManager.create(cwd, sessionDir);
}

/** 从本轮新增消息中提取最后一次 respond 输出；绝不能把历史轮次结果当成本轮成功。 */
function extractRespondOutput(agent: Agent, fromMessageIndex: number): unknown {
  let found: unknown;
  for (const msg of agent.state.messages.slice(fromMessageIndex)) {
    if (msg.role !== "assistant") continue;
    for (const part of msg.content) {
      if (part.type !== "toolCall" || part.name !== "respond") continue;
      const args = part.arguments as { output?: unknown; result_file?: string; validation_file?: string };
      const raw = args.result_file ? { result_file: args.result_file, validation_file: args.validation_file } : args.output;
      if (typeof raw === "string") {
        try { found = JSON.parse(raw); } catch { found = raw; }
      } else {
        found = raw;
      }
    }
  }
  return found;
}

function resolveWorkspaceFile(workspaceRoot: string, relative: string, label: string): string {
  if (!relative || path.isAbsolute(relative)) throw new Error(`${label} must be workspace-relative`);
  const normalized = path.normalize(relative);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) throw new Error(`${label} escapes workspace`);
  const target = path.resolve(workspaceRoot, normalized);
  if (target !== workspaceRoot && !target.startsWith(`${workspaceRoot}${path.sep}`)) throw new Error(`${label} escapes workspace`);
  return target;
}

const execFileAsync = promisify(execFile);

async function loadValidatedResult(taskType: TaskType, workspaceRoot: string, value: unknown): Promise<unknown> {
  if (taskType !== "ktq_extract" && taskType !== "er_research") return value;
  const ref = value as { result_file?: string; validation_file?: string };
  if (!ref || typeof ref.result_file !== "string" || typeof ref.validation_file !== "string") {
    throw new Error(`${taskType} respond must reference result_file and validation_file`);
  }
  const resultFile = resolveWorkspaceFile(workspaceRoot, ref.result_file, "result_file");
  const validationFile = resolveWorkspaceFile(workspaceRoot, ref.validation_file, "validation_file");
  if (!ref.result_file.replaceAll("\\", "/").startsWith("output/")) throw new Error("result_file must be below output/");
  const bytes = await readFile(resultFile);
  if (bytes.length > 8 * 1024 * 1024) throw new Error("result_file exceeds 8MiB");
  const receipt = JSON.parse(await readFile(validationFile, "utf8")) as { valid?: boolean; sha256?: string; skill?: string };
  const expectedSkill = taskType === "ktq_extract" ? "ktq-extraction" : "er-research";
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (!receipt.valid || receipt.skill !== expectedSkill || receipt.sha256 !== digest) {
    throw new Error("validation receipt does not match the exact result file");
  }
  const validator = path.join(MATHPILOT_SKILL_ROOT, expectedSkill, "scripts", "validate.py");
  const runtimeReceipt = path.join(workspaceRoot, "tmp", `${expectedSkill}-runtime-validation.json`);
  const args = taskType === "ktq_extract"
    ? [validator, resultFile, "--workspace", workspaceRoot, "--receipt", runtimeReceipt]
    : [validator, resultFile, "--frozen", path.join(workspaceRoot, "input", "frozen", "ktq.json"), "--receipt", runtimeReceipt];
  await execFileAsync("python3", args, { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(bytes.toString("utf8"));
}

/** 仅用于挽救旧协议已经完成且留在同一持久工作区的 KTQ 文件，不启动模型。 */
export async function recoverLegacyKtqResult(tenantId: string, sessionRef: string, sourceFile: string): Promise<unknown> {
  if (!/^run_ktq_[a-f0-9]{32}$/.test(sessionRef)) throw new Error("invalid KTQ session ref");
  if (!new Set(["tmp/final_output.json", "tmp/final_compact.json"]).has(sourceFile)) throw new Error("legacy source file is not allowed");
  const workspaceRoot = workspacePath(tenantId, sessionRef);
  const source = resolveWorkspaceFile(workspaceRoot, sourceFile, "source_file");
  const raw = JSON.parse(await readFile(source, "utf8")) as Record<string, unknown>;
  const result = { schema: "mathpilot.ktq-result/v1", ...raw };
  const resultFile = path.join(workspaceRoot, "output", "ktq-result.recovered.json");
  const receiptFile = path.join(workspaceRoot, "output", "ktq-result.recovered.validation.json");
  await writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  const validator = path.join(MATHPILOT_SKILL_ROOT, "ktq-extraction", "scripts", "validate.py");
  await execFileAsync("python3", [validator, resultFile, "--workspace", workspaceRoot, "--receipt", receiptFile], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  return result;
}

async function boundedShutdown(session: { extensionRunner: { emit(event: { type: "session_shutdown"; reason: "quit" }): Promise<unknown> }; dispose(): void }): Promise<void> {
  try {
    await Promise.race([
      session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("session_shutdown timed out after 5s")), 5_000)),
    ]).catch(() => undefined);
  } finally {
    session.dispose();
  }
}

function extractLastText(agent: Agent, fromMessageIndex: number): string {
  return agent.state.messages
    .slice(fromMessageIndex)
    .filter((m) => m.role === "assistant")
    .at(-1)
    ?.content
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("") ?? "";
}

/**
 * 执行一个任务 Session：编译任务 Prompt（策略源 + 工作区）→ Agent 原生运行 → respond 输出
 * → 清理工作区。模型角色由策略 manifest 决定（主=教学，辅=内容生产线/画像异步更新）。
 */
export async function runTask(
  modelRuntime: ModelRuntime,
  modelIds: { main: string; aux: string },
  opts: TaskRunOptions,
): Promise<TaskRunResult> {
  const started = Date.now();
  const runKey = activeRunKey(opts.tenantId, opts.sessionRef);
  if (activeRuns.has(runKey)) return { ok: false, error: "session_busy", detail: "该 Pi Session 已在运行，请把引导消息加入队列" };
  const activeRun: ActiveRun = { taskType: opts.taskType, messages: [], acceptingMessages: true };
  activeRuns.set(runKey, activeRun);
  const role = taskRole(opts.taskType);
  const model = modelRuntime.getModel("scnet", role === "aux" ? modelIds.aux : modelIds.main);
  if (!model) {
    activeRuns.delete(runKey);
    return { ok: false, error: "model_not_found", detail: `${role} model in scnet provider` };
  }

  let ws;
  let workspaceFinalized = false;
  const workspaceLifecycle: WorkspaceLifecycle = opts.workspaceLifecycle ?? (
    new Set<TaskType>(["ktq_extract", "er_research", "session_decision", "continuity_summary", "dream_profile", "plan"])
      .has(opts.taskType) ? "terminal" : "continuing"
  );
  try {
    const agentsMd = compileSystemPrompt(opts.taskType, opts.context, WORKSPACE_MAP);
    ws = await createWorkspace(opts.tenantId, opts.sessionRef, {
      task_type: opts.taskType,
      session_ref: opts.sessionRef,
      context: opts.context,
    }, agentsMd, opts.inputArtifacts ?? [], opts.workspaceFiles ?? [], opts.sessionEvidence ?? []);
  } catch (err) {
    activeRuns.delete(runKey);
    return { ok: false, error: "workspace_failed", detail: err instanceof Error ? err.message : String(err) };
  }

  const events: RuntimeAgentEvent[] = [];
  const eventsDir = path.join(ws.root, ".agent");
  const eventsFile = path.join(eventsDir, "events.jsonl");
  await mkdir(eventsDir, { recursive: true });
  let eventWrites: Promise<void> = Promise.resolve();
  let eventSeq = 0;
  let finalEventWritten = false;
  const persistEvent = (event: RuntimeAgentEvent) => {
    events.push(event);
    eventWrites = eventWrites.then(() => appendFile(eventsFile, `${JSON.stringify(event)}\n`, "utf8"));
  };
  const persistSessionEnd = (status: "completed" | "failed", detail?: string) => {
    if (finalEventWritten) return;
    finalEventWritten = true;
    persistEvent({
      seq: ++eventSeq, at: new Date().toISOString(), taskType: opts.taskType,
      type: "session_end", label: status === "completed" ? "处理完成" : "处理未完成",
      status, ...(detail ? { detail: detail.slice(0, 500) } : {}),
    });
  };
  let disposeSession: (() => Promise<void>) | undefined;
  try {
    const databaseIdentity = dbIdentity(opts.taskType, opts.tenantId, opts.databaseScope);
    await provisionDatabaseIdentity(databaseIdentity, opts.tenantId, opts.databaseScope);
    const bashTool = createBashToolDefinition(ws.root, {
      exposeSessionEnvironment: false,
      spawnHook: ({ command, cwd }) => ({
        // Docker 内：先降权，再进入只映射当前工作区的 Bubblewrap 命名空间。
        // Bash 无宿主根文件系统、无宿主 PID、无网络；联网仅由 Search MCP 宿主执行。
        command: typeof process.getuid === "function" && process.getuid() === 0
          ? sandboxedBashCommand(ws.root, cwd, command, databaseIdentity)
          : command,
        cwd,
        // 模型工具进程绝不继承供应商凭据。
        env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", HOME: path.join(ws.root, "tmp") },
      }),
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: ws.root,
      // 嵌入式服务不得读取宿主用户的 ~/.pi 配置或插件。
      agentDir: path.join(ws.root, ".pi-agent"),
      extensionFactories: capabilityExtensionFactories(ws.root),
      additionalSkillPaths: readdirSync(MATHPILOT_SKILL_ROOT, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && existsSync(path.join(MATHPILOT_SKILL_ROOT, entry.name, "SKILL.md")))
          .map((entry) => path.join(MATHPILOT_SKILL_ROOT, entry.name)),
    });
    await resourceLoader.reload();
    const sessionManager = await sessionManagerFor(ws.root, opts.tenantId, opts.sessionRef);
    const { session } = await createAgentSession({
      cwd: ws.root,
      model,
      modelRuntime,
      sessionManager,
      resourceLoader,
      noTools: "builtin",
      customTools: [bashTool as unknown as ToolDefinition, respondTool],
    });
    disposeSession = () => boundedShutdown(session);
    // 首次连接 MCP 时 direct tools 由元数据热加载；禁止在临时 mcp 代理仍是
    // 唯一搜索入口时启动模型回合，确保 ER 始终看到稳定的专用工具名。
    await waitForQwenTools(session);
    const messageCountBeforePrompt = session.agent.state.messages.length;
    const unsubscribe = session.subscribe((event) => {
      const normalized = normalizeEvent(event, opts.taskType, ++eventSeq);
      if (normalized) persistEvent(normalized);
    });
    try {
      await session.prompt(
        opts.promptText ?? "请读取当前工作区的任务上下文，按任务提示执行，并用 respond 输出最终结构化结果。",
        opts.promptImages?.length ? { images: [...opts.promptImages] } : undefined,
      );
      // 当前工具/模型回合结束后消费教师在运行期间排队的引导；最终 respond 才交给领域服务。
      // 每轮结束保留一个短暂的可见接续窗口，覆盖浏览器轮询刚看到回复时追加引导的边界。
      let guidanceDeadline = Date.now() + 1_500;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const guidance = activeRun.messages.shift();
        if (!guidance) {
          if (Date.now() < guidanceDeadline) continue;
          break;
        }
        await session.prompt(`教师在管理页面追加了引导。请在同一个 Session 中结合已有对话与工作区继续执行，并重新用 respond 提交完整结果：\n\n${guidance}`);
        guidanceDeadline = Date.now() + 1_500;
      }
      activeRun.acceptingMessages = false;
    } finally {
      activeRun.acceptingMessages = false;
      unsubscribe();
    }

    let outputJson = extractRespondOutput(session.agent, messageCountBeforePrompt);
    if (outputJson !== undefined) outputJson = await loadValidatedResult(opts.taskType, ws.root, outputJson);
    const outputText = extractLastText(session.agent, messageCountBeforePrompt);
    // 模型未产出任何结果（凭据缺失/配额/空响应）：显式失败，不返回空成功（架构修订 v4 §0.4）
    if (outputJson === undefined && outputText === "") {
      await disposeSession();
      disposeSession = undefined;
      persistSessionEnd("failed", session.agent.state.errorMessage ?? "模型未产出结果");
      await eventWrites;
      await finalizeWorkspaceRun(opts.tenantId, opts.sessionRef, {
        status: "failed", lifecycle: workspaceLifecycle, taskType: opts.taskType,
        detail: session.agent.state.errorMessage ?? "模型未产出结果",
      });
      workspaceFinalized = true;
      return {
        ok: false,
        error: session.agent.state.errorMessage ? "pi_run_failed" : "pi_run_empty",
        detail: session.agent.state.errorMessage ?? "模型未产出任何结果（检查凭据与配额）",
      };
    }
    const artifacts = await publishWorkspaceArtifacts(ws.root, opts.sessionRef);
    if (artifacts.length && outputJson && typeof outputJson === "object" && !Array.isArray(outputJson)) {
      const existing = Array.isArray((outputJson as { artifacts?: unknown[] }).artifacts) ? (outputJson as { artifacts: unknown[] }).artifacts : [];
      outputJson = { ...(outputJson as Record<string, unknown>), artifacts: [...existing, ...artifacts] };
    }
    const stats = session.getSessionStats();
    const sessionFile = session.sessionFile;
    const sessionId = session.sessionId;
    await disposeSession();
    disposeSession = undefined;
    persistSessionEnd("completed");
    await eventWrites;
    const transcriptReferences = workspaceLifecycle === "terminal"
      ? await archivePiSessionTranscripts(opts.tenantId, opts.sessionRef, ws.root)
      : [];
    // API/领域服务只获得不透明引用，绝不泄露 /var/lib/mathpilot 等宿主路径。
    const retainedSessionFile = workspaceLifecycle === "terminal"
      ? transcriptReferences.at(-1)
      : (sessionFile ? `pi://session/${opts.sessionRef}` : undefined);
    await finalizeWorkspaceRun(opts.tenantId, opts.sessionRef, {
      status: "completed", lifecycle: workspaceLifecycle, taskType: opts.taskType,
    });
    workspaceFinalized = true;
    return {
      ok: true,
      ...(outputJson !== undefined ? { outputJson } : {}),
      ...(outputText ? { outputText } : {}),
      implementation: "pi-coding-agent.scnet",
      promptVersion: taskPromptVersion(opts.taskType),
      latencyMs: Date.now() - started,
      sessionId,
      ...(retainedSessionFile ? { sessionFile: retainedSessionFile } : {}),
      stats: {
        userMessages: stats.userMessages, assistantMessages: stats.assistantMessages,
        toolCalls: stats.toolCalls, toolResults: stats.toolResults, tokens: stats.tokens, cost: stats.cost,
      },
      events,
      artifacts,
    };
  } catch (err) {
    await disposeSession?.().catch(() => undefined);
    persistSessionEnd("failed", err instanceof Error ? err.message : String(err));
    await eventWrites.catch(() => undefined);
    if (ws && !workspaceFinalized) {
      await finalizeWorkspaceRun(opts.tenantId, opts.sessionRef, {
        status: "failed", lifecycle: workspaceLifecycle, taskType: opts.taskType,
        detail: err instanceof Error ? err.message : String(err),
      }).catch(() => undefined);
      workspaceFinalized = true;
    }
    return { ok: false, error: "pi_run_failed", detail: err instanceof Error ? err.message : String(err) };
  } finally {
    activeRuns.delete(runKey);
  }
}
