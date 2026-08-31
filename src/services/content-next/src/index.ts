import type { FastifyRequest } from "fastify";
import { CandidateRepository, type CandidateInput } from "./candidate-repository.ts";
import {
  createPool,
  isTeacher,
  jsonObject,
  newId,
  principalFromHeaders,
  startService,
  stringValue,
  trustedRuntime,
  type Principal,
} from "./lib.ts";

const pool = createPool();
const repository = new CandidateRepository(pool);
const runtimeUrl = (process.env.PI_CHAT_RUNTIME_URL ?? "http://pi-chat-runtime:3105").replace(/\/$/, "");
const runtimeSecret = process.env.PI_GATEWAY_SECRET ?? process.env.CONTENT_NEXT_SECRET ?? "";
const hostCommandTimeoutMs = 10 * 60 * 1000;

function principal(request: FastifyRequest): Principal | null {
  return principalFromHeaders(request);
}

function requireTeacher(request: FastifyRequest): Principal | null {
  const value = principal(request);
  return value && isTeacher(value) ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function dispatchErCommands(log: { error: (data: unknown, message: string) => void }): Promise<void> {
  if (runtimeSecret.length < 32) return;
  const commands = await repository.pendingCommands().catch((error) => {
    log.error({ err: error }, "ER handoff polling failed");
    return [];
  });
  for (const command of commands) {
    try {
      const response = await fetch(`${runtimeUrl}/internal/er-start`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mathpilot-runtime-secret": runtimeSecret,
          "x-tenant-id": command.tenant_id,
          "x-user-id": command.owner_user_id,
          "x-user-roles": "teacher",
        },
        body: JSON.stringify({
          command_id: command.command_id,
          candidate_set_id: command.approved_ktq_candidate_set_id,
          target_thread_id: command.target_thread_id,
        }),
        signal: AbortSignal.timeout(hostCommandTimeoutMs),
      });
      if (!response.ok) throw new Error(`Pi runtime returned ${response.status}: ${await response.text()}`);
      await repository.markCommandDispatched(command.command_id, command.tenant_id, command.owner_user_id);
    } catch (error) {
      await repository.markCommandAttempt(command.command_id, command.tenant_id, command.owner_user_id, errorMessage(error)).catch((cause) => log.error({ err: cause, commandId: command.command_id }, "ER handoff attempt update failed"));
    }
  }
}

async function dispatchReviewFeedbackCommands(log: { error: (data: unknown, message: string) => void }): Promise<void> {
  if (runtimeSecret.length < 32) return;
  const commands = await repository.pendingFeedbackCommands().catch((error) => {
    log.error({ err: error }, "review feedback polling failed");
    return [];
  });
  for (const command of commands) {
    try {
      const response = await fetch(`${runtimeUrl}/internal/review-feedback`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mathpilot-runtime-secret": runtimeSecret,
          "x-tenant-id": command.tenant_id,
          "x-user-id": command.owner_user_id,
          "x-user-roles": "teacher",
        },
        body: JSON.stringify({
          command_id: command.command_id,
          candidate_set_id: command.candidate_set_id,
          target_thread_id: command.target_thread_id,
          phase: command.phase,
          annotations: command.annotations,
        }),
        signal: AbortSignal.timeout(hostCommandTimeoutMs),
      });
      if (!response.ok) throw new Error(`Pi runtime returned ${response.status}: ${await response.text()}`);
      await repository.markFeedbackDispatched(command.command_id, command.tenant_id, command.owner_user_id);
    } catch (error) {
      await repository.markFeedbackAttempt(command.command_id, command.tenant_id, command.owner_user_id, errorMessage(error))
        .catch((cause) => log.error({ err: cause, commandId: command.command_id }, "review feedback attempt update failed"));
    }
  }
}

