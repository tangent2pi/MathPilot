import type { InternalActor, InternalServiceRuntime } from "@mathpilot/internal-service";
import { internalServiceContext } from "@mathpilot/internal-service/fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { CandidateRepository } from "./candidate-repository.ts";
import { newId, type Principal } from "./lib.ts";

// 教师对话透传层：content-next 是 pi-chat-runtime（content-to-pi 边）的唯一
// 合法调用方。api-next 通过 /api/content/* 中继到这里的 /teacher-chat/*，
// 再由这里转发到 pi-chat-runtime 的 /internal/teacher-chat/*。真正的会话与
// 多轮记忆落在 pi-chat-runtime（归属教师 owner_user_id，与学生证据隔离）。

const teacherChatForward = async (
  runtime: InternalServiceRuntime,
  actor: InternalActor,
  path: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> => {
  const includesBody = request.body !== undefined && !["GET", "HEAD"].includes(request.method);
  const response = await runtime.request("content-to-pi", actor, path, {
    method: request.method,
    ...(includesBody ? { json: request.body } : {}),
    timeoutMs: 600_000,
  });
  const contentType = response.headers.get("content-type");
  if (contentType) reply.header("content-type", contentType);
  return reply.code(response.status).send(Buffer.from(await response.arrayBuffer()));
};

export function registerTeacherChatRoutes(
  server: FastifyInstance,
  repository: CandidateRepository,
  runtime: InternalServiceRuntime,
  fromApi: preHandlerHookHandler,
): void {
  const requireTeacher = (request: FastifyRequest): InternalActor | null => {
    const actor: InternalActor = internalServiceContext(request).actor;
    return actor.roles.includes("teacher") ? actor : null;
  };

  // 教师上传资料后调用：为本教师对话线程创建一次 KTQ 抽取派发命令，轮询器随后
  // 经 content-to-pi 调 /internal/ktq-start，材料即该线程 input/original 中的附件。
  server.post("/teacher-chat/threads/:threadId/ktq-start", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reply.code(403).send({ error: "teacher principal required" });
    const threadId = String((request.params as { threadId: unknown }).threadId ?? "");
    if (!threadId) return reply.code(422).send({ error: "thread_id is required" });
    const body = (request.body ?? {}) as { chapter_id?: unknown };
    const chapterId = typeof body.chapter_id === "string" && body.chapter_id.trim() ? body.chapter_id.trim().slice(0, 127) : null;
    try {
      const principal: Principal = { tenantId: actor.tenantId, userId: actor.userId, roles: [...actor.roles] };
      const created = await repository.createKtqStartCommand(principal, {
        commandId: newId("cmd"),
        targetThreadId: threadId,
        chapterId,
      });
      return reply.code(201).send(created);
    } catch (error) {
      request.log.error({ err: error, threadId }, "ktq start command creation failed");
      return reply.code(422).send({ error: "ktq_start_rejected", detail: error instanceof Error ? error.message : String(error) });
    }
  });

  server.get("/teacher-chat/threads", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reply.code(403).send({ error: "teacher principal required" });
    return teacherChatForward(runtime, actor, "/internal/teacher-chat/threads", request, reply);
  });

  server.post("/teacher-chat/threads", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reply.code(403).send({ error: "teacher principal required" });
    return teacherChatForward(runtime, actor, "/internal/teacher-chat/threads", request, reply);
  });

  server.post("/teacher-chat/threads/:threadId/messages", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reply.code(403).send({ error: "teacher principal required" });
    const threadId = String((request.params as { threadId: unknown }).threadId ?? "");
    return teacherChatForward(runtime, actor, `/internal/teacher-chat/threads/${encodeURIComponent(threadId)}/messages`, request, reply);
  });

  server.get("/teacher-chat/threads/:threadId", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reply.code(403).send({ error: "teacher principal required" });
    const threadId = String((request.params as { threadId: unknown }).threadId ?? "");
    return teacherChatForward(runtime, actor, `/internal/teacher-chat/threads/${encodeURIComponent(threadId)}`, request, reply);
  });

  // 解析任务状态：供对话内任务卡轮询。
  server.get("/teacher-chat/threads/:threadId/parse", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reply.code(403).send({ error: "teacher principal required" });
    const threadId = String((request.params as { threadId: unknown }).threadId ?? "");
    if (!threadId) return reply.code(422).send({ error: "thread_id is required" });
    try {
      const principal: Principal = { tenantId: actor.tenantId, userId: actor.userId, roles: [...actor.roles] };
      return await repository.teacherParseProgress(principal, threadId);
    } catch (error) {
      request.log.error({ err: error, threadId }, "teacher parse progress failed");
      return reply.code(422).send({ error: "parse_progress_failed", detail: error instanceof Error ? error.message : String(error) });
    }
  });
}