/**
 * agent-runtime：Pi Agent Harness 宿主（设计 §4.3，架构修订 v4）。
 *
 * - 提供商：pi-ai 原生注册（providers.ts：createProvider + openAICompletionsApi
 *   + envApiKeyAuth，scnet OpenAI 兼容端点；Qwen3.8-Max 主 / DeepSeek-V4-Flash-0731 辅
 *   是配置实例，架构修订 v4 §1）；
 * - 运行时：pi-agent-core Agent 原生承担 agent loop/流式/工具执行/transcript；
 *   会话生命周期、respond 结构化输出、工作区文件系统、租户绑定由运行时插件
 *   （runtime.ts）统一管理——领域服务只有一次 POST /runtime/tasks 调用；
 * - 模型任务目标：policies/ 经 skills.ts 编译为当前工作区 AGENTS.md；
 *   可发现能力由标准 Skill 目录经 Pi ResourceLoader 加载，二者职责分离。manifest
 *   单一管理 prompt_version 与主/辅模型角色；Agent 循环内零动作限制；
 * - 多用户隔离（设计 §15.2）：任务创建绑定租户头，本服务是模型凭据唯一持有者。
 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { startService, newId } from "./lib.ts";
import { buildScnetProvider, type ProviderConfig } from "./providers.ts";
import { cancelActiveSession, queueActiveSessionMessage, recoverLegacyKtqResult, runTask, type TaskRunOptions } from "./runtime.ts";
import type { TaskType } from "./skills.ts";
import {
  appendWorkspaceEvent,
  compactExpiredFailedWorkspaces,
  readWorkspaceEvents,
  workspacePath,
  type WorkspaceInlineFile,
  type WorkspaceInput,
  type WorkspaceSessionEvidence,
  type WorkspaceLifecycle,
} from "./workspace.ts";
import { readPublishedArtifact } from "./artifact-publisher.ts";

// 模型供应商配置实例（架构修订 v4 §1：Qwen3.8-Max / DeepSeek-V4-Flash-0731 只是配置，不是架构名称）
const providerConfig: ProviderConfig = {
  baseUrl: process.env.MODEL_API_BASE ?? "https://api.scnet.cn/api/llm/v1",
  mainModelId: process.env.MODEL_ID_MAIN ?? "Qwen3.8-Max",
  auxModelId: process.env.MODEL_ID_AUX ?? "DeepSeek-V4-Flash-0731",
};
const MODEL_API_KEY = process.env.MODEL_API_KEY ?? "";

const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
modelRuntime.registerNativeProvider(buildScnetProvider(providerConfig));
if (MODEL_API_KEY) await modelRuntime.setRuntimeApiKey("scnet", MODEL_API_KEY);

const VALID_TASK_TYPES = new Set<TaskType>([
  "teach_grade", "teach_interact", "teach_summary", "continuity_summary", "ktq_extract", "er_research", "dream_profile", "diagnose", "session_decision", "plan",
]);

function tenantOf(req: { headers: Record<string, unknown> }): string | null {
  const t = req.headers["x-tenant-id"];
  return typeof t === "string" && t.length > 0 ? t : null;
}

startService({
  name: "agent-runtime",
  port: Number(process.env.PORT ?? 3005),
  register(app) {
    app.addHook("onReady", async () => {
      await compactExpiredFailedWorkspaces();
      const timer = setInterval(() => void compactExpiredFailedWorkspaces().catch(() => undefined), 60 * 60 * 1000);
      timer.unref();
    });
    app.get("/capabilities", async () => ({
      harness: "pi-coding-agent@0.84.1",
      runtime: "MathPilot runtime plugin（持久 Session；同 session_ref 多轮续接）",
      skills: "标准 Skill 树（SKILL.md + agents/openai.yaml + assets 模板 + scripts 验证器）；任务 policy 只选择目标与模型角色",
      providers: `scnet (pi-ai openAI-completions): ${providerConfig.mainModelId} 主 / ${providerConfig.auxModelId} 辅`,
      modelKeyConfigured: MODEL_API_KEY.length > 0,
      tools: {
        allTasks: ["bash", "respond", "read_image", "read_video", "media_info", "visualize", "crop", "draw_bbox", "save_view", "paddleocr_vl", "web_search", "web_extractor", "image_search"],
        databaseAccess: "psql/Python through a no-network Unix socket; session_user-bound read-only role documented by database Skill",
        qwenDistribution: "Qwen-MM-Plugins local checkout dd029da3bcadfe497de4b4ca8976b11177997cf0; Core/Search MCP plus Core/Search/Edu Skills",
        qwenCoreImplementation: "Qwen-MM-Plugins/core local MCP inside per-workspace Bubblewrap",
        webSearchImplementation: "Qwen-MM-Plugins/search via pi-mcp-adapter@2.26.1",
      },
      teachingSkill: "Qwen-MM-Plugins/edu-agent full local asset tree + MathPilot teaching-artifact-adapter; Hyperframes 0.8.3 + system Chromium/ffmpeg; Qwen API/TTS disabled",
      artifacts: "mathpilot.learning-artifact/v1 validated immutable copy; authenticated sandboxed rendering",
      bashSandbox: "Bubblewrap: current workspace only; read-only root; output/tmp writable; PID/network isolated",
      sessionPersistence: "Pi JSONL + audited Session Capsule; completed terminal workspaces retain results/events/published artifacts and release input/tmp copies",
    }));

    /** 前端只读步骤时间线；私有思维内容在写入前已剔除。 */
    app.get("/runtime/sessions/:sessionRef/events", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { sessionRef } = req.params as { sessionRef: string };
      try {
        const raw = await readWorkspaceEvents(tenantId, sessionRef);
        const events = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line))
          .filter((event) => event.type !== "model_update");
        return { session_ref: sessionRef, events };
      } catch (err) {
        return reply.code(422).send({ error: "invalid_session_ref", detail: err instanceof Error ? err.message : String(err) });
      }
    });

    /** 运行中管理引导：消息在当前工具/模型回合结束后进入同一个 Pi Session。 */
    app.post("/runtime/sessions/:sessionRef/messages", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { sessionRef } = req.params as { sessionRef: string };
      const { message } = req.body as { message?: string };
      if (typeof message !== "string" || !message.trim() || message.length > 4_000) {
        return reply.code(422).send({ error: "message must be 1..4000 characters" });
      }
      const queued = queueActiveSessionMessage(tenantId, sessionRef, message.trim());
      if (!queued.queued) return reply.code(409).send({ error: "session_not_running", detail: "该 Session 已结束；内容结果请通过复核/重跑修订" });
      await appendWorkspaceEvent(tenantId, sessionRef, {
        seq: Date.now(), at: new Date().toISOString(), taskType: queued.taskType,
        type: "user_message", label: "教师引导", status: "completed", detail: message.trim(),
      });
      return reply.code(202).send({ session_ref: sessionRef, status: "queued", task_type: queued.taskType, position: queued.position });
    });

    /** 领域服务超时/失败时显式中止同一 Session，防止 HTTP 已失败但模型仍在后台运行。 */
    app.post("/runtime/sessions/:sessionRef/cancel", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { sessionRef } = req.params as { sessionRef: string };
      const body = (req.body ?? {}) as { reason?: string };
      const result = await cancelActiveSession(tenantId, sessionRef, body.reason?.slice(0, 500));
      if (!result.cancelled) return reply.code(409).send({ error: "session_not_running" });
      return reply.code(202).send({ session_ref: sessionRef, status: "cancelling", task_type: result.taskType });
    });

    app.post("/runtime/sessions/:sessionRef/recover-legacy-ktq", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { sessionRef } = req.params as { sessionRef: string };
      const { source_file: sourceFile = "tmp/final_output.json" } = req.body as { source_file?: string };
      try {
        const outputJson = await recoverLegacyKtqResult(tenantId, sessionRef, sourceFile);
        return { ok: true, outputJson, implementation: "pi-coding-agent.scnet.legacy-recovery", promptVersion: "ktq-extract@0.7.0" };
      } catch (err) {
        return reply.code(422).send({ error: "legacy_recovery_failed", detail: err instanceof Error ? err.message : String(err) });
      }
    });

    /** 已发布 Artifact 原始字节；只接受服务间租户头，公网由 API 再做会话归属校验。 */
    app.get("/runtime/sessions/:sessionRef/artifacts/:artifactId/*", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { sessionRef, artifactId, "*": file } = req.params as { sessionRef: string; artifactId: string; "*": string };
      try {
        const result = await readPublishedArtifact(workspacePath(tenantId, sessionRef), artifactId, file);
        if (!result) return reply.code(404).send({ error: "artifact not found" });
        const mime: Record<string, string> = {
          ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
          ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm",
          ".woff": "font/woff", ".woff2": "font/woff2",
        };
        reply.header("content-type", mime[result.extension] ?? "application/octet-stream");
        reply.header("cache-control", "private, max-age=31536000, immutable");
        if (result.extension === ".html") {
          reply.header("content-security-policy", "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; media-src 'self' data:; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
        }
        reply.header("x-content-type-options", "nosniff");
        return reply.send(result.bytes);
      } catch (err) {
        return reply.code(404).send({ error: "artifact not found", detail: err instanceof Error ? err.message : String(err) });
      }
    });

    /** 单任务运行：编译提示 + 工作区 + Agent 原生运行 + respond 输出（租户绑定） */
    app.post("/runtime/tasks", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const body = req.body as {
        task_type?: string; session_ref?: string; context?: TaskRunOptions["context"]; prompt_text?: string;
        input_artifacts?: WorkspaceInput[];
        workspace_files?: WorkspaceInlineFile[];
        session_evidence?: WorkspaceSessionEvidence[];
        prompt_images?: { data?: string; mimeType?: string }[];
        database_scope?: { actorId?: string; studentId?: string; sessionId?: string; questionIds?: string[] };
        workspace_lifecycle?: WorkspaceLifecycle;
      };
      const taskType = body.task_type as TaskType;
      if (!taskType || !VALID_TASK_TYPES.has(taskType)) {
        return reply.code(422).send({ error: `unknown task_type: ${body.task_type}` });
      }
      if (!body.session_ref) return reply.code(422).send({ error: "session_ref required" });
      if (body.workspace_lifecycle && !["continuing", "terminal"].includes(body.workspace_lifecycle)) {
        return reply.code(422).send({ error: "workspace_lifecycle must be continuing|terminal" });
      }

      const started = Date.now();
      const rawImages = body.prompt_images ?? [];
      if (!Array.isArray(rawImages) || rawImages.length > 4) return reply.code(422).send({ error: "at most 4 prompt images" });
      if (rawImages.some((image) => !image.data || image.data.length > 14_000_000 || !/^[A-Za-z0-9+/=\r\n]+$/.test(image.data)
        || !image.mimeType || !["image/png", "image/jpeg", "image/webp"].includes(image.mimeType))) {
        return reply.code(422).send({ error: "invalid prompt image" });
      }
      const promptImages = rawImages.map((image) => ({ type: "image" as const, data: image.data!, mimeType: image.mimeType! }));
      const workspaceFiles = body.workspace_files ?? [];
      if (!Array.isArray(workspaceFiles) || workspaceFiles.length > 16 || workspaceFiles.some((file) =>
        !file || typeof file.workspacePath !== "string" || typeof file.content !== "string" || file.content.length > 1_000_000)) {
        return reply.code(422).send({ error: "invalid workspace_files" });
      }
      const sessionEvidence = body.session_evidence ?? [];
      if (!Array.isArray(sessionEvidence) || sessionEvidence.length > 8 || sessionEvidence.some((item) =>
        !item || typeof item.sessionRef !== "string" || typeof item.sourcePath !== "string" || typeof item.workspacePath !== "string")) {
        return reply.code(422).send({ error: "invalid session_evidence" });
      }
      const result = await runTask(modelRuntime, {
        main: providerConfig.mainModelId,
        aux: providerConfig.auxModelId,
      }, {
        taskType,
        sessionRef: body.session_ref,
        tenantId,
        context: body.context ?? {},
        ...(body.prompt_text !== undefined ? { promptText: body.prompt_text } : {}),
        ...(body.input_artifacts !== undefined ? { inputArtifacts: body.input_artifacts } : {}),
        ...(workspaceFiles.length ? { workspaceFiles } : {}),
        ...(sessionEvidence.length ? { sessionEvidence } : {}),
        ...(promptImages.length ? { promptImages } : {}),
        ...(body.database_scope ? { databaseScope: body.database_scope } : {}),
        ...(body.workspace_lifecycle ? { workspaceLifecycle: body.workspace_lifecycle } : {}),
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
          piSessionId: result.sessionId,
          piSessionFile: result.sessionFile,
          stats: result.stats,
          eventCount: result.events.length,
          fallbackChain: [],
        },
      };
    });
  },
});
