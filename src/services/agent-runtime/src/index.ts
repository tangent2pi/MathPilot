/**
 * agent-runtime：Pi Agent Harness 宿主（设计 §4.3，架构修订 v4）。
 *
 * - 提供商：pi-ai 原生注册（providers.ts：createProvider + openAICompletionsApi
 *   + envApiKeyAuth，scnet OpenAI 兼容端点；Qwen3.8-Max 主 / DeepSeek-V4-Flash-0731 辅
 *   是配置实例，架构修订 v4 §1）；
 * - 运行时：pi-agent-core Agent 原生承担 agent loop/流式/工具执行/transcript；
 *   会话生命周期、respond 结构化输出、工作区文件系统、租户绑定由运行时插件
 *   （runtime.ts）统一管理——领域服务只有一次 POST /runtime/tasks 调用；
 * - 模型身份与动作：policies/（pi Skills 目录）经 skills.ts 编译，manifest
 *   单一管理 prompt_version 与主/辅模型角色；Agent 循环内零动作限制；
 * - 多用户隔离（设计 §15.2）：任务创建绑定租户头，本服务是模型凭据唯一持有者。
 */
import { createModels } from "@earendil-works/pi-ai";
import { startService, newId } from "./lib.ts";
import { buildScnetProvider, type ProviderConfig } from "./providers.ts";
import { runTask, type TaskRunOptions } from "./runtime.ts";
import type { TaskType } from "./skills.ts";

// 模型供应商配置实例（架构修订 v4 §1：Qwen3.8-Max / DeepSeek-V4-Flash-0731 只是配置，不是架构名称）
const providerConfig: ProviderConfig = {
  baseUrl: process.env.MODEL_API_BASE ?? "https://api.scnet.cn/api/llm/v1",
  mainModelId: process.env.MODEL_ID_MAIN ?? "Qwen3.8-Max",
  auxModelId: process.env.MODEL_ID_AUX ?? "DeepSeek-V4-Flash-0731",
};
const MODEL_API_KEY = process.env.MODEL_API_KEY ?? "";

const models = createModels();
models.setProvider(buildScnetProvider(providerConfig));

const VALID_TASK_TYPES = new Set<TaskType>([
  "teach_grade", "teach_summary", "ktq_extract", "er_research", "dream_profile", "diagnose", "session_decision",
]);

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
      runtime: "AGMATH runtime plugin（runTask 单调用；会话生命周期在宿主内）",
      skills: "policies/（pi Skills 目录，manifest 管理 prompt_version 与模型角色）",
      providers: `scnet (pi-ai openAI-completions): ${providerConfig.mainModelId} 主 / ${providerConfig.auxModelId} 辅`,
      modelKeyConfigured: MODEL_API_KEY.length > 0,
      tools: ["respond"],
    }));

    /** 单任务运行：编译提示 + 工作区 + Agent 原生运行 + respond 输出（租户绑定） */
    app.post("/runtime/tasks", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const body = req.body as {
        task_type?: string; session_ref?: string; context?: TaskRunOptions["context"]; prompt_text?: string;
      };
      const taskType = body.task_type as TaskType;
      if (!taskType || !VALID_TASK_TYPES.has(taskType)) {
        return reply.code(422).send({ error: `unknown task_type: ${body.task_type}` });
      }
      if (!body.session_ref) return reply.code(422).send({ error: "session_ref required" });

      const started = Date.now();
      const result = await runTask(models, {
        main: providerConfig.mainModelId,
        aux: providerConfig.auxModelId,
      }, {
        taskType,
        sessionRef: body.session_ref,
        tenantId,
        context: body.context ?? {},
        ...(body.prompt_text !== undefined ? { promptText: body.prompt_text } : {}),
      });

      if (!result.ok) {
        return reply.code(502).send({ ok: false, error: { kind: "fatal", code: result.error, message: result.detail ?? "" } });
      }
      return {
        ok: true,
        value: {
          ...(result.outputText !== undefined ? { outputText: result.outputText } : {}),
          ...(result.outputJson !== undefined ? { outputJson: result.outputJson } : {}),
        },
        trace: {
          traceId: newId("ptr"),
          providerKind: "model",
          implementation: result.implementation,
          operation: "run_task",
          promptVersion: result.promptVersion,
          latencyMs: Date.now() - started,
          fallbackChain: [],
        },
      };
    });
  },
});
