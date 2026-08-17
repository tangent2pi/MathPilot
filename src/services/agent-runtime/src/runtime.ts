/**
 * AGMATH 运行时插件（架构修订 v4 §2："一个插件管理运行时与状态"）。
 *
 * 任务会话生命周期、respond 结构化输出、工作区文件系统、租户绑定全部收进
 * 本模块；Agent 运行时（agent loop、流式、工具执行、transcript 状态）由
 * pi-agent-core 原生承担。领域服务（learning/content/profile）只见
 * 一次 runTask 调用，不接触会话句柄。
 *
 * 一任务一 Agent 一工作区：模型历史与文件不跨任务共享（设计 §4.1/§5.1）。
 */
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Models } from "@earendil-works/pi-ai";
import { newId } from "./lib.ts";
import { compileSystemPrompt, taskPromptVersion, taskRole, type TaskContext, type TaskType } from "./skills.ts";
import { createWorkspace, destroyWorkspace, WORKSPACE_MAP } from "./workspace.ts";

export interface TaskRunOptions {
  taskType: TaskType;
  /** 领域侧稳定引用（session_id / agent_run_id），用于审计关联 */
  sessionRef: string;
  tenantId: string;
  context: TaskContext;
  promptText?: string;
}

export interface TaskRunSuccess {
  ok: true;
  outputJson?: unknown;
  outputText?: string;
  implementation: string;
  promptVersion: string;
  latencyMs: number;
}

export type TaskRunResult = TaskRunSuccess | { ok: false; error: string; detail?: string };

/** respond 工具：最终结构化输出（输出契约由任务策略约定，领域服务层做语义校验） */
const respondTool: AgentTool = {
  name: "respond",
  label: "Respond",
  description: "输出最终结构化结果（唯一允许的最终动作）",
  parameters: Type.Object({ output: Type.Unknown() }),
  execute: async (_toolCallId, params) => ({
    content: [{ type: "text", text: "responded" }],
    details: (params as { output?: unknown }).output,
  }),
};

/** 从 Agent 会话中提取最后一次 respond 工具调用的输出（arguments.output；模型可能传 JSON 字符串） */
function extractRespondOutput(agent: Agent): unknown {
  let found: unknown;
  for (const msg of agent.state.messages) {
    if (msg.role !== "assistant") continue;
    for (const part of msg.content) {
      if (part.type !== "toolCall" || part.name !== "respond") continue;
      const raw = part.arguments.output;
      if (typeof raw === "string") {
        try { found = JSON.parse(raw); } catch { found = raw; }
      } else {
        found = raw;
      }
    }
  }
  return found;
}

function extractLastText(agent: Agent): string {
  return agent.state.messages
    .filter((m) => m.role === "assistant")
    .at(-1)
    ?.content
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("") ?? "";
}

/**
 * 执行一个任务 Session：编译提示（策略源 + 工作区）→ Agent 原生运行 → respond 输出
 * → 清理工作区。模型角色由策略 manifest 决定（主=教学，辅=内容生产线/画像异步更新）。
 */
export async function runTask(
  models: Models,
  modelIds: { main: string; aux: string },
  opts: TaskRunOptions,
): Promise<TaskRunResult> {
  const started = Date.now();
  const taskId = newId("tk");
  const role = taskRole(opts.taskType);
  const model = models.getModel("scnet", role === "aux" ? modelIds.aux : modelIds.main);
  if (!model) return { ok: false, error: "model_not_found", detail: `${role} model in scnet provider` };

  const agentsMd = compileSystemPrompt(opts.taskType, opts.context, WORKSPACE_MAP);
  const ws = await createWorkspace(opts.tenantId, taskId, {
    task_type: opts.taskType,
    session_ref: opts.sessionRef,
    context: opts.context,
  }, agentsMd);

  try {
    const agent = new Agent({
      initialState: {
        systemPrompt: agentsMd,
        model,
        tools: [respondTool],
      },
      streamFn: models.streamSimple.bind(models),
    });
    await agent.prompt(opts.promptText ?? "请按任务提示执行并输出最终结构化结果。");

    const outputJson = extractRespondOutput(agent);
    const outputText = extractLastText(agent);
    // 模型未产出任何结果（凭据缺失/配额/空响应）：显式失败，不返回空成功（架构修订 v4 §0.4）
    if (outputJson === undefined && outputText === "") {
      return {
        ok: false,
        error: agent.state.errorMessage ? "pi_run_failed" : "pi_run_empty",
        detail: agent.state.errorMessage ?? "模型未产出任何结果（检查凭据与配额）",
      };
    }
    return {
      ok: true,
      ...(outputJson !== undefined ? { outputJson } : {}),
      ...(outputText ? { outputText } : {}),
      implementation: "pi.scnet",
      promptVersion: taskPromptVersion(opts.taskType),
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return { ok: false, error: "pi_run_failed", detail: err instanceof Error ? err.message : String(err) };
  } finally {
    await destroyWorkspace(ws).catch(() => undefined);
  }
}
