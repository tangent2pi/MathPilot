/**
 * content-service：内容生产线骨架（WP-06）。
 *
 * UPLOAD → KTQ_EXTRACTION_RUN → ER_RESEARCH_RUN → REVIEW（review-service 队列）→ PUBLISH
 *
 * - KTQ 与 ER 是两次独立 run（独立 agent_run_id、独立 prompt 版本；fake 实现，
 *   真实 Pi Session 隔离在 WP-05 落地后替换——届时隔离性由契约测试证明）；
 * - 每个正式语义字段写 content_field_lineage（来源片段/Agent Run/模型/Prompt/审核决定）；
 * - 发布前置门：复核任务全部裁决 + 发布校验（measurement_targets 非空、血缘完整等）；
 * - ChapterPackage 不可变（manifest_hash 内容寻址）。
 */
import { createHash } from "node:crypto";
import { startService, createPool, withTenant, newId } from "@agmath/service-kit";

const pool = createPool(process.env.DATABASE_URL ?? "postgres://localhost:5432/agmath");
const REVIEW_URL = process.env.REVIEW_URL ?? "http://localhost:3008";

function tenantOf(req: { headers: Record<string, unknown> }): string | null {
  const t = req.headers["x-tenant-id"];
  return typeof t === "string" && t.length > 0 ? t : null;
}
function actorOf(req: { headers: Record<string, unknown> }): string | null {
  const u = req.headers["x-user-id"];
  return typeof u === "string" && u.length > 0 ? u : null;
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

startService({
  name: "content",
  port: Number(process.env.PORT ?? 3006),
  register(app) {
    /** A1: 文档登记（原件字节走对象存储，骨架仅登记引用与片段；真实 OCR 在 Provider 接入后替换） */
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

    /** A2: KTQ 独立抽取 run（fake.ktq；只见来源片段与 KTQ Schema，不知 ER 任务存在） */
    app.post("/ktq/run", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { document_id: documentId, chapter_id: chapterId } = req.body as { document_id: string; chapter_id: string };
      if (!documentId || !chapterId) return reply.code(422).send({ error: "document_id and chapter_id required" });
      const agentRunId = `run_ktq_${newId("x").slice(2)}`;
      const now = new Date().toISOString();

      const out = await withTenant(pool, tenantId, async (c) => {
        const frags = await c.query(
          `select f.fragment_id, f.page_no, f.payload->>'text_markdown' as text
             from content_source_fragment f
            where f.document_id = $1 and f.fragment_type = 'question_box'
            order by f.page_no`,
          [documentId],
        );
        if (frags.rows.length === 0) return { status: 422 as const, body: { error: "no question_box fragments in document" } };

        // 试点章节知识组件（fake 抽取，含血缘）
        const kcs = [
          { id: "K_SINE_RULE", name: "正弦定理" },
          { id: "K_SSA", name: "SSA 情形解个数讨论" },
          { id: "K_TRIANGLE_EXISTENCE", name: "三角形存在条件" },
        ];
        for (const kc of kcs) {
          await c.query(
            `insert into content_knowledge_component (dimension_id, tenant_id, name, payload)
             values ($1,$2,$3,$4) on conflict (dimension_id) do nothing`,
            [kc.id, tenantId, kc.name, JSON.stringify({ dimension_id: kc.id, name: kc.name })],
          );
          await insertLineage(c, {
            tenant_id: tenantId, entity_type: "knowledge_component", entity_id: kc.id,
            field_path: "/name", provenance_status: "model_generated", derivation_type: "extraction_agent",
            agent_run_id: agentRunId, prompt_version: "ktq-extract@0.1.0", model_id: "fake.ktq", confidence: 0.9,
          });
        }
        await c.query(
          `insert into content_question_type (dimension_id, tenant_id, name, payload)
           values ('T_SSA_SOLVE',$1,'已知两边及一边对角解三角形',$2) on conflict (dimension_id) do nothing`,
          [tenantId, JSON.stringify({ dimension_id: "T_SSA_SOLVE", name: "已知两边及一边对角解三角形" })],
        );

        const prefix = (chapterId.replace(/^chap_/, "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3) || "GEN");
        const seqBase = await c.query(
          "select count(*)::int as n from content_question where chapter_id = $1",
          [chapterId],
        );
        let seq: number = seqBase.rows[0].n;

        const staged: { question_id: string; review_task_id?: string }[] = [];
        for (const f of frags.rows) {
          seq += 1;
          const questionId = `Q_${prefix}_${String(seq).padStart(3, "0")}`;
          const measurementTargets = [
            { dim: "K_SSA", role: "primary", evidence_rule: "rubric.ssa_branch_check" },
            { dim: "K_SINE_RULE", role: "secondary", evidence_rule: "rubric.setup_sine_rule" },
            { dim: "K_TRIANGLE_EXISTENCE", role: "prerequisite", evidence_rule: "probe.existence_check" },
          ];
          const payload = {
            question_id: questionId,
            tenant_id: tenantId,
            chapter_id: chapterId,
            question_version: 1,
            stem_markdown: f.text ?? "",
            stem_format: "open_solution",
            answer: { B: ["45°", "135°"], note: "fake.ktq 抽取占位；发布前由教师复核" },
            rubric: {
              items: [
                { id: "setup_sine_rule", description: "正确列出正弦定理", score_weight: 0.4, evidence_rule: "rubric.setup_sine_rule" },
                { id: "ssa_branch_check", description: "判断补角分支是否成立", score_weight: 0.6, evidence_rule: "rubric.ssa_branch_check" },
              ],
            },
            tags: kcs.map((k) => k.id),
            measurement_targets: measurementTargets,
            provenance: [
              { entity_type: "question", entity_id: questionId, field_path: "/stem_markdown",
                provenance_status: "direct", derivation_type: "ocr", source_fragment_id: f.fragment_id, created_at: now },
              { entity_type: "question", entity_id: questionId, field_path: "/measurement_targets",
                provenance_status: "model_generated", derivation_type: "extraction_agent",
                agent_run_id: agentRunId, prompt_version: "ktq-extract@0.1.0", model_id: "fake.ktq", created_at: now },
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
            field_path: "/stem_markdown", provenance_status: "direct", derivation_type: "ocr",
            source_fragment_id: f.fragment_id, confidence: 0.98,
          });
          for (const fieldPath of ["/measurement_targets", "/answer", "/rubric"]) {
            await insertLineage(c, {
              tenant_id: tenantId, entity_type: "question", entity_id: questionId,
              field_path: fieldPath, provenance_status: "model_generated", derivation_type: "extraction_agent",
              source_fragment_id: f.fragment_id, agent_run_id: agentRunId,
              prompt_version: "ktq-extract@0.1.0", model_id: "fake.ktq", confidence: 0.75,
            });
          }
          staged.push({ question_id: questionId });
        }
        return { status: 200 as const, body: { agent_run_id: agentRunId, staged, frozen: true } };
      });

      // KTQ staging 冻结后登记教师复核任务（经 review-service，跨边界走 HTTP 契约）。
      // 登记失败必须失败关闭：无复核任务的 staging 会绕过发布门。
      if (out.status === 200) {
        for (const s of (out.body as { staged: { question_id: string; review_task_id?: string }[] }).staged) {
          const res = await fetch(`${REVIEW_URL}/review/tasks`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-tenant-id": tenantId },
            body: JSON.stringify({ queue: "content", target_type: "question", target_id: s.question_id }),
          }).catch(() => null);
          if (!res?.ok) {
            return reply.code(502).send({ error: "review_task_registration_failed", question_id: s.question_id });
          }
          s.review_task_id = ((await res.json()) as { task_id: string }).task_id;
        }
      }
      return reply.code(out.status).send(out.body);
    });

    /** A3: ER 独立调研 run（fake.er；只见冻结 KTQ 只读投影，不见 KTQ 抽取过程） */
    app.post("/er/run", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { chapter_id: chapterId } = req.body as { chapter_id: string };
      if (!chapterId) return reply.code(422).send({ error: "chapter_id required" });
      const agentRunId = `run_er_${newId("x").slice(2)}`;

      const out = await withTenant(pool, tenantId, async (c) => {
        const frozen = await c.query(
          "select question_id from content_question where chapter_id = $1 and not published",
          [chapterId],
        );
        if (frozen.rows.length === 0) return { status: 422 as const, body: { error: "no frozen KTQ staging for chapter" } };

        const errorCauses = [
          { id: "E_SSA_MISSING_SUPPLEMENT", name: "SSA 情形遗漏补角分支" },
          { id: "E_EXISTENCE_UNCHECKED", name: "未检验三角形存在条件" },
        ];
        for (const ec of errorCauses) {
          await c.query(
            `insert into content_error_cause (dimension_id, tenant_id, name, payload)
             values ($1,$2,$3,$4) on conflict (dimension_id) do nothing`,
            [ec.id, tenantId, ec.name, JSON.stringify({ dimension_id: ec.id, name: ec.name })],
          );
          await insertLineage(c, {
            tenant_id: tenantId, entity_type: "error_cause", entity_id: ec.id,
            field_path: "/name", provenance_status: "model_generated", derivation_type: "research_agent",
            agent_run_id: agentRunId, prompt_version: "er-research@0.1.0", model_id: "fake.er", confidence: 0.7,
          });
        }
        const ruleId = "R_SSA_BRANCH_PROBE";
        await c.query(
          `insert into content_diagnosis_rule (rule_id, tenant_id, rule_version, payload)
           values ($1,$2,'0.1.0',$3) on conflict (rule_id) do nothing`,
          [ruleId, tenantId, JSON.stringify({
            rule_id: ruleId,
            trigger: "verdict=partially_correct and rubric.ssa_branch_check=not_met",
            candidate_error_causes: errorCauses.map((e) => e.id),
            probe: "补角判断微型探针",
          })],
        );
        await insertLineage(c, {
          tenant_id: tenantId, entity_type: "diagnosis_rule", entity_id: ruleId,
          field_path: "/trigger", provenance_status: "model_generated", derivation_type: "research_agent",
          agent_run_id: agentRunId, prompt_version: "er-research@0.1.0", model_id: "fake.er", confidence: 0.7,
        });
        return {
          status: 200 as const,
          body: { agent_run_id: agentRunId, error_causes: errorCauses.map((e) => e.id), rules: [ruleId] },
        };
      });
      return reply.code(out.status).send(out.body);
    });

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
      });
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

    /** 验收（实施规划 §5）：任一正式字段可追溯到片段/页码、Agent Run、模型、Prompt、审核决定 */
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
