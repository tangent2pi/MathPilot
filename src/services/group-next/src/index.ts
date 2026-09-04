/**
 * group-next：试卷出片服务的只入边端点。唯一合法调用方是 content-next
 * （content-to-group 边）。把结构化试卷渲染为 PDF 字节返回给调用方落盘。
 */
import { configureInternalService } from "@mathpilot/internal-service";
import { internalServiceGuard } from "@mathpilot/internal-service/fastify";
import Fastify from "fastify";
import { renderAnswerToPdf, renderPaperToPdf, type RenderAnswerItem, type RenderItem, type RenderOption } from "./render.ts";

const MAX_ITEMS = 200;

function optionObject(value: unknown): RenderOption | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return {
    option_key: typeof row.option_key === "string" ? row.option_key.slice(0, 4) : "",
    option_text: typeof row.option_text === "string" ? row.option_text : "",
  };
}

function sanitizeItems(value: unknown): RenderItem[] {
  if (!Array.isArray(value)) throw new Error("items must be an array");
  const items: RenderItem[] = [];
  for (const raw of value.slice(0, MAX_ITEMS)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const stemFormat = typeof row.stem_format === "string" ? row.stem_format : "open_solution";
    const stem = typeof row.stem_markdown === "string" ? row.stem_markdown : "";
    if (stem.trim().length === 0) continue;
    const options: RenderOption[] = Array.isArray(row.options)
      ? row.options.map(optionObject).filter((option): option is RenderOption => option !== null)
      : [];
    items.push({
      stem_format: stemFormat,
      stem_markdown: stem,
      difficulty: typeof row.difficulty === "number" && Number.isFinite(row.difficulty) ? row.difficulty : null,
      options,
    });
  }
  return items;
}

const internalService = configureInternalService("group-next", process.env);
const app = Fastify({ logger: true, bodyLimit: 64 * 1024 * 1024 });

app.get("/healthz", async () => ({ status: "ok", service: "group-next" }));
app.get("/readyz", async () => ({ status: "ready", service: "group-next" }));

const fromContent = internalServiceGuard(internalService, ["content-to-group"]);

app.post("/internal/paper/render", { preHandler: fromContent }, async (request, reply) => {
  const body = (request.body ?? {}) as Record<string, unknown>;
  let items: RenderItem[];
  try {
    items = sanitizeItems(body.items);
  } catch (error) {
    return reply.code(422).send({ error: "paper_render_rejected", detail: error instanceof Error ? error.message : String(error) });
  }
  if (items.length < 1) return reply.code(422).send({ error: "paper contains no renderable questions" });
  const title = typeof body.title === "string" ? body.title : "数学试卷";
  try {
    const pdf = await renderPaperToPdf({ title, items });
    reply
      .header("content-type", "application/pdf")
      .header("content-disposition", "inline; filename=\"paper.pdf\"");
    return reply.send(pdf);
  } catch (error) {
    request.log.error({ err: error }, "paper render failed");
    return reply.code(500).send({ error: "paper_render_failed", detail: error instanceof Error ? error.message : String(error) });
  }
});

function sanitizeAnswerItems(value: unknown): RenderAnswerItem[] {
  if (!Array.isArray(value)) throw new Error("items must be an array");
  const items: RenderAnswerItem[] = [];
  for (const raw of value.slice(0, MAX_ITEMS)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const stemFormat = typeof row.stem_format === "string" ? row.stem_format : "open_solution";
    const stem = typeof row.stem_markdown === "string" ? row.stem_markdown : "";
    if (stem.trim().length === 0) continue;
    const options: RenderOption[] = Array.isArray(row.options)
      ? row.options.map(optionObject).filter((option): option is RenderOption => option !== null)
      : [];
    items.push({
      item_order: typeof row.item_order === "number" && Number.isInteger(row.item_order) ? row.item_order : items.length,
      stem_format: stemFormat,
      stem_markdown: stem,
      options,
      answer_text: typeof row.answer_text === "string" ? row.answer_text : "",
      analysis_text: typeof row.analysis_text === "string" ? row.analysis_text : "",
    });
  }
  return items;
}

app.post("/internal/paper/answer-render", { preHandler: fromContent }, async (request, reply) => {
  const body = (request.body ?? {}) as Record<string, unknown>;
  let items: RenderAnswerItem[];
  try {
    items = sanitizeAnswerItems(body.items);
  } catch (error) {
    return reply.code(422).send({ error: "paper_answer_render_rejected", detail: error instanceof Error ? error.message : String(error) });
  }
  if (items.length < 1) return reply.code(422).send({ error: "paper contains no renderable answer items" });
  const title = typeof body.title === "string" ? body.title : "数学试卷";
  try {
    const pdf = await renderAnswerToPdf({ title, items });
    reply
      .header("content-type", "application/pdf")
      .header("content-disposition", "inline; filename=\"answer.pdf\"");
    return reply.send(pdf);
  } catch (error) {
    request.log.error({ err: error }, "paper answer render failed");
    return reply.code(500).send({ error: "paper_answer_render_failed", detail: error instanceof Error ? error.message : String(error) });
  }
});

await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 3018) });