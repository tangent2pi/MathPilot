/**
 * 组卷答案解析：prepare（生成草稿：题库答案 + AI 补全）→ 教师在线复核（PUT）→ render（出 PDF）。
 * 仅定稿试卷可用；存在未决【复核】时禁止出 PDF。
 */
import { createHash } from "node:crypto";
import type { InternalActor, InternalServiceRuntime } from "@mathpilot/internal-service";
import { internalServiceContext, internalServiceGuard } from "@mathpilot/internal-service/fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { completeMissingAnalyses, ensureChoiceLetterAnswer, normalizeBankAnswer, type QuestionForAnalysis } from "./answer-analysis.ts";
import { casualToLatex, latexToCasual } from "./math-latex.ts";
import { isTeacher, jsonObject, stringValue, type Principal } from "./lib.ts";
import { PaperRepository } from "./paper-repository.ts";

type Json = Record<string, unknown>;

/** 编辑器展示视图：库存为 LaTeX，返回给复核对话框时把答案/解析逆转为通俗符号（√3、π/3）。
 * 教师在编辑器写通俗符号，保存时 PUT 再经 casualToLatex 转回 LaTeX，首尾一致。 */
function toEditorView<T extends { answer_text: string; analysis_text: string }>(items: T[]): T[] {
  return items.map((item) => ({
    ...item,
    answer_text: latexToCasual(item.answer_text),
    analysis_text: latexToCasual(item.analysis_text),
  }));
}

const RENDER_TIMEOUT_MS = 180_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readJson(response: Response): Promise<Json> {
  const text = await response.text();
  try { return jsonObject(JSON.parse(text)); } catch { return {}; }
}

interface AnswerItem {
  item_order: number;
  answer_text: string;
  analysis_text: string;
  need_review: boolean;
  review_note: string | null;
  source: string;
}

function answerItemOf(row: Json): AnswerItem {
  return {
    item_order: Number(row.item_order ?? 0),
    answer_text: stringValue(row.answer_text, ""),
    analysis_text: stringValue(row.analysis_text, ""),
    need_review: row.need_review === true,
    review_note: typeof row.review_note === "string" && row.review_note.trim() ? row.review_note.trim() : null,
    source: stringValue(row.source, "bank"),
  };
}

/** 把试卷题目字段（题型/题干/选项）合并进答案条目，供前端复核对话框渲染题干。 */
function withStemFields(items: AnswerItem[], paperItems: Json[]): Array<AnswerItem & { stem_format: string; stem_markdown: string; options: Array<{ option_key: string; option_text: string }> }> {
  const byOrder = new Map(paperItems.map((item) => [Number(item.item_order ?? 0), item]));
  return items.map((item) => {
    const source = byOrder.get(item.item_order) as Json | undefined;
    return {
      ...item,
      stem_format: stringValue(source?.stem_format, "open_solution"),
      stem_markdown: stringValue(source?.stem_markdown, ""),
      options: Array.isArray(source?.options)
        ? (source.options as Json[]).map((option: Json) => ({ option_key: stringValue(option.option_key, ""), option_text: stringValue(option.option_text, "") }))
        : [],
    };
  });
}

