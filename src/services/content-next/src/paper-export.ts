/**
 * 试卷导出：content-next 聚合群片链路
 *   教师触点 API → POST /papers/:id/export
 *     1) 已在 content_paper 上持久化 PDF 的已定稿卷 → 直达既有对象，返回下载链接；
 *     2) 否则渲染：content-to-group 调 group-next 出片(xelatex)
 *     3) 落盘：content-to-storage init/上传/complete，写入 storage_object(purpose='paper')
 *     4) 回写 content_paper.pdf_object_id/pdf_sha256，返回浏览器可下载的 presigned URL。
 */
import { createHash } from "node:crypto";
import type { InternalActor, InternalServiceRuntime } from "@mathpilot/internal-service";
import { internalServiceContext, internalServiceGuard } from "@mathpilot/internal-service/fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { isTeacher, jsonObject, stringValue, type Principal } from "./lib.ts";
import { PaperRepository } from "./paper-repository.ts";

type Json = Record<string, unknown>;

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

export function registerPaperExportRoutes(
  server: FastifyInstance,
  repository: PaperRepository,
  _pool: pg.Pool,
  runtime: InternalServiceRuntime,
): void {
  const fromApi = internalServiceGuard(runtime, ["api-to-content"]);

  // 触达一次底层对象是否存在：getPaper 已带 pdf_object_id & pdf_sha256。
  server.post("/papers/:id/export", { preHandler: fromApi }, async (request: FastifyRequest, reply) => {
    const actor = internalServiceContext(request).actor as InternalActor;
    if (!isTeacher(actor as unknown as Principal)) return reply.code(403).send({ error: "teacher principal required" });
    const paperId = String((request.params as { id: unknown }).id ?? "");
    if (!paperId) return reply.code(422).send({ error: "paper id is required" });

    const principal: Principal = { tenantId: actor.tenantId, userId: actor.userId, roles: [...actor.roles] };
    try {
      const paper = await repository.getPaper(principal, paperId);
      if (!paper) return reply.code(404).send({ error: "paper not found" });

      const status = String(paper.status ?? "draft");
      const existingObjectId = typeof paper.pdf_object_id === "string" ? paper.pdf_object_id : null;
      // 已定稿且已有 PDF：成品锁定，直接复用既有对象。
      if (status === "finalized" && existingObjectId) {
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

      const items = Array.isArray(paper.items)
        ? paper.items.slice(0, 200).map((item: Json) => {
            const stemFormat = stringValue(item.stem_format, "open_solution");
            return {
              item_order: typeof item.item_order === "number" ? item.item_order : 0,
              stem_format: stemFormat,
              stem_markdown: stringValue(item.stem_markdown, ""),
              difficulty: typeof item.difficulty === "number" ? item.difficulty : null,
              options: Array.isArray(item.options)
                ? item.options.map((option: Json) => ({ option_key: stringValue(option.option_key, ""), option_text: stringValue(option.option_text, "") }))
                : [],
            };
          })
        : [];
      if (items.length < 1) throw new Error("paper contains no questions to render");

      const renderRes = await runtime.request(
        "content-to-group",
        actor,
        "/internal/paper/render",
        { method: "POST", json: { title: stringValue(paper.title, "数学试卷"), items }, timeoutMs: RENDER_TIMEOUT_MS },
      );
      if (!renderRes.ok) {
        const body = await readJson(renderRes);
        return reply.code(renderRes.status).send({ error: "paper_render_failed", detail: String(body.detail ?? body.error ?? "render failed") });
      }
      const pdf = Buffer.from(await renderRes.arrayBuffer());
      if (pdf.length < 40) return reply.code(502).send({ error: "paper_render_failed", detail: "render returned an empty document" });
      const sha256 = sha256Hex(pdf);

      const title = stringValue(paper.title, "数学试卷");
      const initRes = await runtime.request(
        "content-to-storage",
        actor,
        "/internal/objects/init",
        {
          method: "POST",
          json: { purpose: "paper", mime_type: "application/pdf", byte_size: pdf.length, original_name: `${title}.pdf`, audience: "runtime" },
        },
      );
      if (!initRes.ok) {
        const body = await readJson(initRes);
        return reply.code(initRes.status).send({ error: "paper_store_init_failed", detail: String(body.error ?? "store init failed") });
      }
      const init = await readJson(initRes);
      const objectId = String(init.object_id ?? "");
      const uploadUrl = String(init.upload_url ?? "");
      if (!objectId || !uploadUrl) return reply.code(502).send({ error: "paper_store_init_failed", detail: "missing object_id or upload_url" });

      const uploaded = await fetch(uploadUrl, {
        method: "PUT",
        body: pdf,
        headers: { "content-type": "application/pdf" },
      });
      if (!uploaded.ok && uploaded.status !== 200) {
        return reply.code(502).send({ error: "paper_store_upload_failed", detail: `upload returned ${uploaded.status}` });
      }

      const completeRes = await runtime.request(
        "content-to-storage",
        actor,
        `/internal/objects/${encodeURIComponent(objectId)}/complete`,
        { method: "POST", json: { sha256 } },
      );
      if (!completeRes.ok) {
        return reply.code(completeRes.status).send({ error: "paper_store_complete_failed", detail: "storage verification failed" });
      }

      await repository.setPaperPdf(principal, paperId, objectId, sha256);

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
      request.log.error({ err: error, paperId }, "paper export failed");
      return reply.code(502).send({ error: "paper_export_failed", detail: errorMessage(error) });
    }
  });
}