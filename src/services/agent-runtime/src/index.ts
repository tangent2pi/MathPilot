/**
 * agent-runtime：Pi Agent Harness 宿主（设计 §4.3）。
 *
 * 领域服务（learning/content/profile）只经本服务调用模型：
 * 每任务一个独立 Pi Agent Session（systemPrompt = 按任务编译的 AGENTS.md，
 * 模型 = pi-ai（scnet provider），工具 = respond 结构化输出）。
 * 一题一 Session / 一任务一 Session：模型历史不跨任务共享（设计 §4.1 角色隔离）。
 *
 * Pi 本体只通过 SDK 的扩展机制使用（pi-ai createProvider 接入 scnet 模型端点、
 * pi-agent-core Agent 配置注入任务提示/工具），不修改 pi 源码（Review-001）。
 *
 * 多用户隔离（设计 §15.2）：Session 创建时绑定租户，prompt/查询/销毁必须携带
 * 相同租户头，跨租户访问一律 403；Session 只存在内存且随任务结束销毁。
 *
 * 密钥不落本服务以外的进程：模型供应商凭据直接读取本服务环境变量。
 */
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createModels, Type } from "@earendil-works/pi-ai";
import { startService, newId } from "./lib.ts";
import { buildScnetProvider, type ScnetConfig } from "./scnet-provider.ts";
import { compileTaskPrompt, taskRole, taskPromptVersion, type TaskType, type TaskContext } from "./tasks.ts";

// 模型供应商配置实例（设计 §1.2.2：Qwen3.8-Max / DeepSeek-V4-Flash-0731 只是配置，不是架构名称）
const MODEL_API_BASE = process.env.MODEL_API_BASE ?? "https://api.scnet.cn/api/llm/v1";
const MODEL_API_KEY = process.env.MODEL_API_KEY ?? "";
const MODEL_ID_MAIN = process.env.MODEL_ID_MAIN ?? "Qwen3.8-Max";
const MODEL_ID_AUX = process.env.MODEL_ID_AUX ?? "DeepSeek-V4-Flash-0731";

const scnetConfig: ScnetConfig = {
  baseUrl: MODEL_API_BASE,
  apiKey: MODEL_API_KEY,
  mainModelId: MODEL_ID_MAIN,
  auxModelId: MODEL_ID_AUX,
};

interface AgentSession {
  taskType: TaskType;
  sessionRef: string;
  tenantId: string;
  createdAt: string;
  turns: number;
  piAgent: Agent;
}
const sessions = new Map<string, AgentSession>();

/** respond 工具：最终结构化输出（参数形状由任务提示约定，领域服务层做语义校验） */
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

function tenantOf(req: { headers: Record<string, unknown> }): string | null {
  const t = req.headers["x-tenant-id"];
  return typeof t === "string" && t.length > 0 ? t : null;
}

startService({
  name: "agent-runtime",
  port: Number(process.env.PORT ?? 3005),
  register(app) {
    app.get("/capabilities", async () => ({
      harness: "pi-agent-core@0.83.0",
      sessionIsolation: "per-task-session + tenant-bound",
      tools: ["respond"],
      modelProvider: `scnet (pi-ai openai-completions): ${MODEL_ID_MAIN} 主 / ${MODEL_ID_AUX} 辅`,
    }));

    /** 创建任务 Session（独立 Agent，独立 systemPrompt/模型/工具；绑定租户） */
    app.post("/runtime/sessions", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const body = req.body as {
        task_type?: string; session_ref?: string; context?: TaskContext;
      };
      const taskType = body.task_type as TaskType;
      if (!["teach_grade", "teach_summary", "ktq_extract", "er_research", "dream_profile"].includes(taskType)) {
        return reply.code(422).send({ error: `unknown task_type: ${body.task_type}` });
      }
      const sessionId = newId("ag");

      try {
        const models = createModels();
        models.setProvider(buildScnetProvider(scnetConfig));
        // 模型角色由策略 manifest 单一来源（主=教学，辅=内容生产线/画像异步更新）
        const role = taskRole(taskType);
        const model = models.getModel("scnet", role === "aux" ? scnetConfig.auxModelId : scnetConfig.mainModelId);
        if (!model) throw new Error("model not found in scnet provider");
        const agent = new Agent({
          initialState: {
            systemPrompt: compileTaskPrompt(taskType, body.context ?? {}),
            model,
            tools: [respondTool],
          },
          streamFn: models.streamSimple.bind(models),
        });
        sessions.set(sessionId, {
          taskType,
          sessionRef: body.session_ref ?? "",
          tenantId,
          createdAt: new Date().toISOString(),
          turns: 0,
          piAgent: agent,
        });
      } catch (err) {
        return reply.code(502).send({
          error: "pi_session_create_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      return reply.code(201).send({ session_id: sessionId, task_type: taskType });
    });

    /** 向 Session 发提示；返回 respond 结构化输出 + 文本（租户必须与创建时一致） */
    app.post("/runtime/sessions/:id/prompt", async (req, reply) => {
      const { id } = req.params as { id: string };
      const rec = sessions.get(id);
      if (!rec) return reply.code(404).send({ error: "session not found" });
      if (tenantOf(req) !== rec.tenantId) return reply.code(403).send({ error: "session_tenant_mismatch" });
      const { text } = req.body as { text?: string };
      if (typeof text !== "string" || text.length === 0) {
        return reply.code(422).send({ error: "text required" });
      }
      rec.turns += 1;
      const started = Date.now();

      try {
        await rec.piAgent.prompt(text);
        const outputJson = extractRespondOutput(rec.piAgent);
        const lastText = rec.piAgent.state.messages
          .filter((m) => m.role === "assistant")
          .at(-1)
          ?.content
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("") ?? "";
        return {
          ok: true,
          value: {
            outputText: lastText,
            ...(outputJson !== undefined ? { outputJson } : {}),
          },
          trace: {
            traceId: newId("ptr"),
            providerKind: "model",
            implementation: "pi.scnet",
            operation: "prompt",
            promptVersion: taskPromptVersion(rec.taskType),
            latencyMs: Date.now() - started,
            fallbackChain: [],
          },
        };
      } catch (err) {
        return reply.code(502).send({
          ok: false,
          error: { kind: "fatal", code: "pi_prompt_failed", message: err instanceof Error ? err.message : String(err) },
        });
      }
    });

    /** Session 状态（审计/调试；租户必须匹配） */
    app.get("/runtime/sessions/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const rec = sessions.get(id);
      if (!rec) return reply.code(404).send({ error: "session not found" });
      if (tenantOf(req) !== rec.tenantId) return reply.code(403).send({ error: "session_tenant_mismatch" });
      return {
        session_id: id,
        task_type: rec.taskType,
        session_ref: rec.sessionRef,
        tenant_id: rec.tenantId,
        created_at: rec.createdAt,
        turns: rec.turns,
      };
    });

    /** 销毁 Session（模型历史不跨题共享；租户必须匹配） */
    app.delete("/runtime/sessions/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const rec = sessions.get(id);
      if (!rec) return reply.code(404).send({ error: "session not found" });
      if (tenantOf(req) !== rec.tenantId) return reply.code(403).send({ error: "session_tenant_mismatch" });
      rec.piAgent.abort();
      sessions.delete(id);
      return { ok: true };
    });
  },
});
