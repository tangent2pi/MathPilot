import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sendProblem, type ProblemInput } from "@mathpilot/internal-service/fastify";
import type pg from "pg";
import type { Principal } from "./auth.ts";
import { LearningCommandService, commandErrorFromUnknown } from "./learning-command/service.ts";
import { reviseSelectionIntent, SelectionCommandError } from "./learning-selection.ts";
import { decodeCursor, encodeCursor, LearningReadError } from "./learning-read/cursor.ts";
import { LearningReadService } from "./learning-read/service.ts";
import { viewEtag } from "./learning-read/view.ts";

type PrincipalResolver = (request: FastifyRequest, reply: FastifyReply) => Promise<Principal | null>;

const query = (request: FastifyRequest): Record<string, unknown> =>
  request.query && typeof request.query === "object" ? request.query as Record<string, unknown> : {};
const params = (request: FastifyRequest): Record<string, string> => request.params as Record<string, string>;
const headerKey = (request: FastifyRequest): unknown => request.headers["idempotency-key"];

function sendView(request: FastifyRequest, reply: FastifyReply, view: Awaited<ReturnType<LearningReadService["overview"]>>) {
  const etag = viewEtag(view);
  reply.header("etag", etag).header("cache-control", "private, no-cache");
  if (request.headers["if-none-match"] === etag) return reply.code(304).send();
  return reply.send(view);
}

export function learningProblemFromError(error: unknown): ProblemInput | undefined {
  if (error instanceof SelectionCommandError) {
    return {
      title: error.publicTitle,
      status: error.status,
      code: error.code,
      ...(error.currentVersion === undefined ? {} : { current_version: error.currentVersion }),
    };
  }
  const known = commandErrorFromUnknown(error);
  if (known) {
    return {
      title: known.message,
      status: known.status,
      code: known.code,
      ...(known instanceof Error && "currentVersion" in known && typeof known.currentVersion === "number"
        ? { current_version: known.currentVersion } : {}),
    };
  }
  return undefined;
}