export function registerPaperAnswerRoutes(
  server: FastifyInstance,
  repository: PaperRepository,
  _pool: pg.Pool,
  runtime: InternalServiceRuntime,
): void {
  const fromApi = internalServiceGuard(runtime, ["api-to-content"]);

  // 生成/刷新答案解析草稿：题库已有答案/解析原样保留，缺失部分 AI 补全。
  // 已保存的教师复核结果不会被覆盖。
  server.post("/papers/:id/answer/prepare", { preHandler: fromApi }, async (request: FastifyRequest, reply) => {
    const actor = internalServiceContext(request).actor as InternalActor;
    if (!isTeacher(actor as unknown as Principal)) return reply.code(403).send({ error: "teacher principal required" });
    const paperId = String((request.params as { id: unknown }).id ?? "");
    if (!paperId) return reply.code(422).send({ error: "paper id is required" });
    const principal: Principal = { tenantId: actor.tenantId, userId: actor.userId, roles: [...actor.roles] };
    try {
      const paper = await repository.getPaper(principal, paperId);
      if (!paper) return reply.code(404).send({ error: "paper not found" });
      if (String(paper.status ?? "draft") !== "finalized") {
        return reply.code(422).send({ error: "answer analysis is only available after finalization" });
      }
      const paperItems = Array.isArray(paper.items) ? paper.items : [];
      if (paperItems.length < 1) return reply.code(422).send({ error: "paper contains no questions" });

      const existing = (await repository.getAnswerItems(principal, paperId)).map(answerItemOf);
      const existingByOrder = new Map(existing.map((item) => [item.item_order, item]));

      const needsCompletion: QuestionForAnalysis[] = [];
      const merged: AnswerItem[] = [];
      for (const item of paperItems) {
        const order = Number(item.item_order ?? 0);
        const saved = existingByOrder.get(order);
        const stemFormat = stringValue(item.stem_format, "open_solution");
        const stemMarkdown = stringValue(item.stem_markdown, "");
        const options = Array.isArray(item.options)
          ? item.options.map((option: Json) => ({ option_key: stringValue(option.option_key, ""), option_text: stringValue(option.option_text, "") }))
          : [];
        if (saved) {
          merged.push(saved);
          continue;
        }
        const bankAnswer = ensureChoiceLetterAnswer(stemFormat, options, normalizeBankAnswer(stringValue(item.answer_text, "")));
        const bankAnalysis = stringValue(item.analysis_markdown, "");
        if (bankAnswer && bankAnalysis) {
          merged.push({ item_order: order, answer_text: casualToLatex(bankAnswer), analysis_text: casualToLatex(bankAnalysis), need_review: false, review_note: null, source: "bank" });
          continue;
        }
        needsCompletion.push({ item_order: order, stem_format: stemFormat, stem_markdown: stemMarkdown, options, answer_text: bankAnswer, analysis_text: bankAnalysis });
      }

      if (needsCompletion.length > 0) {
        const { completed, failed } = await completeMissingAnalyses(needsCompletion);
        for (const row of completed) {
          merged.push({ item_order: row.item_order, answer_text: row.answer_text, analysis_text: row.analysis_text, need_review: row.need_review, review_note: row.review_note, source: row.source });
        }
        if (failed.length > 0) {
          for (const order of failed) {
            const source = paperItems.find((item: Json) => Number(item.item_order ?? 0) === order) as Json | undefined;
            const srcFormat = stringValue(source?.stem_format, "open_solution");
            const srcOptions = Array.isArray(source?.options)
              ? (source.options as Json[]).map((option: Json) => ({ option_key: stringValue(option.option_key, ""), option_text: stringValue(option.option_text, "") }))
              : [];
            merged.push({
              item_order: order,
              answer_text: casualToLatex(ensureChoiceLetterAnswer(srcFormat, srcOptions, normalizeBankAnswer(stringValue(source?.answer_text, "")))),
              analysis_text: casualToLatex(stringValue(source?.analysis_markdown, "")),
              need_review: true,
              review_note: "AI 补全失败，请人工补充解析",
              source: "ai",
            });
          }
        }
        merged.sort((a, b) => a.item_order - b.item_order);
        await repository.replaceAnswerItems(principal, paperId, merged);
      }

      return {
        paper_id: paperId,
        title: stringValue(paper.title, ""),
        status: paper.status,
        answer_pdf_sha256: typeof paper.answer_pdf_sha256 === "string" ? paper.answer_pdf_sha256 : null,
        items: toEditorView(withStemFields(merged, paperItems)),
      };
    } catch (error) {
      request.log.error({ err: error, paperId }, "paper answer prepare failed");
      return reply.code(502).send({ error: "paper_answer_prepare_failed", detail: errorMessage(error) });
    }
  });

  // 读取当前答案解析草稿（供复核对话框加载）。
  server.get("/papers/:id/answer", { preHandler: fromApi }, async (request: FastifyRequest, reply) => {
    const actor = internalServiceContext(request).actor as InternalActor;
    if (!isTeacher(actor as unknown as Principal)) return reply.code(403).send({ error: "teacher principal required" });
    const paperId = String((request.params as { id: unknown }).id ?? "");
    if (!paperId) return reply.code(422).send({ error: "paper id is required" });
    const principal: Principal = { tenantId: actor.tenantId, userId: actor.userId, roles: [...actor.roles] };
    try {
      const paper = await repository.getPaper(principal, paperId);
      if (!paper) return reply.code(404).send({ error: "paper not found" });
      const paperItems = Array.isArray(paper.items) ? paper.items : [];
      const items = toEditorView(withStemFields((await repository.getAnswerItems(principal, paperId)).map(answerItemOf), paperItems));
      return {
        paper_id: paperId,
        title: stringValue(paper.title, ""),
        status: paper.status,
        answer_pdf_sha256: typeof paper.answer_pdf_sha256 === "string" ? paper.answer_pdf_sha256 : null,
        items,
      };
    } catch (error) {
      return reply.code(502).send({ error: "paper_answer_unavailable", detail: errorMessage(error) });
    }
  });

  // 保存教师复核后的逐题答案/解析（覆盖式 upsert）。
  server.put("/papers/:id/answer/items", { preHandler: fromApi }, async (request: FastifyRequest, reply) => {
    const actor = internalServiceContext(request).actor as InternalActor;
    if (!isTeacher(actor as unknown as Principal)) return reply.code(403).send({ error: "teacher principal required" });
    const paperId = String((request.params as { id: unknown }).id ?? "");
    if (!paperId) return reply.code(422).send({ error: "paper id is required" });
    const body = jsonObject(request.body);
    const rawItems = body.items;
    if (!Array.isArray(rawItems)) return reply.code(422).send({ error: "items array is required" });
    const items = rawItems.map((value: unknown) => {
      const row = jsonObject(value);
      return {
        item_order: Number(row.item_order ?? 0),
        answer_text: casualToLatex(stringValue(row.answer_text, "")),
        analysis_text: casualToLatex(stringValue(row.analysis_text, "")),
        need_review: row.need_review === true,
        review_note: typeof row.review_note === "string" && row.review_note.trim() ? row.review_note.trim() : null,
      };
    });
    const principal: Principal = { tenantId: actor.tenantId, userId: actor.userId, roles: [...actor.roles] };
    try {
      await repository.upsertAnswerItems(principal, paperId, items);
      return { saved: true, count: items.length };
    } catch (error) {
      return reply.code(422).send({ error: "paper_answer_save_rejected", detail: errorMessage(error) });
    }
  });

  // 生成答案解析 PDF：存在未决【复核】时拒绝；出片后落盘并记录 answer_pdf。
  server.post("/papers/:id/answer/render", { preHandler: fromApi }, async (request: FastifyRequest, reply) => {
    const actor = internalServiceContext(request).actor as InternalActor;
    if (!isTeacher(actor as unknown as Principal)) return reply.code(403).send({ error: "teacher principal required" });
    const paperId = String((request.params as { id: unknown }).id ?? "");
    if (!paperId) return reply.code(422).send({ error: "paper id is required" });
    const principal: Principal = { tenantId: actor.tenantId, userId: actor.userId, roles: [...actor.roles] };
    try {
      const paper = await repository.getPaper(principal, paperId);
      if (!paper) return reply.code(404).send({ error: "paper not found" });
      if (String(paper.status ?? "draft") !== "finalized") {
        return reply.code(422).send({ error: "answer analysis is only available after finalization" });
      }

      const existingObjectId = typeof paper.answer_pdf_object_id === "string" ? paper.answer_pdf_object_id : null;
      if (existingObjectId) {
        const getRes = await runtime.request(
          "content-to-storage",
          actor,
          `/internal/objects/${encodeURIComponent(existingObjectId)}/presign-get`,
          { method: "POST", json: { audience: "public" } },
        );
        if (getRes.ok || getRes.status === 200) {
          const body = await readJson(getRes);
          return { object_id: existingObjectId, reused: true, ...body };
        }
      }

      const answerItems = (await repository.getAnswerItems(principal, paperId)).map(answerItemOf);
      if (answerItems.length < 1) return reply.code(422).send({ error: "answer analysis is not prepared yet" });
      const unresolved = answerItems.filter((item) => item.need_review);
      if (unresolved.length > 0) {
        return reply.code(422).send({
          error: "unresolved_review_items",
          detail: `还有 ${unresolved.length} 题待人工复核（${unresolved.map((item) => item.item_order + 1).join("、")} 题），请先在线复核后再生成。`,
        });
      }

      const paperItems = Array.isArray(paper.items) ? paper.items : [];
      const itemsByOrder = new Map(paperItems.map((item: Json) => [Number(item.item_order ?? 0), item]));
      const renderItems = answerItems.map((item) => {
        const source = itemsByOrder.get(item.item_order) as Json | undefined;
        return {
          item_order: item.item_order,
          stem_format: stringValue(source?.stem_format, "open_solution"),
          stem_markdown: stringValue(source?.stem_markdown, ""),
          options: Array.isArray(source?.options)
            ? (source.options as Json[]).map((option: Json) => ({ option_key: stringValue(option.option_key, ""), option_text: stringValue(option.option_text, "") }))
            : [],
          answer_text: item.answer_text,
          analysis_text: item.analysis_text,
        };
      });

      const renderRes = await runtime.request(
        "content-to-group",
        actor,
        "/internal/paper/answer-render",
        { method: "POST", json: { title: stringValue(paper.title, "数学试卷"), items: renderItems }, timeoutMs: RENDER_TIMEOUT_MS },
      );
      if (!renderRes.ok) {
        const body = await readJson(renderRes);
        return reply.code(renderRes.status).send({ error: "paper_answer_render_failed", detail: String(body.detail ?? body.error ?? "render failed") });
      }
      const pdf = Buffer.from(await renderRes.arrayBuffer());
      if (pdf.length < 40) return reply.code(502).send({ error: "paper_answer_render_failed", detail: "render returned an empty document" });
      const sha256 = sha256Hex(pdf);

      const title = stringValue(paper.title, "数学试卷");
      const initRes = await runtime.request(
        "content-to-storage",
        actor,
        "/internal/objects/init",
        {
          method: "POST",
          json: { purpose: "paper", mime_type: "application/pdf", byte_size: pdf.length, original_name: `${title}参考答案与解析.pdf`, audience: "runtime" },
        },
      );
      if (!initRes.ok) {
        const body = await readJson(initRes);
        return reply.code(initRes.status).send({ error: "paper_answer_store_init_failed", detail: String(body.error ?? "store init failed") });
      }
      const init = await readJson(initRes);
      const objectId = String(init.object_id ?? "");
      const uploadUrl = String(init.upload_url ?? "");
      if (!objectId || !uploadUrl) return reply.code(502).send({ error: "paper_answer_store_init_failed", detail: "missing object_id or upload_url" });

      const uploaded = await fetch(uploadUrl, {
        method: "PUT",
        body: pdf,
        headers: { "content-type": "application/pdf" },
      });
      if (!uploaded.ok && uploaded.status !== 200) {
        return reply.code(502).send({ error: "paper_answer_store_upload_failed", detail: `upload returned ${uploaded.status}` });
      }

      const completeRes = await runtime.request(
        "content-to-storage",
        actor,
        `/internal/objects/${encodeURIComponent(objectId)}/complete`,
        { method: "POST", json: { sha256 } },
      );
      if (!completeRes.ok) {
        return reply.code(completeRes.status).send({ error: "paper_answer_store_complete_failed", detail: "storage verification failed" });
      }

      await repository.setPaperAnswerPdf(principal, paperId, objectId, sha256);

      const getRes = await runtime.request(
        "content-to-storage",
        actor,
        `/internal/objects/${encodeURIComponent(objectId)}/presign-get`,
        { method: "POST", json: { audience: "public" } },
      );
      if (!getRes.ok) return { object_id: objectId, sha256 };
      const body = await readJson(getRes);
      return { object_id: objectId, sha256, ...body };
    } catch (error) {
      request.log.error({ err: error, paperId }, "paper answer render failed");
      return reply.code(502).send({ error: "paper_answer_render_failed", detail: errorMessage(error) });
    }
  });
}
