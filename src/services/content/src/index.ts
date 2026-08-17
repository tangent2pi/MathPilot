/**
 * content-service：内容生产线（设计 §7）。
 *
 * UPLOAD → KTQ_EXTRACTION_RUN → ER_RESEARCH_RUN → REVIEW（review-service 队列）→ PUBLISH
 *
 * - KTQ 与 ER 是两次独立 run（独立 agent_run_id、独立 Pi Agent Session，无共享模型历史；
 *   经 @agmath/providers-model 调用 agent-runtime，见设计 §4.1/§7.2）；
 * - OCR 经 @agmath/providers-ocr（PaddleOCR 官方 API，job 模式；本地/MCP 模式为同接口适配器）；
 * - 每个正式语义字段写 content_field_lineage（来源片段/Agent Run/模型/Prompt/审核决定）；
 * - 发布前置门：复核任务全部裁决 + 发布校验（measurement_targets 非空、血缘完整等）；
 * - ChapterPackage 不可变（manifest_hash 内容寻址）。
 */
import { createHash } from "node:crypto";
import { startService, createPool, withTenant, newId } from "./lib.ts";
import { createAgentRuntimeClient, type TaskResult } from "@agmath/providers-model";
import { createAistudioOcrClient } from "@agmath/providers-ocr";

const pool = createPool(process.env.DATABASE_URL ?? "postgres://localhost:5432/agmath");
const REVIEW_URL = process.env.REVIEW_URL ?? "http://localhost:3008";
const AGENT_RUNTIME_URL = process.env.AGENT_RUNTIME_URL ?? "http://localhost:3005";

// OCR 供应商凭据由本服务（宿主侧）从环境注入；沙箱/前端不持有（设计 §4.4/§16.1）
const OCR_API_BASE = (process.env.OCR_API_BASE ?? "https://paddleocr.aistudio-app.com").replace(/\/$/, "");
const OCR_API_TOKEN = process.env.OCR_API_TOKEN ?? "";
const OCR_MODEL = process.env.OCR_MODEL ?? "PaddleOCR-VL-1.6";

const runtime = createAgentRuntimeClient({ baseUrl: AGENT_RUNTIME_URL });
const ocrClient = createAistudioOcrClient({ baseUrl: OCR_API_BASE, apiToken: OCR_API_TOKEN, model: OCR_MODEL });

function tenantOf(req: { headers: Record<string, unknown> }): string | null {
  const t = req.headers["x-tenant-id"];
  return typeof t === "string" && t.length > 0 ? t : null;
}
function actorOf(req: { headers: Record<string, unknown> }): string | null {
  const u = req.headers["x-user-id"];
  return typeof u === "string" && u.length > 0 ? u : null;
}

/**
 * 题目框启发式（确定性导航，非语义判定，设计 §6.2 的程序先导航思想）：
 * 为 OCR 段落标注候选题块；语义判定由 KTQ 抽取 Agent 完成。
 */
function looksLikeQuestion(text: string): boolean {
  if (text.length < 10) return false;
  const hasAsk = /(求|则|等于|多少|判断|证明)/.test(text);
  const hasSetup = /(已知|在\s*△|三角形\s*ABC|设)/.test(text);
  const numbered = /^\s*(\d+[.、．]|[（(]\d+[)）]|【?[例习变]题?\s*\d*】?)/.test(text);
  return (hasAsk && hasSetup) || (numbered && hasAsk);
}

interface FragmentIn {
  page_no: number;
  fragment_type: "paragraph" | "question_box" | "image_region" | "table" | "heading";
  text_markdown?: string;
  bbox?: [number, number, number, number];
}

interface DocumentBody {
  kind: string;
  original_hash: string;
  storage_ref: string;
  mime_type?: string;
  fragments: FragmentIn[];
}