export function registerLearningHttp(
  app: FastifyInstance,
  pool: pg.Pool,
  principalOf: PrincipalResolver,
): void {
  const reads = new LearningReadService(pool);
  const commands = new LearningCommandService(pool);

  app.get("/api/learning/threads", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    return sendView(request, reply, await reads.listThreads(principal));
  });
  app.post("/api/learning/threads", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    const result = await commands.createThread(principal, request.body ?? {}, headerKey(request));
    return reply.code(result.created ? 201 : 200).send(result);
  });
  app.post("/api/learning/threads/:threadId/rename", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    return reply.send(await commands.renameThread(principal, params(request).threadId!, request.body, headerKey(request)));
  });
  app.post("/api/learning/threads/:threadId/archive", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    return reply.send(await commands.archiveThread(principal, params(request).threadId!, request.body, headerKey(request)));
  });
  app.get("/api/learning/threads/:threadId/messages", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    return sendView(request, reply, await reads.threadMessages(principal, params(request).threadId!, query(request).after));
  });
  app.post("/api/learning/threads/:threadId/messages", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    return sendProblem(reply, {
      status: 410,
      code: "interactive_pi_required",
      title: "Foreground messages must be submitted through the Pi session endpoint",
    });
  });
  app.get("/api/learning/threads/:threadId/context", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    return sendView(request, reply, await reads.threadContext(principal, params(request).threadId!));
  });
  app.post("/api/learning/threads/:threadId/intent-revisions", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    const body = request.body && typeof request.body === "object" && !Array.isArray(request.body)
      ? { ...(request.body as Record<string, unknown>), conversation_thread_id: params(request).threadId }
      : request.body;
    const result = await reviseSelectionIntent(pool, principal, body);
    return reply.code(result.created ? 202 : 200).send(result);
  });

  app.get("/api/learning/question-sessions/:questionSessionId", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    return sendView(request, reply, await reads.questionInteraction(principal, params(request).questionSessionId!));
  });
  app.post("/api/learning/question-sessions/:questionSessionId/attempts", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    const result = await commands.submitAttempt(principal, params(request).questionSessionId!, request.body, headerKey(request));
    return reply.code(result.created ? 201 : 200).send(result);
  });
  app.post("/api/learning/question-sessions/:questionSessionId/cut-requests", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    return reply.code(202).send(await commands.requestCut(principal, params(request).questionSessionId!, request.body, headerKey(request)));
  });

  app.get("/api/learning/me/overview", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    return sendView(request, reply, await reads.overview(principal));
  });
  app.get("/api/learning/me/history", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    return sendView(request, reply, await reads.history(principal, query(request).after, query(request).kind));
  });
  app.get("/api/learning/me/state", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    return sendView(request, reply, await reads.scientificState(principal, query(request).kind));
  });
  app.get("/api/learning/me/memories", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    return sendView(request, reply, await reads.memories(principal, query(request).after, query(request).status));
  });
  app.get("/api/learning/me/reviews", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    return sendView(request, reply, await reads.reviews(principal, query(request).after));
  });

  app.get("/api/learning/teacher/students", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    return sendView(request, reply, await reads.listTeacherStudents(principal));
  });
  app.get("/api/learning/students/:studentHandle/overview", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    return sendView(request, reply, await reads.overview(principal, params(request).studentHandle));
  });
  app.get("/api/learning/students/:studentHandle/history", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    return sendView(request, reply, await reads.history(principal, query(request).after, query(request).kind, params(request).studentHandle));
  });
  app.get("/api/learning/students/:studentHandle/state", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    return sendView(request, reply, await reads.scientificState(principal, query(request).kind, params(request).studentHandle));
  });
  app.get("/api/learning/students/:studentHandle/memories", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    return sendView(request, reply, await reads.memories(principal, query(request).after, query(request).status, params(request).studentHandle));
  });
  app.get("/api/learning/students/:studentHandle/reviews", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    return sendView(request, reply, await reads.reviews(principal, query(request).after, params(request).studentHandle));
  });

  app.get("/api/learning/evidence/:evidenceHandle", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    return sendView(request, reply, await reads.evidence(principal, params(request).evidenceHandle!));
  });
  app.post("/api/learning/judgments/:judgmentId/corrections", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    const result = await commands.teacherCorrectJudgment(
      principal,
      params(request).judgmentId!,
      request.body,
      headerKey(request),
    );
    return reply.code(result.created ? 202 : 200).send(result);
  });
  app.get("/api/learning/annotations/:annotationId", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    return sendView(request, reply, await reads.annotation(principal, params(request).annotationId!));
  });
  app.post("/api/learning/annotations/:annotationId/feedback", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    const result = await commands.annotationFeedback(principal, params(request).annotationId!, request.body, headerKey(request));
    return reply.code(result.created ? 201 : 200).send(result);
  });
  app.post("/api/learning/context-preferences", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    const result = await commands.setContextPreference(principal, request.body, headerKey(request));
    return reply.code(result.created ? 201 : 200).send(result);
  });
  app.get("/api/learning/activities/:activityId", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    return sendView(request, reply, await reads.activity(principal, params(request).activityId!));
  });
  app.get("/api/learning/operations/:operationId", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    return sendView(request, reply, await reads.operation(principal, params(request).operationId!));
  });
  app.post("/api/learning/operations/:operationId/cancel", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    return reply.send(await commands.cancelOperation(principal, params(request).operationId!, request.body, headerKey(request)));
  });

  app.post("/api/learning/reviews/:reviewRef/start", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    const body = request.body && typeof request.body === "object" && !Array.isArray(request.body)
      ? request.body as Record<string, unknown> : {};
    const rawKey = typeof headerKey(request) === "string" ? headerKey(request) as string : body.idempotency_key;
    if (typeof rawKey !== "string") throw new LearningReadError(422, "invalid_idempotency_key", "缺少有效的 Idempotency-Key");
    const at = typeof body.requested_at === "string" ? body.requested_at : new Date().toISOString();
    const created = await commands.createThread(principal, { idempotency_key: `${rawKey}:thread`, title: "复习安排" }, `${rawKey}:thread`);
    const result = await reviseSelectionIntent(pool, principal, {
      schema_version: 3,
      command_type: "revise_selection_intent",
      idempotency_key: `${rawKey}:intent`,
      expected_version: created.thread.version,
      requested_at: at,
      conversation_thread_id: created.thread.thread_id,
      natural_language_request: `请开始这项复习：${params(request).reviewRef}`,
    });
    return reply.code(202).send({ thread: created.thread, selection: result });
  });

  app.get("/api/learning/events", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    const supplied = query(request).after ?? request.headers["last-event-id"];
    let after = decodeCursor(supplied);
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reply.raw.write("retry: 1500\n\n");
    let closed = false;
    const close = () => { closed = true; };
    request.raw.once("close", close);
    try {
      while (!closed) {
        const events = await reads.accessibleClientEvents(principal, after);
        for (const event of events) {
          const cursor = encodeCursor(Number(event.cursor));
          reply.raw.write(`id: ${cursor}\nevent: ${event.event_type}\ndata: ${JSON.stringify({
            event_id: event.event_id,
            cursor,
            event_type: event.event_type,
            resource_key: event.resource_key,
            resource_version: Number(event.resource_version),
            occurred_at: new Date(event.occurred_at).toISOString(),
          })}\n\n`);
          after = Number(event.cursor);
        }
        if (!events.length) reply.raw.write(`: keepalive ${Date.now()}\n\n`);
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      }
    } catch {
      if (!closed) reply.raw.write("event: stream-error\ndata: {\"retryable\":true}\n\n");
    } finally {
      request.raw.removeListener("close", close);
      reply.raw.end();
    }
  });
}
