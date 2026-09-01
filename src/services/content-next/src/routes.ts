import type { InternalServiceRuntime } from "@mathpilot/internal-service";
import { internalServiceContext, internalServiceGuard, sendProblem } from "@mathpilot/internal-service/fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ContentRejection, type CandidateInput, type CandidateRepository } from "./candidate-repository.ts";
import { isTeacher, jsonObject, stringValue, type Principal } from "./lib.ts";

function principal(request: FastifyRequest): Principal {
  return internalServiceContext(request).actor;
}

function requireTeacher(request: FastifyRequest): Principal | null {
  const value = principal(request);
  return isTeacher(value) ? value : null;
}

const reject = (reply: FastifyReply, status: number, code: string, title: string) =>
  sendProblem(reply, { status, code, title });

export function registerContentNextRoutes(
  server: FastifyInstance,
  repository: CandidateRepository,
  runtime: InternalServiceRuntime,
): void {
  const fromApi = internalServiceGuard(runtime, ["api-to-content"]);
  const fromPi = internalServiceGuard(runtime, ["pi-to-content"]);

  server.post(
    "/internal/candidates/register",
    { preHandler: fromPi },
    async (request, reply) => {
      const actor = requireTeacher(request);
      if (!actor) return reject(reply, 403, "teacher_principal_required", "Teacher principal required");
      const body = jsonObject(request.body);
      const phase = body.phase === "ktq" || body.phase === "er" ? body.phase : null;
      const result = jsonObject(body.result);
      const threadId = stringValue(body.thread_id);
      const toolCallId = stringValue(body.tool_call_id);
      const resultSha256 = stringValue(body.result_sha256);
      const resultObjectId = stringValue(body.result_object_id);
      const receiptObjectId = stringValue(body.receipt_object_id);
      if (!phase || !threadId || !toolCallId || !resultSha256 || !resultObjectId || !receiptObjectId || !Object.keys(result).length) {
        return reject(reply, 422, "invalid_candidate_registration", "Candidate registration fields are invalid");
      }
      const rawSourceObjects = body.source_objects === undefined ? [] : body.source_objects;
      if (!Array.isArray(rawSourceObjects) || rawSourceObjects.length > 64) {
        return reject(reply, 422, "invalid_source_objects", "Source objects must be a bounded array");
      }
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
      if (sourceObjects.some((value) => !value)) {
        return reject(reply, 422, "invalid_source_objects", "Source objects contain invalid metadata");
      }
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
        const registered = await repository.register(actor, input);
        const candidate = {
          candidate_set_id:registered.candidate_set_id,phase:registered.phase,
          owner_teacher_user_id:registered.owner_teacher_user_id,thread_id:registered.thread_id,
          sequence_no:registered.sequence_no,status:registered.status,item_count:registered.item_count,
          created_at:registered.created_at,decided_at:registered.decided_at,
        };
        return reply.code(registered.created ? 201 : 200).send({
          kind: "content_review",
          registration: {
            created:registered.created,
            result_object_id:registered.result_object_id,
            receipt_object_id:registered.receipt_object_id,
            result_sha256:registered.result_sha256,
          },
          candidate,
          review_url: `/content/review/${encodeURIComponent(candidate.candidate_set_id)}`,
        });
      } catch (error) {
        if (!(error instanceof ContentRejection)) throw error;
        request.log.warn({ err: error }, "candidate registration rejected");
        return reject(reply, 422, "candidate_registration_rejected", "Candidate registration was rejected");
      }
    },
  );

  server.get(
    "/agent/library/search",
    { preHandler: fromPi },
    async (request, reply) => {
      const actor = principal(request);
      const query = typeof (request.query as { query?: unknown }).query === "string"
        ? (request.query as { query: string }).query.trim()
        : "";
      const rawKinds = (request.query as { entity_kinds?: unknown }).entity_kinds;
      const kinds = rawKinds === undefined || rawKinds === ""
        ? undefined
        : (typeof rawKinds === "string" ? rawKinds.split(",") : Array.isArray(rawKinds) ? rawKinds : []).map(String) as Array<
          "knowledge" | "question_type" | "question" | "error_cause" | "diagnosis_rule"
        >;
      const cursorValue = (request.query as { cursor?: unknown }).cursor;
      const limitValue = (request.query as { limit?: unknown }).limit;
      const offset = cursorValue === undefined || cursorValue === "" ? 0 : Number(cursorValue);
      const limit = limitValue === undefined || limitValue === "" ? 20 : Number(limitValue);
      if (query.length > 240 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        return reject(reply, 422, "invalid_library_query", "Library query, cursor or limit is invalid");
      }
      const result = await repository.searchLibrary(actor, kinds, query, offset, limit);
      return {
        items: result.items,
        next_cursor: result.nextOffset === null ? null : String(result.nextOffset),
        query_fallback: result.queryFallback,
        transport: "normalized-content-library",
      };
    },
  );

  server.get(
    "/agent/library/get",
    { preHandler: fromPi },
    async (request, reply) => {
      const actor = principal(request);
      const query = request.query as { entity_ref?: unknown; package_ref?: unknown };
      const packageRef = stringValue(query.package_ref);
      if (packageRef) {
        const packageMatch = /^package:([A-Za-z0-9_.:-]{1,127})$/.exec(packageRef);
        if (!packageMatch) return reject(reply, 422, "invalid_package_ref", "A valid package reference is required");
        const value = await repository.getPackage(actor, packageMatch[1]!, isTeacher(actor));
        if (!value) return reject(reply, 404, "package_not_found", "Package not found or not visible");
        return { package: value, transport: "normalized-content-library" };
      }
      const ref = stringValue(query.entity_ref);
      const match = /^([a-z_]+):([A-Za-z0-9_.:-]{1,127})$/.exec(ref);
      const allowed = new Set(["knowledge", "question_type", "question", "error_cause", "diagnosis_rule"]);
      if (!match || !allowed.has(match[1]!)) {
        return reject(reply, 422, "invalid_entity_ref", "An entity or package reference is required");
      }
      const entity = await repository.getLibrary(
        actor,
        match[1] as "knowledge" | "question_type" | "question" | "error_cause" | "diagnosis_rule",
        match[2]!,
      );
      if (!entity) return reject(reply, 404, "entity_not_found", "Entity not found or not visible");
      return { entity, transport: "normalized-content-library" };
    },
  );

  server.get("/candidates", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reject(reply, 403, "teacher_principal_required", "Teacher principal required");
    const status = typeof (request.query as { status?: unknown }).status === "string"
      ? (request.query as { status: string }).status
      : undefined;
    return { candidates: await repository.list(actor, status) };
  });

  server.get("/candidates/:id", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reject(reply, 403, "teacher_principal_required", "Teacher principal required");
    const id = (request.params as { id: string }).id;
    const value = await repository.get(actor, id);
    return value ? value : reject(reply, 404, "candidate_not_found", "Candidate not found");
  });

  server.get(
    "/internal/candidates/:id/frozen",
    { preHandler: fromPi },
    async (request, reply) => {
      const actor = requireTeacher(request);
      if (!actor) return reject(reply, 403, "teacher_principal_required", "Teacher principal required");
      const value = await repository.frozenKtq(actor, (request.params as { id: string }).id);
      return value ? value : reject(reply, 404, "approved_candidate_not_found", "Approved KTQ candidate not found");
    },
  );

  server.post("/candidates/:id/annotations", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reject(reply, 403, "teacher_principal_required", "Teacher principal required");
    const body = jsonObject(request.body);
    const state = body.state === "draft" || body.state === "submitted" || body.state === "withdrawn" ? body.state : null;
    const revisionId = stringValue(body.revision_id);
    const commentText = stringValue(body.comment_text);
    if (!state || !revisionId || !commentText) {
      return reject(reply, 422, "invalid_annotation", "Annotation fields are invalid");
    }
    try {
      const result = await repository.annotate(actor, (request.params as { id: string }).id, {
        revisionId,
        revisionItemId: typeof body.revision_item_id === "string" ? body.revision_item_id : null,
        fieldName: typeof body.field_name === "string" ? body.field_name : null,
        commentText,
        state,
      });
      return reply.code(201).send(result);
    } catch (error) {
      if (!(error instanceof ContentRejection)) throw error;
      request.log.warn({ err: error }, "annotation rejected");
      return reject(reply, 422, "annotation_rejected", "Annotation was rejected");
    }
  });

  server.delete("/candidates/:id/annotations/:annotationId", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reject(reply, 403, "teacher_principal_required", "Teacher principal required");
    const params = request.params as { id: string; annotationId: string };
    try {
      return await repository.withdrawAnnotation(actor, params.id, params.annotationId);
    } catch (error) {
      if (!(error instanceof ContentRejection)) throw error;
      request.log.warn({ err: error }, "annotation withdrawal rejected");
      return reject(reply, 422, "annotation_withdraw_rejected", "Annotation withdrawal was rejected");
    }
  });

  server.post("/candidates/:id/decide", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reject(reply, 403, "teacher_principal_required", "Teacher principal required");
    const value = jsonObject(request.body).decision;
    if (value !== "approved" && value !== "changes_requested") {
      return reject(reply, 422, "invalid_review_decision", "Review decision is invalid");
    }
    try {
      return await repository.decide(actor, (request.params as { id: string }).id, value);
    } catch (error) {
      if (!(error instanceof ContentRejection)) throw error;
      request.log.warn({ err: error }, "review decision rejected");
      return reject(reply, 422, "decision_rejected", "Review decision was rejected");
    }
  });

  server.get("/packages", { preHandler: fromApi }, async (request) => {
    const actor = principal(request);
    return { packages: await repository.listPackages(actor) };
  });

  server.get("/packages/:id", { preHandler: fromApi }, async (request, reply) => {
    const actor = principal(request);
    const value = await repository.getPackage(actor, (request.params as { id: string }).id);
    return value ? value : reject(reply, 404, "package_not_found", "Package not found");
  });

  server.post("/packages/:id/releases", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reject(reply, 403, "teacher_principal_required", "Teacher principal required");
    const classId = stringValue(jsonObject(request.body).class_id);
    if (!classId) return reject(reply, 422, "invalid_class_id", "Class ID is required");
    try {
      return reply.code(201).send(await repository.releasePackage(actor, (request.params as { id: string }).id, classId));
    } catch (error) {
      if (!(error instanceof ContentRejection)) throw error;
      request.log.warn({ err: error }, "package release rejected");
      return reject(reply, 422, "release_rejected", "Package release was rejected");
    }
  });

  server.delete("/packages/:id/releases/:classId", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reject(reply, 403, "teacher_principal_required", "Teacher principal required");
    try {
      return await repository.withdrawPackage(
        actor,
        (request.params as { id: string }).id,
        (request.params as { classId: string }).classId,
      );
    } catch (error) {
      if (!(error instanceof ContentRejection)) throw error;
      request.log.warn({ err: error }, "package withdrawal rejected");
      return reject(reply, 422, "withdraw_rejected", "Package withdrawal was rejected");
    }
  });
}