/** 血缘行写入（设计 §7.3：每个正式语义字段一行） */
async function insertLineage(
  c: { query: (q: string, v?: unknown[]) => Promise<unknown> },
  row: {
    tenant_id: string;
    entity_type: string;
    entity_id: string;
    field_path: string;
    provenance_status: "direct" | "derived" | "model_generated" | "human_authored";
    derivation_type: string;
    source_fragment_id?: string | null;
    agent_run_id?: string | null;
    prompt_version?: string | null;
    model_id?: string | null;
    reviewer_id?: string | null;
    review_decision?: string | null;
    confidence?: number | null;
  },
): Promise<void> {
  await c.query(
    `insert into content_field_lineage
       (tenant_id, entity_type, entity_id, field_path, provenance_status, derivation_type,
        source_fragment_id, agent_run_id, prompt_version, model_id, reviewer_id, review_decision, confidence)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [row.tenant_id, row.entity_type, row.entity_id, row.field_path, row.provenance_status,
     row.derivation_type, row.source_fragment_id ?? null, row.agent_run_id ?? null,
     row.prompt_version ?? null, row.model_id ?? null, row.reviewer_id ?? null,
     row.review_decision ?? null, row.confidence ?? null],
  );
}

/**
 * KTQ 抽取 run：经 agent-runtime 创建独立 KTQ Extraction Agent Session
 * （只见 question_box 片段与 KTQ Schema，无 ER 材料）→ 结构化题目落 staging + 字段血缘。
 * 题目与片段的对应关系由抽取 Agent 在输出中声明（source_fragment_id），
 * 服务层只做存在性校验，不做轮转猜测（设计 §7.3 血缘不得伪造）。
 * 失败显式 502，不伪造抽取结果。
 */
async function ktqRunModel(
  req: { headers: Record<string, unknown>; body: unknown },
  reply: { code(n: number): { send(x: unknown): void } },
): Promise<void> {
  const tenantId = tenantOf(req);
  if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
  const { document_id: documentId, chapter_id: chapterId } = req.body as { document_id: string; chapter_id: string };
  if (!documentId || !chapterId) return reply.code(422).send({ error: "document_id and chapter_id required" });
  const agentRunId = `run_ktq_${newId("x").slice(2)}`;

  const fragments = await withTenant(pool, tenantId, async (c) => {
    const r = await c.query(
      `select f.fragment_id, f.page_no, f.payload->>'text_markdown' as text
         from content_source_fragment f
        where f.document_id = $1 and f.fragment_type = 'question_box'
        order by f.page_no, (f.payload->>'bbox')`,
      [documentId],
    );
    return r.rows as { fragment_id: string; page_no: number; text: string }[];
  });
  if (fragments.length === 0) return reply.code(422).send({ error: "no question_box fragments in document" });

  const gen = await runtime.runTask({
    taskType: "ktq_extract",
    sessionRef: agentRunId,
    tenantId,
    context: {
      fragments: JSON.stringify(fragments.map((f) => ({ fragment_id: f.fragment_id, page_no: f.page_no, text: f.text }))),
    },
  });
  if (!gen.ok) {
    return reply.code(gen.status).send({ error: "extraction_failed", detail: gen.detail ?? gen.error });
  }
  if (gen.outputJson === undefined) {
    return reply.code(502).send({ error: "extraction_failed", detail: "agent 未产出结构化结果" });
  }
  const parsed = gen.outputJson as {
    questions?: {
      source_fragment_id?: string;
      stem_markdown?: string; answer_summary?: string;
      knowledge_components?: { id?: string; name?: string }[];
      question_type?: { id?: string; name?: string };
      measurement_targets?: { dim?: string; role?: string; evidence_rule?: string }[];
      rubric?: { id?: string; description?: string }[];
    }[];
  };
  const questions = (parsed.questions ?? []).filter((q) => q.stem_markdown && (q.measurement_targets?.length ?? 0) > 0);
  if (questions.length === 0) return reply.code(502).send({ error: "extraction_empty", detail: "模型未产出有效题目" });

  // 模型声明的片段关联必须真实存在（设计 §7.3：血缘不得伪造）
  const knownFragmentIds = new Set(fragments.map((f) => f.fragment_id));
  const modelImpl = gen.implementation ?? "pi.unknown";

  const out = await withTenant(pool, tenantId, async (c) => {
    const seqBase = await c.query("select count(*)::int as n from content_question where chapter_id = $1", [chapterId]);
    let seq: number = seqBase.rows[0].n;
    const prefix = (chapterId.replace(/^chap_/, "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3) || "GEN");
    const staged: { question_id: string }[] = [];

    for (const q of questions) {
      const srcFragment = knownFragmentIds.has(q.source_fragment_id ?? "") ? q.source_fragment_id! : null;

      const kcs: { id: string; name: string }[] = [];
      for (const k of q.knowledge_components ?? []) {
        if (!k.id || !k.name) continue;
        kcs.push({ id: k.id, name: k.name });
        await c.query(
          `insert into content_knowledge_component (dimension_id, tenant_id, name, payload)
           values ($1,$2,$3,$4) on conflict (dimension_id) do nothing`,
          [k.id, tenantId, k.name, JSON.stringify({ dimension_id: k.id, name: k.name })],
        );
        await insertLineage(c, {
          tenant_id: tenantId, entity_type: "knowledge_component", entity_id: k.id,
          field_path: "/name", provenance_status: "model_generated", derivation_type: "extraction_agent",
          source_fragment_id: srcFragment, agent_run_id: agentRunId,
          prompt_version: gen.promptVersion ?? "unknown", model_id: modelImpl, confidence: 0.85,
        });
      }
      if (q.question_type?.id && q.question_type.name) {
        await c.query(
          `insert into content_question_type (dimension_id, tenant_id, name, payload)
           values ($1,$2,$3,$4) on conflict (dimension_id) do nothing`,
          [q.question_type.id, tenantId, q.question_type.name,
           JSON.stringify({ dimension_id: q.question_type.id, name: q.question_type.name })],
        );
        await insertLineage(c, {
          tenant_id: tenantId, entity_type: "question_type", entity_id: q.question_type.id,
          field_path: "/name", provenance_status: "model_generated", derivation_type: "extraction_agent",
          source_fragment_id: srcFragment, agent_run_id: agentRunId,
          prompt_version: gen.promptVersion ?? "unknown", model_id: modelImpl, confidence: 0.85,
        });
      }

      seq += 1;
      const questionId = `Q_${prefix}_${String(seq).padStart(3, "0")}`;
      const measurementTargets = q.measurement_targets!.map((m) => ({
        dim: m.dim!, role: m.role as "primary" | "secondary" | "prerequisite", evidence_rule: m.evidence_rule!,
      }));
      const rubricItems = (q.rubric ?? []).map((r) => ({
        id: r.id, description: r.description, score_weight: 0.5, evidence_rule: r.id,
      }));
      const payload = {
        question_id: questionId, tenant_id: tenantId, chapter_id: chapterId, question_version: 1,
        stem_markdown: q.stem_markdown, stem_format: "open_solution",
        answer: { summary: q.answer_summary ?? "" },
        rubric: { items: rubricItems },
        tags: kcs.map((k) => k.id),
        measurement_targets: measurementTargets,
        provenance: [
          { entity_type: "question", entity_id: questionId, field_path: "/stem_markdown",
            provenance_status: "model_generated", derivation_type: "extraction_agent",
            source_fragment_id: srcFragment, agent_run_id: agentRunId,
            prompt_version: gen.promptVersion ?? "unknown", model_id: modelImpl, created_at: new Date().toISOString() },
        ],
      };
      await c.query(
        `insert into content_question
           (question_id, tenant_id, chapter_id, question_version, stem_format, tags,
            measurement_dims, published, payload)
         values ($1,$2,$3,1,'open_solution',$4,$5,false,$6)`,
        [questionId, tenantId, chapterId, kcs.map((k) => k.id),
         measurementTargets.map((m) => m.dim), JSON.stringify(payload)],
      );
      for (const m of measurementTargets) {
        await c.query(
          `insert into content_measurement_target (tenant_id, question_id, dim, role, evidence_rule)
           values ($1,$2,$3,$4,$5)`,
          [tenantId, questionId, m.dim, m.role, m.evidence_rule],
        );
      }
      await insertLineage(c, {
        tenant_id: tenantId, entity_type: "question", entity_id: questionId,
        field_path: "/stem_markdown", provenance_status: "model_generated", derivation_type: "extraction_agent",
        source_fragment_id: srcFragment, agent_run_id: agentRunId,
        prompt_version: gen.promptVersion ?? "unknown", model_id: modelImpl, confidence: 0.85,
      });
      await insertLineage(c, {
        tenant_id: tenantId, entity_type: "question", entity_id: questionId,
        field_path: "/measurement_targets", provenance_status: "model_generated", derivation_type: "extraction_agent",
        source_fragment_id: srcFragment, agent_run_id: agentRunId,
        prompt_version: gen.promptVersion ?? "unknown", model_id: modelImpl, confidence: 0.8,
      });
      await insertLineage(c, {
        tenant_id: tenantId, entity_type: "question", entity_id: questionId,
        field_path: "/rubric", provenance_status: "model_generated", derivation_type: "extraction_agent",
        source_fragment_id: srcFragment, agent_run_id: agentRunId,
        prompt_version: gen.promptVersion ?? "unknown", model_id: modelImpl, confidence: 0.8,
      });
      staged.push({ question_id: questionId });
    }
    return { status: 200 as const, body: { agent_run_id: agentRunId, staged, frozen: true, extractor: modelImpl } };
  });

  if (out.status === 200) {
    for (const s of (out.body as { staged: { question_id: string }[] }).staged) {
      const res = await fetch(`${REVIEW_URL}/review/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-id": tenantId },
        body: JSON.stringify({ queue: "content", target_type: "question", target_id: s.question_id }),
      }).catch(() => null);
      if (!res?.ok) {
        return reply.code(502).send({ error: "review_task_registration_failed", question_id: s.question_id });
      }
      (out.body as { staged: { question_id: string; review_task_id?: string }[] }).staged
        .find((x) => x.question_id === s.question_id)!.review_task_id = ((await res.json()) as { task_id: string }).task_id;
    }
  }
  return reply.code(out.status).send(out.body);
}