const app = await startService({
  name: "content-next",
  port: Number(process.env.PORT ?? 3016),
  async register(server) {
    server.setErrorHandler((error, request, reply) => {
      request.log.error({ err: error }, "content-next request failed");
      return reply.code(500).send({ error: "content-next request failed" });
    });

    // Pi is the only caller allowed to register a validated result. The
    // gateway secret and principal headers are checked independently.
    server.post("/internal/candidates/register", async (request, reply) => {
      if (!trustedRuntime(request)) return reply.code(401).send({ error: "trusted runtime required" });
      const actor = requireTeacher(request);
      if (!actor) return reply.code(403).send({ error: "teacher principal required" });
      const body = jsonObject(request.body);
      const phase = body.phase === "ktq" || body.phase === "er" ? body.phase : null;
      const result = jsonObject(body.result);
      const threadId = stringValue(body.thread_id);
      const toolCallId = stringValue(body.tool_call_id);
      const resultSha256 = stringValue(body.result_sha256);
      const resultObjectId = stringValue(body.result_object_id);
      const receiptObjectId = stringValue(body.receipt_object_id);
      if (!phase || !threadId || !toolCallId || !resultSha256 || !resultObjectId || !receiptObjectId || !Object.keys(result).length) return reply.code(422).send({ error: "phase, thread_id, tool_call_id, result/receipt objects, result_sha256 and result are required" });
      const rawSourceObjects = body.source_objects === undefined ? [] : body.source_objects;
      if (!Array.isArray(rawSourceObjects) || rawSourceObjects.length > 64) return reply.code(422).send({ error: "source_objects must be a bounded array" });
      const sourceObjects = rawSourceObjects.map((value) => {
        const source = jsonObject(value);
        const workspacePath = stringValue(source.workspace_path);
        const objectId = stringValue(source.object_id);
        const versionId = stringValue(source.version_id);
        const sha256 = stringValue(source.sha256);
        return workspacePath && objectId && versionId && /^[0-9a-f]{64}$/.test(sha256)
          ? { workspacePath, objectId, versionId, sha256 }
          : null;
      });
      if (sourceObjects.some((value) => !value)) return reply.code(422).send({ error: "source_objects contains invalid metadata" });
      const input: CandidateInput = {
        phase,
        threadId,
        toolCallId,
        resultSha256,
        resultObjectId,
        receiptObjectId,
        sourceObjects: sourceObjects as CandidateInput["sourceObjects"],
        result,
        inputCandidateSetId: typeof body.input_candidate_set_id === "string" ? body.input_candidate_set_id : null,
        supersedesCandidateSetId: typeof body.supersedes_candidate_set_id === "string" ? body.supersedes_candidate_set_id : null,
        modelId: typeof body.model_id === "string" ? body.model_id : null,
        promptVersion: typeof body.prompt_version === "string" ? body.prompt_version : null,
      };
      try {
        const candidate = await repository.register(actor, input);
        return reply.code(201).send({ kind: "content_review", candidate, review_url: `/content/review/${encodeURIComponent(candidate.candidate_set_id)}` });
      } catch (error) {
        const message = errorMessage(error);
        request.log.warn({ err: error }, "candidate registration rejected");
        return reply.code(422).send({ error: "candidate_registration_rejected", detail: message });
      }
    });

    server.get("/agent/library/search", async (request, reply) => {
      if (!trustedRuntime(request)) return reply.code(401).send({ error: "trusted runtime required" });
      const actor = principal(request);
      if (!actor) return reply.code(400).send({ error: "missing principal headers" });
      const query = typeof (request.query as { query?: unknown }).query === "string" ? (request.query as { query: string }).query.trim() : "";
      const rawKinds = (request.query as { entity_kinds?: unknown }).entity_kinds;
      const kinds = rawKinds === undefined || rawKinds === "" ? undefined : (typeof rawKinds === "string" ? rawKinds.split(",") : Array.isArray(rawKinds) ? rawKinds : []).map(String) as Array<"knowledge" | "question_type" | "question" | "error_cause" | "diagnosis_rule">;
      const cursorValue = (request.query as { cursor?: unknown }).cursor;
      const limitValue = (request.query as { limit?: unknown }).limit;
      const offset = cursorValue === undefined || cursorValue === "" ? 0 : Number(cursorValue);
      const limit = limitValue === undefined || limitValue === "" ? 20 : Number(limitValue);
      if (query.length > 240 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) return reply.code(422).send({ error: "invalid query, cursor or limit" });
      try {
        const result = await repository.searchLibrary(actor, kinds, query, offset, limit);
        return { items: result.items, next_cursor: result.nextOffset === null ? null : String(result.nextOffset), query_fallback: result.queryFallback, transport: "normalized-content-library" };
      } catch (error) { return reply.code(422).send({ error: "library_search_failed", detail: errorMessage(error) }); }
    });

    server.get("/agent/library/get", async (request, reply) => {
      if (!trustedRuntime(request)) return reply.code(401).send({ error: "trusted runtime required" });
      const actor = principal(request);
      if (!actor) return reply.code(400).send({ error: "missing principal headers" });
      const query = request.query as { entity_ref?: unknown; package_ref?: unknown };
      const packageRef = stringValue(query.package_ref);
      if (packageRef) {
        const packageMatch = /^package:([A-Za-z0-9_.:-]{1,127})$/.exec(packageRef);
        if (!packageMatch) return reply.code(422).send({ error: "valid package_ref is required" });
        const value = await repository.getPackage(actor, packageMatch[1]!, isTeacher(actor));
        if (!value) return reply.code(404).send({ error: "package not found or not visible" });
        return { package: value, transport: "normalized-content-library" };
      }
      const ref = stringValue(query.entity_ref);
      const match = /^([a-z_]+):([A-Za-z0-9_.:-]{1,127})$/.exec(ref);
      const allowed = new Set(["knowledge", "question_type", "question", "error_cause", "diagnosis_rule"]);
      if (!match || !allowed.has(match[1]!)) return reply.code(422).send({ error: "entity_ref or package_ref is required" });
      const entity = await repository.getLibrary(actor, match[1] as "knowledge" | "question_type" | "question" | "error_cause" | "diagnosis_rule", match[2]!);
      if (!entity) return reply.code(404).send({ error: "entity not found or not visible" });
      return { entity, transport: "normalized-content-library" };
    });

    server.get("/candidates", async (request, reply) => {
      const actor = requireTeacher(request);
      if (!actor) return reply.code(403).send({ error: "teacher principal required" });
      const status = typeof (request.query as { status?: unknown }).status === "string" ? (request.query as { status: string }).status : undefined;
      return { candidates: await repository.list(actor, status) };
    });

    server.get("/candidates/:id", async (request, reply) => {
      const actor = requireTeacher(request);
      if (!actor) return reply.code(403).send({ error: "teacher principal required" });
      const id = (request.params as { id: string }).id;
      const value = await repository.get(actor, id);
      return value ? value : reply.code(404).send({ error: "candidate not found" });
    });

    server.get("/internal/candidates/:id/frozen", async (request, reply) => {
      if (!trustedRuntime(request)) return reply.code(401).send({ error: "trusted runtime required" });
      const actor = requireTeacher(request);
      if (!actor) return reply.code(403).send({ error: "teacher principal required" });
      const value = await repository.frozenKtq(actor, (request.params as { id: string }).id);
      return value ? value : reply.code(404).send({ error: "approved KTQ candidate not found" });
    });

    server.post("/candidates/:id/annotations", async (request, reply) => {
      const actor = requireTeacher(request);
      if (!actor) return reply.code(403).send({ error: "teacher principal required" });
      const body = jsonObject(request.body);
      const state = body.state === "draft" || body.state === "submitted" || body.state === "withdrawn" ? body.state : null;
      const revisionId = stringValue(body.revision_id);
      const commentText = stringValue(body.comment_text);
      if (!state || !revisionId || !commentText) return reply.code(422).send({ error: "revision_id, comment_text and state are required" });
      try {
        const result = await repository.annotate(actor, (request.params as { id: string }).id, { revisionId, revisionItemId: typeof body.revision_item_id === "string" ? body.revision_item_id : null, fieldName: typeof body.field_name === "string" ? body.field_name : null, commentText, state });
        return reply.code(201).send(result);
      } catch (error) { return reply.code(422).send({ error: "annotation_rejected", detail: errorMessage(error) }); }
    });

    server.delete("/candidates/:id/annotations/:annotationId", async (request, reply) => {
      const actor = requireTeacher(request);
      if (!actor) return reply.code(403).send({ error: "teacher principal required" });
      const params = request.params as { id: string; annotationId: string };
      try { return await repository.withdrawAnnotation(actor, params.id, params.annotationId); }
      catch (error) { return reply.code(422).send({ error: "annotation_withdraw_rejected", detail: errorMessage(error) }); }
    });

    server.post("/candidates/:id/decide", async (request, reply) => {
      const actor = requireTeacher(request);
      if (!actor) return reply.code(403).send({ error: "teacher principal required" });
      const value = jsonObject(request.body).decision;
      if (value !== "approved" && value !== "changes_requested") return reply.code(422).send({ error: "decision must be approved or changes_requested" });
      try {
        const result = await repository.decide(actor, (request.params as { id: string }).id, value);
        return result;
      } catch (error) { return reply.code(422).send({ error: "decision_rejected", detail: errorMessage(error) }); }
    });

    server.get("/packages", async (request, reply) => {
      const actor = principal(request);
      if (!actor) return reply.code(401).send({ error: "principal required" });
      return { packages: await repository.listPackages(actor) };
    });
    server.get("/packages/:id", async (request, reply) => {
      const actor = principal(request);
      if (!actor) return reply.code(401).send({ error: "principal required" });
      const value = await repository.getPackage(actor, (request.params as { id: string }).id);
      return value ? value : reply.code(404).send({ error: "package not found" });
    });
    server.post("/packages/:id/releases", async (request, reply) => {
      const actor = requireTeacher(request);
      if (!actor) return reply.code(403).send({ error: "teacher principal required" });
      const classId = stringValue(jsonObject(request.body).class_id);
      if (!classId) return reply.code(422).send({ error: "class_id is required" });
      try { return reply.code(201).send(await repository.releasePackage(actor, (request.params as { id: string }).id, classId)); }
      catch (error) { return reply.code(422).send({ error: "release_rejected", detail: errorMessage(error) }); }
    });
    server.delete("/packages/:id/releases/:classId", async (request, reply) => {
      const actor = requireTeacher(request);
      if (!actor) return reply.code(403).send({ error: "teacher principal required" });
      try { return await repository.withdrawPackage(actor, (request.params as { id: string }).id, (request.params as { classId: string }).classId); }
      catch (error) { return reply.code(422).send({ error: "withdraw_rejected", detail: errorMessage(error) }); }
    });

    let polling = false;
    const pollHostCommands = async (): Promise<void> => {
      if (polling) return;
      polling = true;
      try {
        await Promise.all([dispatchErCommands(server.log), dispatchReviewFeedbackCommands(server.log)]);
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(() => void pollHostCommands(), 5_000);
    timer.unref();
    void pollHostCommands();
    server.addHook("onClose", async () => { clearInterval(timer); await pool.end(); });
  },
});

void app;
