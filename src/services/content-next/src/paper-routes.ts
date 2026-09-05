import type { FastifyInstance, FastifyRequest } from "fastify";
import type { InternalServiceRuntime } from "@mathpilot/internal-service";
import { internalServiceContext, internalServiceGuard } from "@mathpilot/internal-service/fastify";
import { isTeacher, jsonObject, stringValue, type Principal } from "./lib.ts";
import { PaperRepository } from "./paper-repository.ts";

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

export function registerPaperRoutes(
  server: FastifyInstance,
  repository: PaperRepository,
  runtime: InternalServiceRuntime,
): void {
  const fromApi = internalServiceGuard(runtime, ["api-to-content"]);

  // 我的试卷：列表
  server.get("/papers", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reply.code(403).send({ error: "teacher principal required" });
    try {
      return { papers: await repository.listPapers(actor) };
    } catch (error) {
      return reply.code(422).send({ error: "papers_unavailable", detail: errorMessage(error) });
    }
  });

  // 我的试卷：详情（含题目与选项，供预览/换题）
  server.get("/papers/:id", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reply.code(403).send({ error: "teacher principal required" });
    const id = (request.params as { id: string }).id;
    const paper = await repository.getPaper(actor, id);
    if (!paper) return reply.code(404).send({ error: "paper not found" });
    return paper;
  });

  // 手动选题建卷（draft v1）
  server.post("/papers", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reply.code(403).send({ error: "teacher principal required" });
    const body = jsonObject(request.body);
    const title = stringValue(body.title, "");
    const config = body.config;
    const rawRevisions = body.revisions;
    if (!config || !Array.isArray(rawRevisions)) {
      return reply.code(422).send({ error: "config and revisions are required" });
    }
    const revisions = rawRevisions
      .map((value: unknown): { entity_id: string; revision_id: string } | null => {
        const row = jsonObject(value);
        const revision_id = stringValue(row.revision_id, "");
        const entity_id = stringValue(row.entity_id, "");
        if (!revision_id || !entity_id) return null;
        return { entity_id, revision_id };
      })
      .filter((value: unknown): value is { entity_id: string; revision_id: string } => value !== null);
    try {
      const created = await repository.createManualPaper(actor, title, config as never, revisions);
      return reply.code(201).send(created);
    } catch (error) {
      return reply.code(422).send({ error: "paper_rejected", detail: errorMessage(error) });
    }
  });

  // 自动组卷（draft v1）：从已解析的问题池按配置抽样成卷
  server.post("/papers/auto", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reply.code(403).send({ error: "teacher principal required" });
    const body = jsonObject(request.body);
    const title = stringValue(body.title, "");
    const config = body.config;
    if (!config) return reply.code(422).send({ error: "config is required" });
    try {
      const created = await repository.createAutoPaper(actor, title, config as never);
      return reply.code(201).send(created);
    } catch (error) {
      return reply.code(422).send({ error: "paper_rejected", detail: errorMessage(error) });
    }
  });

  // 预览换题/改难度（draft）
  server.patch("/papers/:id/items/:order", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reply.code(403).send({ error: "teacher principal required" });
    const { id, order } = request.params as { id: string; order: string };
    const body = jsonObject(request.body);
    const payload: { revision_id?: string; difficulty?: number } = {};
    if (typeof body.revision_id === "string") payload.revision_id = body.revision_id;
    if (typeof body.difficulty === "number") payload.difficulty = body.difficulty;
    try {
      const result = await repository.patchItem(actor, id, parseInt(order, 10), payload);
      return result;
    } catch (error) {
      return reply.code(422).send({ error: "paper_item_patch_rejected", detail: errorMessage(error) });
    }
  });

  // 自动换题（draft）：同题型+目标难度从教师题池替换
  server.post("/papers/:id/items/:order/swap", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reply.code(403).send({ error: "teacher principal required" });
    const { id, order } = request.params as { id: string; order: string };
    const body = jsonObject(request.body);
    const action = body.action === "harder" || body.action === "easier" || body.action === "same" ? body.action : "same";
    try {
      const result = await repository.swapItem(actor, id, parseInt(order, 10), { action });
      return result;
    } catch (error) {
      return reply.code(422).send({ error: "paper_swap_rejected", detail: errorMessage(error) });
    }
  });

  // 定稿
  server.post("/papers/:id/finalize", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reply.code(403).send({ error: "teacher principal required" });
    const id = (request.params as { id: string }).id;
    try {
      const result = await repository.finalizePaper(actor, id);
      return result;
    } catch (error) {
      return reply.code(422).send({ error: "paper_finalize_rejected", detail: errorMessage(error) });
    }
  });

  // 版本迭代：复制为新 draft（version_no+1）
  server.post("/papers/:id/iterate", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reply.code(403).send({ error: "teacher principal required" });
    const id = (request.params as { id: string }).id;
    try {
      const created = await repository.iteratePaper(actor, id);
      return reply.code(201).send(created);
    } catch (error) {
      return reply.code(422).send({ error: "paper_iterate_rejected", detail: errorMessage(error) });
    }
  });

  // 改名
  server.patch("/papers/:id", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reply.code(403).send({ error: "teacher principal required" });
    const id = (request.params as { id: string }).id;
    const body = jsonObject(request.body);
    const title = stringValue(body.title, "");
    if (!title.trim()) return reply.code(422).send({ error: "title is required" });
    const renamed = await repository.renamePaper(actor, id, title);
    return renamed ? { renamed: true } : reply.code(404).send({ error: "paper not found" });
  });

  // 删除本人试卷（草稿或已定稿）
  server.delete("/papers/:id", { preHandler: fromApi }, async (request, reply) => {
    const actor = requireTeacher(request);
    if (!actor) return reply.code(403).send({ error: "teacher principal required" });
    const id = (request.params as { id: string }).id;
    const deleted = await repository.deletePaper(actor, id);
    return deleted ? { deleted: true } : reply.code(404).send({ error: "paper not found" });
  });
}