/**
 * ER 调研 run：经 agent-runtime 创建独立 ER Research Agent Session
 * （只见冻结 KTQ 只读投影，不见 KTQ 抽取过程与候选）→ 输出 E/R + 血缘。
 */
async function erRunModel(
  req: { headers: Record<string, unknown>; body: unknown },
  reply: { code(n: number): { send(x: unknown): void } },
): Promise<void> {
  const tenantId = tenantOf(req);
  if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
  const { chapter_id: chapterId } = req.body as { chapter_id: string };
  if (!chapterId) return reply.code(422).send({ error: "chapter_id required" });
  const agentRunId = `run_er_${newId("x").slice(2)}`;

  const frozen = await withTenant(pool, tenantId, async (c) => {
    const r = await c.query(
      `select q.question_id, q.payload->>'stem_markdown' as stem
         from content_question q
        where q.chapter_id = $1 and not q.published`,
      [chapterId],
    );
    return r.rows as { question_id: string; stem: string }[];
  });
  if (frozen.length === 0) return reply.code(422).send({ error: "no frozen KTQ staging for chapter" });

  const gen = await runtime.runTask({
    taskType: "er_research",
    sessionRef: agentRunId,
    tenantId,
    context: { frozenProjection: JSON.stringify(frozen) },
  });
  if (!gen.ok) {
    return reply.code(gen.status).send({ error: "research_failed", detail: gen.detail ?? gen.error });
  }
  if (gen.outputJson === undefined) {
    return reply.code(502).send({ error: "research_failed", detail: "agent 未产出结构化结果" });
  }
  const parsed = gen.outputJson as {
    error_causes?: { id?: string; name?: string; description?: string }[];
    diagnosis_rules?: { id?: string; trigger?: string; candidate_error_causes?: string[]; probe?: string }[];
  };
  const errorCauses = (parsed.error_causes ?? []).filter(
    (e): e is { id: string; name: string; description?: string } => Boolean(e.id && e.name),
  );
  const rules = (parsed.diagnosis_rules ?? []).filter(
    (r): r is { id: string; trigger: string; candidate_error_causes?: string[]; probe?: string } => Boolean(r.id && r.trigger),
  );
  if (errorCauses.length === 0 && rules.length === 0) {
    return reply.code(502).send({ error: "research_empty", detail: "模型未产出有效错因/规则" });
  }
  const modelImpl = gen.implementation ?? "pi.unknown";

  const out = await withTenant(pool, tenantId, async (c) => {
    for (const ec of errorCauses) {
      await c.query(
        `insert into content_error_cause (dimension_id, tenant_id, name, payload)
         values ($1,$2,$3,$4) on conflict (dimension_id) do nothing`,
        [ec.id, tenantId, ec.name, JSON.stringify({ dimension_id: ec.id, name: ec.name, description: ec.description ?? "" })],
      );
      await insertLineage(c, {
        tenant_id: tenantId, entity_type: "error_cause", entity_id: ec.id,
        field_path: "/name", provenance_status: "model_generated", derivation_type: "research_agent",
        agent_run_id: agentRunId, prompt_version: gen.promptVersion ?? "unknown", model_id: modelImpl, confidence: 0.8,
      });
    }
    for (const r of rules) {
      await c.query(
        `insert into content_diagnosis_rule (rule_id, tenant_id, rule_version, payload)
         values ($1,$2,'0.1.0',$3) on conflict (rule_id) do nothing`,
        [r.id, tenantId, JSON.stringify({
          rule_id: r.id, trigger: r.trigger, candidate_error_causes: r.candidate_error_causes ?? [],
          probe: r.probe ?? "",
        })],
      );
      await insertLineage(c, {
        tenant_id: tenantId, entity_type: "diagnosis_rule", entity_id: r.id,
        field_path: "/trigger", provenance_status: "model_generated", derivation_type: "research_agent",
        agent_run_id: agentRunId, prompt_version: gen.promptVersion ?? "unknown", model_id: modelImpl, confidence: 0.8,
      });
    }
    return {
      status: 200 as const,
      body: { agent_run_id: agentRunId, error_causes: errorCauses.map((e) => e.id), rules: rules.map((r) => r.id), extractor: modelImpl },
    };
  });
  return reply.code(out.status).send(out.body);
}

