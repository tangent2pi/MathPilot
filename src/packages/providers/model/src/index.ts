/**
 * @agmath/providers-model — ModelProvider 的宿主侧实现（设计 §2.4 packages/providers/model）。
 *
 * 领域服务不直连任何模型供应商（ADR-001、设计 §4.2）：模型调用统一经
 * agent-runtime（Pi Agent Harness 宿主）。本客户端封装 agent-runtime 的
 * "一任务一 Session"协议（create → prompt → delete）：每个任务都是独立
 * Pi Agent Session，模型历史不跨任务共享（设计 §4.1 角色隔离）。
 * 任务提示（AGENTS.md 编译、Skills 注入）在 agent-runtime 侧完成——Pi 本体
 * 只通过 SDK 的扩展机制（Provider/Agent 配置）使用，不修改其源码。
 *
 * 具体模型 ID 是 agent-runtime 的配置实例，不得出现在领域类型名中（设计 §1.2.2）。
 */
import { Agent, fetch as undiciFetch } from "undici";

export type TaskType =
  | "teach_grade"      // Teaching Agent：模型主判答
  | "teach_summary"    // Teaching Agent：教学总结（双产物之一）
  | "ktq_extract"      // KTQ Extraction Agent：内容抽取
  | "er_research"      // ER Research Agent：错因/规则调研
  | "dream_profile";   // Dream/Profile Update Agent：长期画像最终更新

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
  /** 租户隔离：agent-runtime 会话绑定该租户，后续调用必须匹配（设计 §15.2） */
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

  async function runTask(opts: TaskRunOptions): Promise<TaskResult> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.tenantId) headers["x-tenant-id"] = opts.tenantId;
    try {
      const createRes = await fetchLong(
        `${base}/runtime/sessions`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            task_type: opts.taskType,
            session_ref: opts.sessionRef,
            context: opts.context,
          }),
        },
        30_000,
      );
      const created = (await createRes.json()) as { session_id?: string; error?: string; detail?: string };
      if (!createRes.ok || !created.session_id) {
        return {
          ok: false,
          status: createRes.status,
          error: created.error ?? "agent_session_create_failed",
          ...(created.detail !== undefined ? { detail: created.detail } : {}),
        };
      }

      const promptRes = await fetchLong(
        `${base}/runtime/sessions/${encodeURIComponent(created.session_id)}/prompt`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ text: opts.promptText ?? "请按任务提示执行并输出最终结构化结果。" }),
        },
        timeoutMs,
      );
      const prompted = (await promptRes.json()) as {
        ok?: boolean;
        value?: { outputText?: string; outputJson?: unknown };
        trace?: { implementation?: string; promptVersion?: string };
        error?: { code?: string; message?: string };
      };
      // 模型历史不跨任务共享：无论成败都销毁 Session；销毁失败不阻塞结果
      await fetchLong(`${base}/runtime/sessions/${encodeURIComponent(created.session_id)}`, {
        method: "DELETE",
        headers,
      }, 10_000).catch(() => undefined);

      if (!promptRes.ok || !prompted.ok) {
        return {
          ok: false,
          status: promptRes.status,
          error: prompted.error?.code ?? "agent_prompt_failed",
          ...(prompted.error?.message !== undefined ? { detail: prompted.error.message } : {}),
        };
      }
      return {
        ok: true,
        ...(prompted.value?.outputJson !== undefined ? { outputJson: prompted.value.outputJson } : {}),
        ...(prompted.value?.outputText !== undefined ? { outputText: prompted.value.outputText } : {}),
        ...(prompted.trace?.implementation ? { implementation: prompted.trace.implementation } : {}),
        ...(prompted.trace?.promptVersion ? { promptVersion: prompted.trace.promptVersion } : {}),
      };
    } catch {
      return { ok: false, status: 502, error: "agent_runtime_unreachable" };
    }
  }

  return { runTask };
}
