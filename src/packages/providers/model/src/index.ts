/**
 * @mathpilot/providers-model — ModelProvider 的宿主侧客户端（设计 §2.4 packages/providers/model，
 * 架构修订 v4 §2）。
 *
 * 领域服务不直连任何模型供应商（ADR-001、设计 §4.2）：模型调用统一经
 * agent-runtime（Pi Agent Harness 宿主）。宿主内部：pi-ai 原生 Provider 注册、
 * pi-agent-core Agent 原生运行时、MathPilot 运行时插件（会话/工作区/respond）——
 * 领域服务只有一次 runTask 调用（POST /runtime/tasks），不接触会话句柄。
 *
 * 具体模型 ID 是 agent-runtime 的配置实例，不得出现在领域类型名中（设计 §1.2.2）。
 */
import { Agent, fetch as undiciFetch } from "undici";

export type TaskType =
  | "teach_grade"      // Teaching Agent：模型主判答
  | "teach_interact"   // Teaching Agent：多轮帮助/步骤检查/自由问答
  | "teach_summary"    // Teaching Agent：教学总结（双产物之一）
  | "continuity_summary" // 辅助模型：跨题递归连续学习摘要
  | "ktq_extract"      // KTQ Extraction Agent：内容抽取
  | "er_research"      // ER Research Agent：错因/规则调研
  | "dream_profile"     // Dream/Profile Update Agent：长期画像最终更新
  | "diagnose"         // Teaching Agent：错因归因（DIAGNOSE，§8.3）
  | "session_decision"  // Teaching Agent：会话结束目标判定（§10.1）
  | "plan";             // 学习计划转写（§10.3）

export interface AgentRuntimeClientConfig {
  readonly baseUrl: string;
  /** 单任务总超时（推理模型判答/抽取/画像更新可达 5–10 分钟） */
  readonly timeoutMs?: number;
}

export interface TaskRunOptions {
  readonly taskType: TaskType;
  /** 领域侧稳定引用（session_id / agent_run_id），用于审计关联 */
  readonly sessionRef: string;
  readonly context: Record<string, unknown>;
  /** 租户隔离：宿主会话绑定该租户，跨租户一律 403（设计 §15.2） */
  readonly tenantId?: string;
  readonly promptText?: string;
  readonly inputArtifacts?: readonly {
    readonly artifactRef: string;
    readonly workspacePath: string;
  }[];
  readonly workspaceFiles?: readonly { readonly workspacePath: string; readonly content: string }[];
  readonly sessionEvidence?: readonly { readonly sessionRef: string; readonly sourcePath: string; readonly workspacePath: string }[];
  /** 直接传给当前任务模型的多模态输入；禁止转交插件内部其他模型。 */
  readonly promptImages?: readonly { readonly data: string; readonly mimeType: "image/png" | "image/jpeg" | "image/webp" }[];
  readonly databaseScope?: {
    readonly actorId?: string;
    readonly studentId?: string;
    readonly sessionId?: string;
    readonly questionIds?: readonly string[];
  };
  readonly workspaceLifecycle?: "continuing" | "terminal";
}

export interface AgentTraceEvent {
  readonly seq: number;
  readonly at: string;
  readonly taskType: TaskType;
  readonly type: string;
  readonly label: string;
  readonly status: "running" | "completed" | "failed" | "info";
  readonly detail?: string;
  readonly toolName?: string;
  readonly usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
}

export type TaskResult =
  | {
      readonly ok: true;
      readonly outputJson?: unknown;
      readonly outputText?: string;
      readonly implementation?: string;
      /** 任务策略版本（policies/tasks.manifest.json 单一来源；写入血缘/审计字段） */
      readonly promptVersion?: string;
      readonly piSessionId?: string;
      readonly stats?: Record<string, unknown>;
      readonly events?: readonly AgentTraceEvent[];
    }
  | { readonly ok: false; readonly status: number; readonly error: string; readonly detail?: string };

/** 抽取任务可处理多份长文档；具体业务仍由各客户端 timeout signal 收紧。 */
const TRANSPORT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const longAgent = new Agent({ headersTimeout: TRANSPORT_TIMEOUT_MS, bodyTimeout: TRANSPORT_TIMEOUT_MS, connectTimeout: 30_000 });

function fetchLong(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return undiciFetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    dispatcher: longAgent,
  } as Parameters<typeof undiciFetch>[1]);
}