startService({
  name: "content",
  port: Number(process.env.PORT ?? 3006),
  register(app) {
    /** A1: 文档登记（原件字节走对象存储，骨架仅登记引用与片段） */
    app.post("/documents", async (req, reply) => {
      const tenantId = tenantOf(req);
      const actor = actorOf(req);
      if (!tenantId || !actor) return reply.code(400).send({ error: "missing tenant/actor headers" });
      const body = req.body as DocumentBody;
      if (!/^sha256:[0-9a-f]{64}$/.test(body.original_hash ?? "")) {
        return reply.code(422).send({ error: "original_hash must be sha256:<64 hex>" });
      }
      if (!Array.isArray(body.fragments) || body.fragments.length === 0) {
        return reply.code(422).send({ error: "at least one fragment required" });
      }
      const documentId = newId("doc");
      const out = await withTenant(pool, tenantId, async (c) => {
        const dup = await c.query(
          "select document_id from content_source_document where original_hash = $1",
          [body.original_hash],
        );
        if (dup.rows.length > 0) {
          return { status: 409 as const, body: { error: "duplicate document", document_id: dup.rows[0].document_id } };
        }
        await c.query(
          `insert into content_source_document
             (document_id, tenant_id, kind, original_hash, storage_ref, ocr_status, uploaded_by, payload)
           values ($1,$2,$3,$4,$5,'parsed',$6,$7)`,
          [documentId, tenantId, body.kind, body.original_hash, body.storage_ref, actor,
           JSON.stringify({ document_id: documentId, tenant_id: tenantId, kind: body.kind,
             original_hash: body.original_hash, storage_ref: body.storage_ref,
             mime_type: body.mime_type, uploaded_by: actor, uploaded_at: new Date().toISOString(),
             ocr_status: "parsed" })],
        );
        const fragmentIds: string[] = [];
        for (const f of body.fragments) {
          const fragmentId = newId("frg");
          fragmentIds.push(fragmentId);
          await c.query(
            `insert into content_source_fragment
               (fragment_id, tenant_id, document_id, page_no, fragment_type, bbox, content_hash, payload)
             values ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [fragmentId, tenantId, documentId, f.page_no, f.fragment_type, f.bbox ?? null,
             `sha256:${createHash("sha256").update(f.text_markdown ?? "").digest("hex")}`,
             JSON.stringify({ fragment_id: fragmentId, document_id: documentId, page_no: f.page_no,
               fragment_type: f.fragment_type, text_markdown: f.text_markdown, bbox: f.bbox })],
          );
        }
        return { status: 201 as const, body: { document_id: documentId, fragment_ids: fragmentIds } };
      });
      return reply.code(out.status).send(out.body);
    });

    /** A1b: 真实文档 OCR 入库（经 providers/ocr 调 PaddleOCR 官方 API；密钥来自本服务 env）。
     *  字节的对象存储持久化在 minio 接线后补齐——payload 显式标注 bytes_persisted:false。 */
    app.post("/documents/ocr", async (req, reply) => {
      const tenantId = tenantOf(req);
      const actor = actorOf(req);
      if (!tenantId || !actor) return reply.code(400).send({ error: "missing tenant/actor headers" });
      const body = req.body as {
        kind?: string; file_base64?: string; filename?: string;
        mime_type?: string; page_ranges?: string; page_start?: number;
      };
      if (!body.file_base64) return reply.code(422).send({ error: "file_base64 required" });
      const bytes = Buffer.from(body.file_base64, "base64");
      if (bytes.length === 0 || bytes.length > 20 * 1024 * 1024) {
        return reply.code(422).send({ error: "file empty or exceeds 20MiB" });
      }
      const originalHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

      const dup = await withTenant(pool, tenantId, async (c) => {
        const r = await c.query("select document_id from content_source_document where original_hash = $1", [originalHash]);
        return r.rows[0];
      });
      if (dup) return reply.code(409).send({ error: "duplicate document", document_id: dup.document_id });

      const result = await ocrClient.parse(
        body.file_base64,
        body.filename ?? "upload.pdf",
        body.page_ranges,
        body.page_start ?? 1,
      );
      if (!result.ok) {
        // 可重试（限流/网络）→ 503；输入/任务级失败 → 502；不伪造解析结果
        return reply.code(result.kind === "fatal" ? 502 : 503).send({
          error: "ocr_failed",
          code: result.code,
          message: result.message,
        });
      }
      const implementation = `ocr.aistudio.${OCR_MODEL}`;
      const documentId = newId("doc");
      const out = await withTenant(pool, tenantId, async (c) => {
        await c.query(
          `insert into content_source_document
             (document_id, tenant_id, kind, original_hash, storage_ref, ocr_status, uploaded_by, payload)
           values ($1,$2,$3,$4,$5,'parsed',$6,$7)`,
          [documentId, tenantId, body.kind ?? "exercise_set", originalHash,
           `dev/ocr-upload/${originalHash.slice(7, 23)}`, actor,
           JSON.stringify({
             document_id: documentId, tenant_id: tenantId, kind: body.kind ?? "exercise_set",
             original_hash: originalHash, mime_type: body.mime_type ?? "application/pdf",
             uploaded_by: actor, uploaded_at: new Date().toISOString(), ocr_status: "parsed",
             ocr: { implementation, parser_version: `${OCR_MODEL}@api-v2` },
             num_pages: result.pages.length,
             bytes_persisted: false,
           })],
        );
        const fragments: { fragment_id: string; page_no: number; fragment_type: string; chars: number }[] = [];
        for (const page of result.pages) {
          for (const block of page.blocks) {
            const text = block.markdown.trim();
            if (!text) continue;
            const fragmentType =
              block.block_type !== "paragraph" ? block.block_type
              : looksLikeQuestion(text) ? "question_box" : "paragraph";
            const fragmentId = newId("frg");
            await c.query(
              `insert into content_source_fragment
                 (fragment_id, tenant_id, document_id, page_no, fragment_type, bbox, content_hash, payload)
               values ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [fragmentId, tenantId, documentId, page.page_no, fragmentType, block.bbox,
               `sha256:${createHash("sha256").update(text).digest("hex")}`,
               JSON.stringify({ fragment_id: fragmentId, document_id: documentId, page_no: page.page_no,
                 fragment_type: fragmentType, text_markdown: text, bbox: block.bbox })],
            );
            fragments.push({ fragment_id: fragmentId, page_no: page.page_no, fragment_type: fragmentType, chars: text.length });
          }
        }
        return { status: 201 as const, body: {
          document_id: documentId,
          original_hash: originalHash,
          ocr_implementation: implementation,
          pages: result.pages.map((p) => ({ page_no: p.page_no, markdown_chars: p.markdown.length })),
          fragments,
          question_box_count: fragments.filter((f) => f.fragment_type === "question_box").length,
        } };
      });
      return reply.code(out.status).send(out.body);
    });

    /** A2: KTQ 独立抽取 run（经 agent-runtime：KTQ Extraction Agent Session） */
    app.post("/ktq/run", (req, reply) => ktqRunModel(req, reply));

    /** A3: ER 独立调研 run（经 agent-runtime：ER Research Agent Session） */
    app.post("/er/run", (req, reply) => erRunModel(req, reply));

    /** A4: 发布不可变章节包（复核门 + 发布校验 + 血缘补记审核决定） */
    app.post("/publish", async (req, reply) => {
      const tenantId = tenantOf(req);
      const actor = actorOf(req);
      if (!tenantId || !actor) return reply.code(400).send({ error: "missing tenant/actor headers" });
      const { chapter_id: chapterId, version } = req.body as { chapter_id: string; version: string };
      if (!chapterId || !/^\d+\.\d+\.\d+$/.test(version ?? "")) {
        return reply.code(422).send({ error: "chapter_id and semver version required" });
      }

      // 复核门：content 队列尚有 pending 任务时不得发布
      const gate = await fetch(`${REVIEW_URL}/review/tasks?queue=content`, {
        headers: { "x-tenant-id": tenantId },
        signal: AbortSignal.timeout(10_000),
      });
      if (!gate.ok) return reply.code(502).send({ error: "review_unreachable" });
      const gateJson = (await gate.json()) as { pending_count: number };
      if (gateJson.pending_count > 0) {
        return reply.code(422).send({ error: "pending_review_tasks", pending_count: gateJson.pending_count });
      }

      const packageId = newId("pkg");
      const now = new Date().toISOString();
      const out = await withTenant(pool, tenantId, async (c) => {
        const qs = await c.query(
          "select question_id, payload from content_question where chapter_id = $1 and not published",
          [chapterId],
        );
        if (qs.rows.length === 0) return { status: 422 as const, body: { error: "nothing staged for chapter" } };

        const questionIds: string[] = qs.rows.map((r) => r.question_id);
        const mtCount = await c.query(
          "select question_id, count(*)::int as n from content_measurement_target where question_id = any($1) group by question_id",
          [questionIds],
        );
        const mtByQ = new Map<string, number>(mtCount.rows.map((r) => [r.question_id, r.n]));
        const lineageCount = await c.query(
          `select entity_id, count(*)::int as n from content_field_lineage
            where entity_type = 'question' and entity_id = any($1) group by entity_id`,
          [questionIds],
        );
        const linByQ = new Map<string, number>(lineageCount.rows.map((r) => [r.entity_id, r.n]));
        const kcs = await c.query("select dimension_id from content_knowledge_component", []);
        const qts = await c.query("select dimension_id from content_question_type", []);
        const ecs = await c.query("select dimension_id from content_error_cause", []);
        const rules = await c.query("select rule_id from content_diagnosis_rule", []);
        const knownDims = new Set<string>([
          ...kcs.rows.map((r) => r.dimension_id),
          ...qts.rows.map((r) => r.dimension_id),
          ...ecs.rows.map((r) => r.dimension_id),
        ]);
        const allDims = await c.query(
          "select distinct dim from content_measurement_target where question_id = any($1)",
          [questionIds],
        );

        const checks = [
          { check: "id_uniqueness", passed: new Set(questionIds).size === questionIds.length },
          { check: "measurement_targets_nonempty", passed: questionIds.every((q) => (mtByQ.get(q) ?? 0) > 0) },
          { check: "provenance_complete", passed: questionIds.every((q) => (linByQ.get(q) ?? 0) > 0) },
          { check: "references_exist", passed: allDims.rows.every((r) => knownDims.has(r.dim)) },
          { check: "answer_rubric_complete", passed: qs.rows.every((r) => r.payload?.answer && (r.payload?.rubric?.items?.length ?? 0) > 0) },
        ];
        const passed = checks.every((ck) => ck.passed);
        if (!passed) return { status: 422 as const, body: { error: "publish_validation_failed", validation_report: { passed, checks } } };

        const contents = {
          knowledge_components: kcs.rows.map((r) => r.dimension_id),
          question_types: qts.rows.map((r) => r.dimension_id),
          error_causes: ecs.rows.map((r) => r.dimension_id),
          questions: questionIds,
          diagnosis_rules: rules.rows.map((r) => r.rule_id),
        };
        const manifestHash = `sha256:${createHash("sha256").update(JSON.stringify(contents)).digest("hex")}`;
        const dup = await c.query("select 1 from content_chapter_package where tenant_id = $1 and version = $2", [tenantId, version]);
        if (dup.rows.length > 0) return { status: 409 as const, body: { error: "version already published" } };

        const packagePayload = {
          package_id: packageId, tenant_id: tenantId, version, manifest_hash: manifestHash,
          contents, validation_report: { passed, checks }, published_by: actor, published_at: now,
        };
        await c.query(
          `insert into content_chapter_package
             (package_id, tenant_id, version, manifest_hash, published_by, published_at, payload)
           values ($1,$2,$3,$4,$5,now(),$6)`,
          [packageId, tenantId, version, manifestHash, actor, JSON.stringify(packagePayload)],
        );
        await c.query("update content_question set published = true where question_id = any($1)", [questionIds]);
        for (const q of questionIds) {
          await insertLineage(c, {
            tenant_id: tenantId, entity_type: "question", entity_id: q,
            field_path: "/published", provenance_status: "human_authored", derivation_type: "teacher_edit",
            reviewer_id: actor, review_decision: "confirmed",
          });
        }
        return { status: 201 as const, body: { package_id: packageId, version, manifest_hash: manifestHash, validation_report: { passed, checks }, questions: questionIds } };
      });
      return reply.code(out.status).send(out.body);
    });

    app.get("/questions/:id", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { id } = req.params as { id: string };
      const row = await withTenant(pool, tenantId, async (c) => {
        const r = await c.query(
          "select payload from content_question where question_id = $1 and published",
          [id],
        );
        return r.rows[0];
      });
      if (!row) return reply.code(404).send({ error: "question not found or not published" });
      return row.payload;
    });

    /** 已发布题目列表（选题器候选源，§10 阶段 B）：id/测量目标/可验证性 */
    app.get("/questions", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const rows = await withTenant(pool, tenantId, async (c) => {
        const r = await c.query(
          `select question_id, tags, measurement_dims,
                  (payload->'measurement_targets') as measurement_targets,
                  (payload->'rubric'->'items') is not null as answer_verifiable
             from content_question where published
            order by question_id`,
          [],
        );
        return r.rows;
      });
      return {
        questions: rows.map((r) => ({
          question_id: r.question_id,
          tags: r.tags,
          measurement_dims: r.measurement_dims,
          measurement_targets: r.measurement_targets ?? [],
          answer_verifiable: r.answer_verifiable === true,
        })),
      };
    });

    /**
     * 诊断上下文（§8.3：候选只能来自题目关联 E-ID 与诊断规则）：
     * 已发布题目 + 租户级错因库/诊断规则只读投影，供 DIAGNOSE 归因使用。
     */
    app.get("/questions/:id/diagnosis-context", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { id } = req.params as { id: string };
      const out = await withTenant(pool, tenantId, async (c) => {
        const q = await c.query(
          "select payload from content_question where question_id = $1 and published",
          [id],
        );
        if (q.rows.length === 0) return { status: 404 as const };
        const [ecs, rules] = await Promise.all([
          c.query("select dimension_id, payload from content_error_cause order by dimension_id"),
          c.query("select rule_id, payload from content_diagnosis_rule order by rule_id"),
        ]);
        return {
          status: 200 as const,
          body: {
            question_id: id,
            question: q.rows[0].payload,
            error_causes: ecs.rows.map((r) => r.payload),
            diagnosis_rules: rules.rows.map((r) => r.payload),
          },
        };
      });
      if (out.status === 404) return reply.code(404).send({ error: "question not found or not published" });
      return out.body;
    });

    /** 验收：任一正式字段可追溯到片段/页码、Agent Run、模型、Prompt、审核决定（设计 §7.3） */
    app.get("/questions/:id/lineage", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { id } = req.params as { id: string };
      const rows = await withTenant(pool, tenantId, async (c) => {
        const r = await c.query(
          `select l.field_path, l.provenance_status, l.derivation_type, l.source_fragment_id,
                  f.page_no, f.document_id, l.agent_run_id, l.prompt_version, l.model_id,
                  l.reviewer_id, l.review_decision, l.confidence, l.created_at
             from content_field_lineage l
             left join content_source_fragment f on f.fragment_id = l.source_fragment_id
            where l.entity_type = 'question' and l.entity_id = $1
            order by l.created_at, l.field_path`,
          [id],
        );
        return r.rows;
      });
      if (rows.length === 0) return reply.code(404).send({ error: "no lineage recorded" });
      return { question_id: id, lineage: rows };
    });
  },
});
