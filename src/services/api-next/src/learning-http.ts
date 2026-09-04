import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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

function problem(reply: FastifyReply, error: unknown) {
  if (error instanceof SelectionCommandError) {
    return reply.code(error.status).type("application/problem+json").send({
      type: "https://mathpilot.dev/problems/selection-command",
      title: error.message,
      status: error.status,
      code: error.status === 409 ? "selection_conflict" : "invalid_selection_command",
    });
  }
  const known = commandErrorFromUnknown(error);
  if (known) {
    return reply.code(known.status).type("application/problem+json").send({
      type: `https://mathpilot.dev/problems/${known.code}`,
      title: known.message,
      status: known.status,
      code: known.code,
      ...(known instanceof Error && "currentVersion" in known && typeof known.currentVersion === "number"
        ? { current_version: known.currentVersion } : {}),
    });
  }
  throw error;
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
    try { return sendView(request, reply, await reads.listThreads(principal)); } catch (error) { return problem(reply, error); }
  });
  app.post("/api/learning/threads", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try {
      const result = await commands.createThread(principal, request.body ?? {}, headerKey(request));
      return reply.code(result.created ? 201 : 200).send(result);
    } catch (error) { return problem(reply, error); }
  });
  app.post("/api/learning/threads/:threadId/rename", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try { return reply.send(await commands.renameThread(principal, params(request).threadId!, request.body, headerKey(request))); }
    catch (error) { return problem(reply, error); }
  });
  app.post("/api/learning/threads/:threadId/archive", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try { return reply.send(await commands.archiveThread(principal, params(request).threadId!, request.body, headerKey(request))); }
    catch (error) { return problem(reply, error); }
  });
  app.post("/api/learning/threads/:threadId/delete", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try { return reply.send(await commands.deleteThread(principal, params(request).threadId!, request.body, headerKey(request))); }
    catch (error) { return problem(reply, error); }
  });
  app.get("/api/learning/threads/:threadId/messages", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try { return sendView(request, reply, await reads.threadMessages(principal, params(request).threadId!, query(request).after)); }
    catch (error) { return problem(reply, error); }
  });
  app.post("/api/learning/threads/:threadId/messages", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try {
      const result = await commands.submitForegroundMessage(principal, params(request).threadId!, request.body, headerKey(request));
      return reply.code(result.created ? 202 : 200).send(result);
    } catch (error) { return problem(reply, error); }
  });
  app.get("/api/learning/threads/:threadId/context", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try { return sendView(request, reply, await reads.threadContext(principal, params(request).threadId!)); }
    catch (error) { return problem(reply, error); }
  });
  app.post("/api/learning/threads/:threadId/intent-revisions", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try {
      const body = request.body && typeof request.body === "object" && !Array.isArray(request.body)
        ? { ...(request.body as Record<string, unknown>), conversation_thread_id: params(request).threadId }
        : request.body;
      const result = await reviseSelectionIntent(pool, principal, body);
      return reply.code(result.created ? 202 : 200).send(result);
    } catch (error) { return problem(reply, error); }
  });

  app.get("/api/learning/question-sessions/:questionSessionId", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try { return sendView(request, reply, await reads.questionInteraction(principal, params(request).questionSessionId!)); }
    catch (error) { return problem(reply, error); }
  });
  app.post("/api/learning/question-sessions/:questionSessionId/attempts", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try {
      const result = await commands.submitAttempt(principal, params(request).questionSessionId!, request.body, headerKey(request));
      return reply.code(result.created ? 201 : 200).send(result);
    } catch (error) { return problem(reply, error); }
  });
  app.post("/api/learning/question-sessions/:questionSessionId/cut-requests", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try { return reply.code(202).send(await commands.requestCut(principal, params(request).questionSessionId!, request.body, headerKey(request))); }
    catch (error) { return problem(reply, error); }
  });

  app.get("/api/learning/me/overview", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try { return sendView(request, reply, await reads.overview(principal)); } catch (error) { return problem(reply, error); }
  });
  app.get("/api/learning/me/history", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try { return sendView(request, reply, await reads.history(principal, query(request).after, query(request).kind)); }
    catch (error) { return problem(reply, error); }
  });
  app.get("/api/learning/me/state", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try { return sendView(request, reply, await reads.scientificState(principal, query(request).kind)); }
    catch (error) { return problem(reply, error); }
  });
  app.get("/api/learning/me/memories", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try { return sendView(request, reply, await reads.memories(principal, query(request).after, query(request).status)); }
    catch (error) { return problem(reply, error); }
  });
  app.get("/api/learning/me/reviews", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try { return sendView(request, reply, await reads.reviews(principal, query(request).after)); }
    catch (error) { return problem(reply, error); }
  });

  app.get("/api/learning/teacher/students", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try { return sendView(request, reply, await reads.listTeacherStudents(principal)); }
    catch (error) { return problem(reply, error); }
  });
  app.get("/api/learning/students/:studentHandle/overview", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try { return sendView(request, reply, await reads.overview(principal, params(request).studentHandle)); }
    catch (error) { return problem(reply, error); }
  });
  app.get("/api/learning/students/:studentHandle/history", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try { return sendView(request, reply, await reads.history(principal, query(request).after, query(request).kind, params(request).studentHandle)); }
    catch (error) { return problem(reply, error); }
  });
  app.get("/api/learning/students/:studentHandle/state", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try { return sendView(request, reply, await reads.scientificState(principal, query(request).kind, params(request).studentHandle)); }
    catch (error) { return problem(reply, error); }
  });
  app.get("/api/learning/students/:studentHandle/memories", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try { return sendView(request, reply, await reads.memories(principal, query(request).after, query(request).status, params(request).studentHandle)); }
    catch (error) { return problem(reply, error); }
  });
  app.get("/api/learning/students/:studentHandle/reviews", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try { return sendView(request, reply, await reads.reviews(principal, query(request).after, params(request).studentHandle)); }
    catch (error) { return problem(reply, error); }
  });

  app.get("/api/learning/evidence/:evidenceHandle", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try { return sendView(request, reply, await reads.evidence(principal, params(request).evidenceHandle!)); }
    catch (error) { return problem(reply, error); }
  });
  app.post("/api/learning/judgments/:judgmentId/corrections", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try {
      const result = await commands.teacherCorrectJudgment(
        principal,
        params(request).judgmentId!,
        request.body,
        headerKey(request),
      );
      return reply.code(result.created ? 202 : 200).send(result);
    } catch (error) { return problem(reply, error); }
  });
  app.get("/api/learning/annotations/:annotationId", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try { return sendView(request, reply, await reads.annotation(principal, params(request).annotationId!)); }
    catch (error) { return problem(reply, error); }
  });
  app.post("/api/learning/annotations/:annotationId/feedback", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try {
      const result = await commands.annotationFeedback(principal, params(request).annotationId!, request.body, headerKey(request));
      return reply.code(result.created ? 201 : 200).send(result);
    } catch (error) { return problem(reply, error); }
  });
  app.post("/api/learning/context-preferences", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try {
      const result = await commands.setContextPreference(principal, request.body, headerKey(request));
      return reply.code(result.created ? 201 : 200).send(result);
    } catch (error) { return problem(reply, error); }
  });
  app.get("/api/learning/activities/:activityId", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try { return sendView(request, reply, await reads.activity(principal, params(request).activityId!)); }
    catch (error) { return problem(reply, error); }
  });
  app.get("/api/learning/operations/:operationId", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try { return sendView(request, reply, await reads.operation(principal, params(request).operationId!)); }
    catch (error) { return problem(reply, error); }
  });
  app.post("/api/learning/operations/:operationId/cancel", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try { return reply.send(await commands.cancelOperation(principal, params(request).operationId!, request.body, headerKey(request))); }
    catch (error) { return problem(reply, error); }
  });

  app.post("/api/learning/reviews/:reviewRef/start", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try {
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
    } catch (error) { return problem(reply, error); }
  });

  app.get("/api/learning/events", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    let after: number;
    try {
      const supplied = query(request).after ?? request.headers["last-event-id"];
      after = decodeCursor(supplied);
    } catch (error) { return problem(reply, error); }
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
      let deltaAfter = 0n;
      let pollCount = 0;
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
        // 前台教学流式展示投影：增量只做展示，权威消息到达后的刷新兜底。
        const deltas = await reads.accessibleForegroundDeltas(principal, Number(deltaAfter));
        for (const delta of deltas) {
          reply.raw.write(`event: foreground.delta\ndata: ${JSON.stringify({
            cursor: delta.cursor,
            operation_id: delta.operation_id,
            sequence: Number(delta.sequence),
            kind: delta.kind,
            delta: delta.delta,
          })}\n\n`);
          const value = BigInt(delta.cursor);
          if (value > deltaAfter) deltaAfter = value;
        }
        pollCount += 1;
        if (pollCount % 60 === 0) {
          await reads.purgeExpiredForegroundDeltas().catch(() => undefined);
        }
        if (!events.length && !deltas.length) reply.raw.write(`: keepalive ${Date.now()}\n\n`);
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
