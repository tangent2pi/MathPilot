import type { InternalServiceRuntime } from "@mathpilot/internal-service";
import { internalServiceContext, internalServiceGuard } from "@mathpilot/internal-service/fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CandidateInput, CandidateRepository } from "./candidate-repository.ts";
import { isTeacher, jsonObject, stringValue, type Principal } from "./lib.ts";

function principal(request: FastifyRequest): Principal {
  return internalServiceContext(request).actor;
}

function requireTeacher(request: FastifyRequest): Principal | null {
  const value = principal(request);
  return isTeacher(value) ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerContentNextRoutes(
  server: FastifyInstance,
  repository: CandidateRepository,
  runtime: InternalServiceRuntime,
): void {
  const fromApi = internalServiceGuard(runtime, ["api-to-content"]);
  const fromPi = internalServiceGuard(runtime, ["pi-to-content"]);

  server.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "content-next request failed");
    return reply.code(500).send({ error: "content-next request failed" });
  });

  server.post(
    "/internal/candidates/register",
    { preHandler: fromPi },
    async (request, reply) => {
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
      if (!phase || !threadId || !toolCallId || !resultSha256 || !resultObjectId || !receiptObjectId || !Object.keys(result).length) {
        return reply.code(422).send({ error: "phase, thread_id, tool_call_id, result/receipt objects, result_sha256 and result are required" });
      }
      const rawSourceObjects = body.source_objects === undefined ? [] : body.source_objects;
      if (!Array.isArray(rawSourceObjects) || rawSourceObjects.length > 64) {
        return reply.code(422).send({ error: "source_objects must be a bounded array" });
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
        return reply.code(422).send({ error: "source_objects contains invalid metadata" });
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
        const candidate = await repository.register(actor, input);
        return reply.code(201).send({
          kind: "content_review",
          candidate,
          review_url: `/content/review/${encodeURIComponent(candidate.candidate_set_id)}`,
        });
      } catch (error) {
        request.log.warn({ err: error }, "candidate registration rejected");
        return reply.code(422).send({ error: "candidate_registration_rejected", detail: errorMessage(error) });
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
        return reply.code(422).send({ error: "invalid query, cursor or limit" });
      }
      try {
        const result = await repository.searchLibrary(actor, kinds, query, offset, limit);
        return {
          items: result.items,
          next_cursor: result.nextOffset === null ? null : String(result.nextOffset),
          query_fallback: result.queryFallback,
          transport: "normalized-content-library",
        };
      } catch (error) {
        return reply.code(422).send({ error: "library_search_failed", detail: errorMessage(error) });
      }
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
        if (!packageMatch) return reply.code(422).send({ error: "valid package_ref is required" });
        const value = await repository.getPackage(actor, packageMatch[1]!, isTeacher(actor));
        if (!value) return reply.code(404).send({ error: "package not found or not visible" });
        return { package: value, transport: "normalized-content-library" };
      }
      const ref = stringValue(query.entity_ref);
      const match = /^([a-z_]+):([A-Za-z0-9_.:-]{1,127})$/.exec(ref);
      const allowed = new Set(["knowledge", "question_type", "question", "error_cause", "diagnosis_rule"]);
      if (!match || !allowed.has(match[1]!)) {
        return reply.code(422).send({ error: "entity_ref or package_ref is required" });
      }
      const entity = await repository.getLibrary(
        actor,
        match[1] as "knowledge" | "question_type" | "question" | "error_cause" | "diagnosis_rule",
        match[2]!,
      );
      if (!entity) return reply.code(404).send({ error: "entity not found or not visible" });
      return { entity, transport: "normalized-content-library" };
    },
  );

  server.get("/candidates", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reply.code(403).send({ error: "teacher principal required" });
    const status = typeof (request.query as { status?: unknown }).status === "string"
      ? (request.query as { status: string }).status
      : undefined;
    return { candidates: await repository.list(actor, status) };
  });

  server.get("/candidates/:id", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reply.code(403).send({ error: "teacher principal required" });
    const id = (request.params as { id: string }).id;
    const value = await repository.get(actor, id);
    return value ? value : reply.code(404).send({ error: "candidate not found" });
  });

  // 教师给解析批次（候选集）改名；display_name 传空则恢复默认显示名。
  server.patch("/candidates/:id/display-name", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reply.code(403).send({ error: "teacher principal required" });
    const id = (request.params as { id: string }).id;
    const body = jsonObject(request.body);
    const displayName = typeof body.display_name === "string" ? body.display_name : "";
    try {
      const renamed = await repository.renameCandidateDisplayName(actor, id, displayName);
      return renamed ? { renamed: true } : reply.code(404).send({ error: "candidate set not found or not owned by this teacher" });
    } catch (error) {
      return reply.code(422).send({ error: "rename_rejected", detail: errorMessage(error) });
    }
  });

  server.get(
    "/internal/candidates/:id/frozen",
    { preHandler: fromPi },
    async (request, reply) => {
      const actor = requireTeacher(request);
      if (!actor) return reply.code(403).send({ error: "teacher principal required" });
      const value = await repository.frozenKtq(actor, (request.params as { id: string }).id);
      return value ? value : reply.code(404).send({ error: "approved KTQ candidate not found" });
    },
  );

  server.post("/candidates/:id/annotations", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reply.code(403).send({ error: "teacher principal required" });
    const body = jsonObject(request.body);
    const state = body.state === "draft" || body.state === "submitted" || body.state === "withdrawn" ? body.state : null;
    const revisionId = stringValue(body.revision_id);
    const commentText = stringValue(body.comment_text);
    if (!state || !revisionId || !commentText) {
      return reply.code(422).send({ error: "revision_id, comment_text and state are required" });
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
      return reply.code(422).send({ error: "annotation_rejected", detail: errorMessage(error) });
    }
  });

  server.delete("/candidates/:id/annotations/:annotationId", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reply.code(403).send({ error: "teacher principal required" });
    const params = request.params as { id: string; annotationId: string };
    try {
      return await repository.withdrawAnnotation(actor, params.id, params.annotationId);
    } catch (error) {
      return reply.code(422).send({ error: "annotation_withdraw_rejected", detail: errorMessage(error) });
    }
  });

  server.delete("/candidates/:id", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reply.code(403).send({ error: "teacher principal required" });
    const id = (request.params as { id: string }).id;
    const deleted = await repository.deleteCandidateSet(actor, id);
    return deleted ? { deleted: true } : reply.code(404).send({ error: "candidate set not found or not deletable" });
  });

  server.post("/candidates/:id/decide", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reply.code(403).send({ error: "teacher principal required" });
    const value = jsonObject(request.body).decision;
    if (value !== "approved" && value !== "changes_requested") {
      return reply.code(422).send({ error: "decision must be approved or changes_requested" });
    }
    try {
      return await repository.decide(actor, (request.params as { id: string }).id, value);
    } catch (error) {
      return reply.code(422).send({ error: "decision_rejected", detail: errorMessage(error) });
    }
  });

  server.get("/packages", { preHandler: fromApi }, async (request) => {
    const actor = principal(request);
    return { packages: await repository.listPackages(actor) };
  });

  server.get("/packages/:id", { preHandler: fromApi }, async (request, reply) => {
    const actor = principal(request);
    const value = await repository.getPackage(actor, (request.params as { id: string }).id);
    return value ? value : reply.code(404).send({ error: "package not found" });
  });

  server.post("/packages/:id/releases", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reply.code(403).send({ error: "teacher principal required" });
    const classId = stringValue(jsonObject(request.body).class_id);
    if (!classId) return reply.code(422).send({ error: "class_id is required" });
    try {
      return reply.code(201).send(await repository.releasePackage(actor, (request.params as { id: string }).id, classId));
    } catch (error) {
      return reply.code(422).send({ error: "release_rejected", detail: errorMessage(error) });
    }
  });

  server.delete("/packages/:id/releases/:classId", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reply.code(403).send({ error: "teacher principal required" });
    try {
      return await repository.withdrawPackage(
        actor,
        (request.params as { id: string }).id,
        (request.params as { classId: string }).classId,
      );
    } catch (error) {
      return reply.code(422).send({ error: "withdraw_rejected", detail: errorMessage(error) });
    }
  });

  // 教师私有资料库：解析批次（候选集）+ 已生成包聚合。
  server.get("/teacher/library", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reply.code(403).send({ error: "teacher principal required" });
    const [candidates, packages] = await Promise.all([
      repository.list(actor),
      repository.listPackages(actor),
    ]);
    return { candidates, packages };
  });

  // 教师手动选题组卷：可挑选题目清单（本人解析、已批准/就绪的最新修订）。
  server.get("/teacher/library/questions", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reply.code(403).send({ error: "teacher principal required" });
    try {
      return { questions: await repository.listManualPickableQuestions(actor) };
    } catch (error) {
      return reply.code(422).send({ error: "questions_unavailable", detail: errorMessage(error) });
    }
  });

  // 教师手动选题组卷：创建 manual 练习包（ready，可直接发布到班级）。
  server.post("/teacher/library/packages/manual", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reply.code(403).send({ error: "teacher principal required" });
    const body = jsonObject(request.body);
    const title = typeof body.title === "string" ? body.title : "";
    const rawRevisionIds = body.revision_ids;
    if (!Array.isArray(rawRevisionIds)) {
      return reply.code(422).send({ error: "revision_ids must be an array of question revision ids" });
    }
    const revisionIds = rawRevisionIds.filter((value): value is string => typeof value === "string");
    try {
      const created = await repository.createManualTeacherPackage(actor, title, revisionIds);
      return reply.code(201).send(created);
    } catch (error) {
      return reply.code(422).send({ error: "manual_package_rejected", detail: errorMessage(error) });
    }
  });

  // 教师给自有练习包改名。
  server.patch("/packages/:id", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reply.code(403).send({ error: "teacher principal required" });
    const id = (request.params as { id: string }).id;
    const body = jsonObject(request.body);
    const title = typeof body.title === "string" ? body.title : "";
    if (!title.trim()) return reply.code(422).send({ error: "title is required" });
    try {
      const renamed = await repository.renameTeacherPackageTitle(actor, id, title);
      return renamed ? { renamed: true } : reply.code(404).send({ error: "teacher package not found or not editable" });
    } catch (error) {
      return reply.code(422).send({ error: "rename_rejected", detail: errorMessage(error) });
    }
  });

  // 删除“未发布”的教师私有包（ready 状态）；已发布请先撤回。
  server.delete("/packages/:id", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reply.code(403).send({ error: "teacher principal required" });
    const id = (request.params as { id: string }).id;
    const deleted = await repository.deleteTeacherPackage(actor, id);
    return deleted ? { deleted: true } : reply.code(404).send({ error: "teacher package not found or not deletable" });
  });
}
