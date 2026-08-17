/**
 * @agmath/providers-model — ModelProvider 的宿主侧客户端（设计 §2.4 packages/providers/model，
 * 架构修订 v4 §2）。
 *
 * 领域服务不直连任何模型供应商（ADR-001、设计 §4.2）：模型调用统一经
 * agent-runtime（Pi Agent Harness 宿主）。宿主内部：pi-ai 原生 Provider 注册、
 * pi-agent-core Agent 原生运行时、AGMATH 运行时插件（会话/工作区/respond）——
 * 领域服务只有一次 runTask 调用（POST /runtime/tasks），不接触会话句柄。
 *
 * 具体模型 ID 是 agent-runtime 的配置实例，不得出现在领域类型名中（设计 §1.2.2）。
 */
import { Agent, fetch as undiciFetch } from "undici";

export type TaskType =
  | "teach_grade"      // Teaching Agent：模型主判答
  | "teach_summary"    // Teaching Agent：教学总结（双产物之一）
  | "ktq_extract"      // KTQ Extraction Agent：内容抽取
  | "er_research"      // ER Research Agent：错因/规则调研
  | "dream_profile"     // Dream/Profile Update Agent：长期画像最终更新
  | "diagnose"         // Teaching Agent：错因归因（DIAGNOSE，§8.3）
  | "session_decision"; // Teaching Agent：会话结束目标判定（§10.1）

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
}

export type TaskResult =
  | {
      readonly ok: true;
      readonly outputJson?: unknown;
      readonly outputText?: string;
      readonly implementation?: string;
      /** 任务策略版本（policies/tasks.manifest.json 单一来源；写入血缘/审计字段） */
      readonly promptVersion?: string;
    }
  | { readonly ok: false; readonly status: number; readonly error: string; readonly detail?: string };

/** undici 默认 headersTimeout=300s 会先于业务超时断开长生成（推理模型判答可达数分钟） */
const longAgent = new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000, connectTimeout: 30_000 });

function fetchLong(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return undiciFetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    dispatcher: longAgent,
  } as Parameters<typeof undiciFetch>[1]);
}

export function createAgentRuntimeClient(cfg: AgentRuntimeClientConfig): {
  runTask(opts: TaskRunOptions): Promise<TaskResult>;
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
          }),
        },
        timeoutMs,
      );
      const d = (await res.json()) as {
        ok?: boolean;
        value?: { outputText?: string; outputJson?: unknown };
        trace?: { implementation?: string; promptVersion?: string };
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
      };
    } catch {
      return { ok: false, status: 502, error: "agent_runtime_unreachable" };
    }
  }

  return { runTask };
}
