/**
 * content-next OCR 入口：教师上传题目图片/PDF → AI Studio PaddleOCR → 落库
 * content_source_document + content_source_fragment。
 *
 * 传输：multipart/form-data 单文件（由 api-next 的 /api/content/* 同源转发进来，
 * guard 使用 api-to-content 通道）。文件字节不经对象存储，直接送 OCR provider，
 * 因此本服务不需要 content-to-storage 边。
 */
import { createHash } from "node:crypto";
import type { InternalServiceRuntime } from "@mathpilot/internal-service";
import { internalServiceContext, internalServiceGuard } from "@mathpilot/internal-service/fastify";
import { createAistudioOcrClient, type OcrPageOut, type OcrResult } from "@mathpilot/providers-ocr";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { isTeacher, newId, stringValue, withPrincipal, type Principal } from "./lib.ts";

const MAX_FILE_BYTES = 40 * 1024 * 1024;
const ALLOWED_KINDS = new Set(["pdf", "handout", "exercise_set", "error_summary", "web_page"]);

interface OcrConfig {
  baseUrl: string;
  apiToken: string;
  model: string;
}

function ocrConfig(): OcrConfig | null {
  const baseUrl = stringValue(process.env.OCR_API_BASE);
  const apiToken = stringValue(process.env.OCR_API_TOKEN);
  const model = stringValue(process.env.OCR_MODEL);
  return baseUrl && apiToken && model ? { baseUrl, apiToken, model } : null;
}

const sha256Hex = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function mimeToKind(mime: string): string {
  if (mime === "application/pdf") return "pdf";
  return "handout";
}

/** 页面主导块类型：整页都是图片区域则归为 image_region，否则按段落处理 */
function pageFragmentType(page: OcrPageOut): string {
  if (page.blocks.length > 0 && page.blocks.every((block) => block.block_type === "image_region")) return "image_region";
  return "paragraph";
}

function pageBbox(page: OcrPageOut): number[] | null {
  for (const block of page.blocks) {
    if (block.bbox && block.bbox.length === 4) return [...block.bbox];
  }
  return null;
}

interface OcrOutcome {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

async function runOcr(bytes: Buffer, filename: string, mimeType: string, config: OcrConfig): Promise<OcrResult> {
  const client = createAistudioOcrClient({
    baseUrl: config.baseUrl,
    apiToken: config.apiToken,
    model: config.model,
    pollIntervalMs: 4_000,
    pollTimeoutMs: 150_000,
  });
  return client.parse(bytes.toString("base64"), filename, undefined, 1, mimeType);
}

export function registerOcrRoutes(
  server: FastifyInstance,
  pool: pg.Pool,
  runtime: InternalServiceRuntime,
): void {
  const fromApi = internalServiceGuard(runtime, ["api-to-content"]);

  server.post("/ocr", { preHandler: fromApi }, async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const actor = internalServiceContext(request).actor as Principal;
    if (!isTeacher(actor)) return reply.code(403).send({ error: "teacher principal required" });

    const config = ocrConfig();
    if (!config) {
      return reply.code(503).send({ error: "ocr_not_configured", detail: "OCR_API_BASE, OCR_API_TOKEN and OCR_MODEL must be set on content-next" });
    }

    const file = await request.file();
    if (!file) return reply.code(422).send({ error: "a file upload is required" });
    if (file.file.truncated) return reply.code(413).send({ error: "file exceeds the 40MB limit" });
    const bytes = await file.toBuffer();
    if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) {
      return reply.code(422).send({ error: "file must be between 1 byte and 40MB" });
    }
    const filename = stringValue(file.filename, "upload");
    const mimeType = stringValue(file.mimetype, "application/octet-stream").split(";")[0]!.toLowerCase();
    const kind = mimeToKind(mimeType);
    const originalHash = `sha256:${sha256Hex(bytes)}`;

    const result = await runOcr(bytes, filename, mimeType, config);

    const stored = await withPrincipal(pool, actor, async (client) => {
      const existing = await client.query<{ document_id: string }>(
        `select document_id from content_source_document where tenant_id=$1 and original_hash=$2`,
        [actor.tenantId, originalHash],
      );
      if (existing.rows[0]) {
        return { documentId: existing.rows[0].document_id, reused: true, fragments: [] as Array<Record<string, unknown>> };
      }
      const documentId = newId("doc");
      const payloadDocument = result.ok
        ? { mime_type: mimeType, byte_size: bytes.length, original_name: filename, ocr_provider_trace: { provider: "aistudio", model: config.model } }
        : { mime_type: mimeType, byte_size: bytes.length, original_name: filename, error: result.message };
      await client.query(
        `insert into content_source_document(document_id,tenant_id,kind,original_hash,storage_ref,ocr_status,uploaded_by,payload)
         values($1,$2,$3,$4,null,$5,$6,$7)`,
        [documentId, actor.tenantId, kind, originalHash, result.ok ? "parsed" : "failed", actor.userId, JSON.stringify(payloadDocument)],
      );
      const fragments: Array<Record<string, unknown>> = [];
      if (result.ok) {
        for (const page of result.pages) {
          const fragmentId = newId("frg");
          const markdownHash = sha256Hex(Buffer.from(page.markdown, "utf8"));
          const payload = {
            markdown: page.markdown,
            blocks: page.blocks,
            images: page.images,
          };
          await client.query(
            `insert into content_source_fragment(fragment_id,tenant_id,document_id,page_no,fragment_type,bbox,content_hash,payload)
             values($1,$2,$3,$4,$5,$6,$7,$8)`,
            [fragmentId, actor.tenantId, documentId, page.page_no, pageFragmentType(page), pageBbox(page), markdownHash, JSON.stringify(payload)],
          );
          fragments.push({ fragment_id: fragmentId, page_no: page.page_no, fragment_type: pageFragmentType(page), content_hash: markdownHash });
        }
      }
      return { documentId, reused: false, fragments };
    });

    if (!result.ok) {
      return reply.code(502).send({ error: result.code, detail: result.message, document_id: stored.documentId, ocr_status: "failed" });
    }
    return {
      document_id: stored.documentId,
      ocr_status: "parsed",
      reused: stored.reused,
      page_count: result.pages.length,
      fragments: stored.fragments,
      pages: result.pages.map((page) => ({ page_no: page.page_no, markdown: page.markdown })),
    };
  });
}