export function createAgentRuntimeClient(cfg: AgentRuntimeClientConfig): {
  runTask(opts: TaskRunOptions): Promise<TaskResult>;
  getSessionEvents(sessionRef: string, tenantId: string): Promise<{ ok: true; events: AgentTraceEvent[] } | { ok: false; status: number; error: string }>;
  cancelSession(sessionRef: string, tenantId: string, reason?: string): Promise<{ ok: boolean; status: number }>;
} {
  const timeoutMs = cfg.timeoutMs ?? 600_000;
  const base = cfg.baseUrl.replace(/\/$/, "");

  /** 单次任务运行（会话生命周期在宿主内，领域服务不持有句柄） */
  async function runTask(opts: TaskRunOptions): Promise<TaskResult> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.tenantId) headers["x-tenant-id"] = opts.tenantId;
    try {
      const res = await fetchLong(
        `${base}/runtime/tasks`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            task_type: opts.taskType,
            session_ref: opts.sessionRef,
            context: opts.context,
            ...(opts.promptText !== undefined ? { prompt_text: opts.promptText } : {}),
            ...(opts.inputArtifacts !== undefined ? { input_artifacts: opts.inputArtifacts } : {}),
            ...(opts.workspaceFiles !== undefined ? { workspace_files: opts.workspaceFiles } : {}),
            ...(opts.sessionEvidence !== undefined ? { session_evidence: opts.sessionEvidence } : {}),
            ...(opts.promptImages !== undefined ? { prompt_images: opts.promptImages } : {}),
            ...(opts.databaseScope !== undefined ? { database_scope: opts.databaseScope } : {}),
            ...(opts.workspaceLifecycle !== undefined ? { workspace_lifecycle: opts.workspaceLifecycle } : {}),
          }),
        },
        timeoutMs,
      );
      const d = (await res.json()) as {
        ok?: boolean;
        value?: { outputText?: string; outputJson?: unknown };
        trace?: { implementation?: string; promptVersion?: string; piSessionId?: string; stats?: Record<string, unknown>; events?: AgentTraceEvent[] };
        error?: { code?: string; message?: string };
      };
      if (!res.ok || !d.ok) {
        return {
          ok: false,
          status: res.status,
          error: d.error?.code ?? "task_run_failed",
          ...(d.error?.message !== undefined ? { detail: d.error.message } : {}),
        };
      }
      return {
        ok: true,
        ...(d.value?.outputJson !== undefined ? { outputJson: d.value.outputJson } : {}),
        ...(d.value?.outputText !== undefined ? { outputText: d.value.outputText } : {}),
        ...(d.trace?.implementation ? { implementation: d.trace.implementation } : {}),
        ...(d.trace?.promptVersion ? { promptVersion: d.trace.promptVersion } : {}),
        ...(d.trace?.piSessionId ? { piSessionId: d.trace.piSessionId } : {}),
        ...(d.trace?.stats ? { stats: d.trace.stats } : {}),
        ...(d.trace?.events ? { events: d.trace.events } : {}),
      };
    } catch {
      if (opts.tenantId) await cancelSession(opts.sessionRef, opts.tenantId, "上游模型请求超时或连接中断").catch(() => undefined);
      return { ok: false, status: 502, error: "agent_runtime_unreachable" };
    }
  }

  async function cancelSession(sessionRef: string, tenantId: string, reason = "上游任务已取消"): Promise<{ ok: boolean; status: number }> {
    try {
      const res = await fetchLong(`${base}/runtime/sessions/${encodeURIComponent(sessionRef)}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-id": tenantId },
        body: JSON.stringify({ reason }),
      }, 30_000);
      return { ok: res.ok || res.status === 409, status: res.status };
    } catch {
      return { ok: false, status: 502 };
    }
  }

  async function getSessionEvents(
    sessionRef: string,
    tenantId: string,
  ): Promise<{ ok: true; events: AgentTraceEvent[] } | { ok: false; status: number; error: string }> {
    try {
      const res = await fetchLong(`${base}/runtime/sessions/${encodeURIComponent(sessionRef)}/events`, {
        headers: { "x-tenant-id": tenantId },
      }, 30_000);
      const d = (await res.json()) as { events?: AgentTraceEvent[]; error?: string };
      if (!res.ok) return { ok: false, status: res.status, error: d.error ?? "trace_unavailable" };
      return { ok: true, events: d.events ?? [] };
    } catch {
      return { ok: false, status: 502, error: "agent_runtime_unreachable" };
    }
  }

  return { runTask, getSessionEvents, cancelSession };
}
