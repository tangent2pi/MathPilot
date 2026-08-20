/**
 * content-service：内容生产线（设计 §7）。
 *
 * UPLOAD → KTQ_EXTRACTION_RUN → ER_RESEARCH_RUN → REVIEW（review-service 队列）→ PUBLISH
 *
 * - KTQ 与 ER 是两次独立 run（独立 agent_run_id、独立 Pi Agent Session，无共享模型历史；
 *   经 @mathpilot/providers-model 调用 agent-runtime，见设计 §4.1/§7.2）；
 * - OCR 经 @mathpilot/providers-ocr（PaddleOCR 官方 API，job 模式；本地/MCP 模式为同接口适配器）；
 * - 每个正式语义字段写 content_field_lineage（来源片段/Agent Run/模型/Prompt/审核决定）；
 * - 发布前置门（P0-4）：本章节复核任务全部裁决且无 rejected；modified 任务真正生效；
 *   rejected 直接阻断发布。KTQ 先注册复核任务、后提交 staging，注册失败不留无任务的 staging。
 * - ChapterPackage 不可变（manifest_hash 内容寻址），按章节记录 chapter_id（P0-5）：
 *   contents 只收集该章节自己的 K/T/E/R，版本唯一性按 (tenant_id, chapter_id, version)。
 * - 诊断上下文（P0-7）：候选只来自本题测量维度关联的诊断规则及其错因，不再返回租户全量。
 */
import { createHash } from "node:crypto";
import { request } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { startService, createPool, withTenant, newId } from "./lib.ts";
import { createAgentRuntimeClient, type TaskResult } from "@mathpilot/providers-model";
import { createAistudioOcrClient } from "@mathpilot/providers-ocr";
import { PIPELINE_TASK_TIMEOUT_MS, shouldResumeTimedOutKtq } from "./pipeline-retry.ts";

const pool = createPool(process.env.DATABASE_URL ?? "postgres://localhost:5432/mathpilot");
const REVIEW_URL = process.env.REVIEW_URL ?? "http://localhost:3008";
const AGENT_RUNTIME_URL = process.env.AGENT_RUNTIME_URL ?? "http://localhost:3005";
const CONTENT_ARTIFACT_ROOT = process.env.CONTENT_ARTIFACT_ROOT ?? path.resolve(".runtime/content-artifacts");
const CONTENT_PORT = Number(process.env.PORT ?? 3006);
const CONTENT_SELF_URL = `http://127.0.0.1:${CONTENT_PORT}`;

// OCR 供应商凭据由本服务（宿主侧）从环境注入；沙箱/前端不持有（设计 §4.4/§16.1）
const OCR_API_BASE = (process.env.OCR_API_BASE ?? "https://paddleocr.aistudio-app.com").replace(/\/$/, "");
const OCR_API_TOKEN = process.env.OCR_API_TOKEN ?? "";
const OCR_MODEL = process.env.OCR_MODEL ?? "PaddleOCR-VL-1.6";

// 大批次最长运行三小时；到期后客户端会调用 runtime cancel，不能留下孤儿模型进程。
const runtime = createAgentRuntimeClient({ baseUrl: AGENT_RUNTIME_URL, timeoutMs: PIPELINE_TASK_TIMEOUT_MS });
const ocrClient = createAistudioOcrClient({ baseUrl: OCR_API_BASE, apiToken: OCR_API_TOKEN, model: OCR_MODEL });

function safeName(value: string, fallback: string): string {
  const base = path.basename(value).replaceAll(/[^A-Za-z0-9._-]/g, "_");
  return base && base !== "." && base !== ".." ? base : fallback;
}

function safeImagePath(value: string, index: number): string {
  const parts = value.split(/[\\/]+/).filter((p) => p && p !== "." && p !== "..").map((p) => safeName(p, "image"));
  return parts.length > 0 ? parts.join("/") : `image-${index + 1}.png`;
}

/**
 * 模型既可能照抄 fragments.jsonl 中的 `ocr/images/...`，也可能按工作区可见路径
 * 返回 `./input/ocr/images/...`。数据库和 artifact manifest 始终使用前一种规范形态。
 */
function normalizeInputWorkspaceRef(value: string): string {
  let normalized = value.trim().replaceAll("\\", "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  if (normalized.startsWith("input/")) normalized = normalized.slice("input/".length);
  return normalized;
}

async function writeArtifact(ref: string, bytes: Uint8Array | string): Promise<void> {
  if (path.isAbsolute(ref) || path.normalize(ref).startsWith("..")) throw new Error("unsafe artifact ref");
  const target = path.join(CONTENT_ARTIFACT_ROOT, ref);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

async function readArtifact(ref: string): Promise<Buffer> {
  if (path.isAbsolute(ref) || path.normalize(ref).startsWith("..")) throw new Error("unsafe artifact ref");
  return readFile(path.join(CONTENT_ARTIFACT_ROOT, ref));
}

function tenantOf(req: { headers: Record<string, unknown> }): string | null {
  const t = req.headers["x-tenant-id"];
  return typeof t === "string" && t.length > 0 ? t : null;
}
function actorOf(req: { headers: Record<string, unknown> }): string | null {
  const u = req.headers["x-user-id"];
  return typeof u === "string" && u.length > 0 ? u : null;
}
function rolesOf(req: { headers: Record<string, unknown> }): string[] {
  const value = req.headers["x-user-roles"];
  return typeof value === "string" ? value.split(",").map((role) => role.trim()).filter(Boolean) : [];
}
type LibraryVisibility = "public" | "teacher";
type ContentScope = { visibility: LibraryVisibility; ownerTeacherId: string | null; pipelineId?: string };
function requestedScope(req: { headers: Record<string, unknown> }, actor: string, requested?: unknown): ContentScope {
  const explicit = requested ?? req.headers["x-library-visibility"];
  const visibility: LibraryVisibility = explicit === "public" && rolesOf(req).includes("tenant_admin") ? "public" : "teacher";
  return { visibility, ownerTeacherId: visibility === "public" ? null : actor };
}
function isTenantAdmin(req: { headers: Record<string, unknown> }): boolean {
  return rolesOf(req).includes("tenant_admin");
}

/**
 * 题目框启发式（确定性导航，非语义判定，设计 §6.2 的程序先导航思想）：
 * 为 OCR 段落标注候选题块；语义判定由 KTQ 抽取 Agent 完成。
 */
function looksLikeQuestion(text: string): boolean {
  if (text.length < 10) return false;
  const hasAsk = /(求|多少|判断|证明|选择|填写|下列.+正确|则.+为)/.test(text) || /[？?]\s*$/.test(text);
  const hasSetup = /(已知|在\s*△|三角形\s*ABC|设)/.test(text);
  const numbered = /^\s*(\d+[.、．]|[（(]\d+[)）]|【?[例习变]题?\s*\d*】?)/.test(text);
  return (hasAsk && hasSetup) || (numbered && hasAsk);
}

function hasSubstantiveValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(hasSubstantiveValue);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).some(hasSubstantiveValue);
  return false;
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

type RawUpload = { file_base64?: string; filename?: string; mime_type?: string; kind?: string };

function inferMime(filename: string, provided?: string): string {
  if (provided && provided !== "application/octet-stream") return provided;
  const known: Record<string,string> = {
    ".pdf":"application/pdf", ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".webp":"image/webp",
    ".doc":"application/msword", ".docx":"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".ppt":"application/vnd.ms-powerpoint", ".pptx":"application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".txt":"text/plain", ".md":"text/markdown", ".csv":"text/csv", ".json":"application/json",
  };
  return known[path.extname(filename).toLowerCase()] ?? "application/octet-stream";
}

async function storeRawDocument(tenantId: string, actor: string, upload: RawUpload): Promise<{ document_id: string; duplicate: boolean }> {
  if (!upload.file_base64) throw new Error("file_base64 required");
  const filename = safeName(upload.filename ?? "upload.bin", "upload.bin");
  const bytes = Buffer.from(upload.file_base64, "base64");
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error("file empty or exceeds 20MiB");
  const originalHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const duplicate = await withTenant(pool, tenantId, async (c) => (await c.query(
    "select document_id from content_source_document where original_hash=$1", [originalHash],
  )).rows[0]?.document_id as string | undefined);
  if (duplicate) return { document_id: duplicate, duplicate: true };
  const documentId = newId("doc");
  const ref = `${tenantId}/${documentId}/original/${filename}`;
  const mimeType = inferMime(filename, upload.mime_type);
  await writeArtifact(ref, bytes);
  try {
    await withTenant(pool, tenantId, async (c) => {
      await c.query(
        `insert into content_source_document
           (document_id,tenant_id,kind,original_hash,storage_ref,ocr_status,uploaded_by,payload)
         values ($1,$2,$3,$4,$5,'agent_decides',$6,$7)`,
        [documentId, tenantId, upload.kind ?? "teaching_material", originalHash, ref, actor, JSON.stringify({
          document_id: documentId, tenant_id: tenantId, kind: upload.kind ?? "teaching_material",
          original_hash: originalHash, storage_ref: ref, mime_type: mimeType, uploaded_by: actor,
          uploaded_at: new Date().toISOString(), ocr_status: "agent_decides", bytes_persisted: true,
          artifact_manifest: [{ artifact_ref: ref, workspace_path: `original/${filename}`, kind: "original", mime_type: mimeType, content_hash: originalHash }],
        })],
      );
    });
  } catch (err) {
    await rm(path.join(CONTENT_ARTIFACT_ROOT, tenantId, documentId), { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  return { document_id: documentId, duplicate: false };
}

async function updatePipeline(tenantId: string, runId: string, patch: { status?: string; stage?: string; payload?: unknown; error?: string | null; completed?: boolean }): Promise<void> {
  await withTenant(pool, tenantId, async (c) => {
    await c.query(
      `update content_pipeline_run set status=coalesce($2,status), stage=coalesce($3,stage),
         payload=case when $4::jsonb is null then payload else payload || $4::jsonb end,
         error_detail=$5, updated_at=now(), completed_at=case when $6 then now() else completed_at end
       where run_id=$1`,
      [runId, patch.status ?? null, patch.stage ?? null, patch.payload === undefined ? null : JSON.stringify(patch.payload), patch.error ?? null, patch.completed ?? false],
    );
  });
}

const runningPipelines = new Set<string>();
async function postPipelineStage(
  route: "/ktq/run" | "/er/run",
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request(new URL(route, CONTENT_SELF_URL), {
      method: "POST",
      headers: { ...headers, "content-length": Buffer.byteLength(payload).toString() },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        try {
          const responseBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          resolve({ ok: (res.statusCode ?? 500) < 400, status: res.statusCode ?? 500, body: responseBody });
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(PIPELINE_TASK_TIMEOUT_MS, () => req.destroy(new Error(`pipeline stage exceeded ${PIPELINE_TASK_TIMEOUT_MS}ms`)));
    req.on("error", reject);
    req.end(payload);
  });
}

async function executePipeline(row: { run_id:string; tenant_id:string; created_by:string; chapter_id:string; document_ids:string[]; ktq_session_ref:string; er_session_ref:string; stage?:string; library_visibility?:LibraryVisibility; owner_teacher_id?:string|null; continue_ktq_session?:boolean }): Promise<void> {
  if (runningPipelines.has(row.run_id)) return;
  runningPipelines.add(row.run_id);
  let activeSessionRef = row.stage === "er" ? row.er_session_ref : row.ktq_session_ref;
  try {
    if (row.stage !== "er") {
      await updatePipeline(row.tenant_id,row.run_id,{status:"running",stage:"ktq"});
      const ktq = await postPipelineStage("/ktq/run", {"content-type":"application/json","x-tenant-id":row.tenant_id,"x-user-id":row.created_by,"x-library-visibility":row.library_visibility??"teacher"}, {document_ids:row.document_ids,chapter_id:row.chapter_id,agent_run_id:row.ktq_session_ref,...(row.continue_ktq_session?{continue_existing_session:true}:{})});
      const ktqBody = ktq.body;
      if (!ktq.ok) throw new Error(`KTQ ${ktq.status}: ${JSON.stringify(ktqBody)}`);
      await updatePipeline(row.tenant_id,row.run_id,{stage:"er",payload:{ktq:ktqBody}});
      activeSessionRef = row.er_session_ref;
    }
    const er = await postPipelineStage("/er/run", {"content-type":"application/json","x-tenant-id":row.tenant_id,"x-user-id":row.created_by,"x-library-visibility":row.library_visibility??"teacher"}, {chapter_id:row.chapter_id,agent_run_id:row.er_session_ref});
    const erBody = er.body;
    if (!er.ok) throw new Error(`ER ${er.status}: ${JSON.stringify(erBody)}`);
    await updatePipeline(row.tenant_id,row.run_id,{status:"review_ready",stage:"review",payload:{er:erBody},completed:true});
  } catch (err) {
    await runtime.cancelSession(activeSessionRef, row.tenant_id, "内容生产管线已失败或超时");
    await updatePipeline(row.tenant_id,row.run_id,{status:"failed",error:err instanceof Error?err.message:String(err),completed:true});
  } finally { runningPipelines.delete(row.run_id); }
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

async function insertEntityScope(
  c: { query: (q: string, v?: unknown[]) => Promise<unknown> },
  tenantId: string,
  entityType: "knowledge_component" | "question_type" | "error_cause" | "diagnosis_rule" | "question" | "chapter_package",
  entityId: string,
  scope: ContentScope,
): Promise<void> {
  await c.query(
    `insert into content_entity_scope
       (tenant_id,entity_type,entity_id,visibility,owner_teacher_id,source_pipeline_id)
     values ($1,$2,$3,$4,$5,$6)
     on conflict do nothing`,
    [tenantId, entityType, entityId, scope.visibility, scope.ownerTeacherId, scope.pipelineId ?? null],
  );
}

/** 补偿清理：staging 事务失败后取消已注册的复核任务（P0-4：不留孤儿任务阻塞发布门） */
async function cancelReviewTasks(tenantId: string, registered: { review_task_id: string }[]): Promise<void> {
  for (const t of registered) {
    await fetch(`${REVIEW_URL}/review/tasks/${encodeURIComponent(t.review_task_id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-tenant-id": tenantId },
      body: JSON.stringify({ status: "cancelled" }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
  }
}

type LibraryProjection = {
  knowledge: { id: string; name: string; payload: unknown }[];
  question_types: { id: string; name: string; payload: unknown }[];
  questions: { id: string; chapter_id: string; published: boolean; stem: string; measurement_dims: string[] }[];
  error_causes: { id: string; name: string; payload: unknown }[];
  diagnosis_rules: { id: string; payload: unknown }[];
};

function visibleScopeSql(scopeAlias: string, viewerParam: string, admin: boolean): string {
  if (admin) return "true";
  return `(${scopeAlias}.visibility='public' or ${scopeAlias}.owner_teacher_id=${viewerParam}
    or exists(select 1 from identity_teacher_student_binding b
      where b.tenant_id=${scopeAlias}.tenant_id and b.student_id=${viewerParam}
        and b.teacher_id=${scopeAlias}.owner_teacher_id and b.status='active'))`;
}

async function loadQuestionDetail(tenantId: string, viewerId: string, admin: boolean, questionId: string, includeStaging = false): Promise<{
  payload: Record<string, unknown>;
  dimension_names: Record<string, { name: string; type: "knowledge_component" | "question_type" }>;
  published_packages: { package_id: string; version: string }[];
  assets: Record<string, unknown>[];
  source_evidence: Record<string, unknown>[];
} | null> {
  return withTenant(pool, tenantId, async (c) => {
    const visible = visibleScopeSql("s", "$2", admin);
    const r = await c.query(
      `select distinct q.payload from content_question q
        join content_entity_scope s on s.tenant_id=q.tenant_id and s.entity_type='question' and s.entity_id=q.question_id
       where q.question_id=$1 ${includeStaging ? "" : "and q.published"} and ${visible}`,
      [questionId, viewerId],
    );
    const q = r.rows[0]?.payload as Record<string, unknown> | undefined;
    if (!q) return null;
    const measurementTargets = Array.isArray(q.measurement_targets) ? q.measurement_targets : [];
    const questionType = q.question_type && typeof q.question_type === "object" ? q.question_type as Record<string, unknown> : null;
    const dimensionIds = [...new Set([
      ...measurementTargets.map((target) => target && typeof target === "object" ? (target as Record<string, unknown>).dim : null),
      questionType?.id,
    ].filter((value): value is string => typeof value === "string" && value.length > 0))];
    const dimensions = dimensionIds.length ? await c.query(
      `select dimension_id,name,'knowledge_component'::text as type from content_knowledge_component where dimension_id=any($1)
       union all
       select dimension_id,name,'question_type'::text as type from content_question_type where dimension_id=any($1)`,
      [dimensionIds],
    ) : { rows: [] as Array<{ dimension_id: string; name: string; type: "knowledge_component" | "question_type" }> };
    const dimensionNames = Object.fromEntries(dimensions.rows.map((row: { dimension_id: string; name: string; type: "knowledge_component" | "question_type" }) => [row.dimension_id, { name: row.name, type: row.type }]));
    const pkgs = await c.query(
      `select distinct p.package_id,p.version,p.published_at from content_chapter_package p
        join content_entity_scope s on s.tenant_id=p.tenant_id and s.entity_type='chapter_package' and s.entity_id=p.package_id
        where p.tenant_id=$1 and p.chapter_id=$2 and ${visibleScopeSql("s", "$3", admin)}
        order by published_at desc`,
      [tenantId, typeof q.chapter_id === "string" ? q.chapter_id : "", viewerId],
    );
    const assets = await c.query(
      `select a.asset_id, a.role, a.mime_type, a.content_hash, a.page_no, a.bbox,
              encode(a.image_bytes, 'base64') as image_base64,
              coalesce(jsonb_agg(distinct l.dimension_id) filter (where l.dimension_id is not null), '[]'::jsonb) as knowledge_components
         from content_question_asset a
         left join content_knowledge_asset_link l on l.asset_id = a.asset_id
        where a.question_id = $1
        group by a.asset_id order by a.asset_id`,
      [questionId],
    );
    const sourceEvidence = await c.query(
      `select l.source_fragment_id, f.document_id, f.page_no, f.fragment_type, f.bbox,
              left(coalesce(f.payload->>'text_markdown',''), 2400) as excerpt,
              coalesce(max(file_info.item->>'name'), f.document_id) as document_name,
              jsonb_agg(distinct l.field_path order by l.field_path) as field_paths
         from content_field_lineage l
         join content_entity_scope s
           on s.tenant_id=l.tenant_id and s.entity_type='question' and s.entity_id=l.entity_id
         left join content_source_fragment f on f.fragment_id=l.source_fragment_id
         left join content_pipeline_run p on p.run_id=s.source_pipeline_id
         left join lateral jsonb_array_elements(coalesce(p.payload->'files','[]'::jsonb)) file_info(item)
           on file_info.item->>'document_id'=f.document_id
        where l.entity_type='question' and l.entity_id=$1 and l.source_fragment_id is not null
          and ${visibleScopeSql("s", "$2", admin)}
        group by l.source_fragment_id,f.document_id,f.page_no,f.fragment_type,f.bbox,f.payload
        order by f.document_id, f.page_no, l.source_fragment_id`,
      [questionId, viewerId],
    );
    return {
      payload: q,
      dimension_names: dimensionNames,
      published_packages: pkgs.rows,
      assets: assets.rows.map((a) => ({
        asset_id: a.asset_id, role: a.role, mime_type: a.mime_type, content_hash: a.content_hash,
        page_no: a.page_no, bbox: a.bbox, knowledge_components: a.knowledge_components,
        image_data_url: `data:${a.mime_type};base64,${a.image_base64}`,
      })),
      source_evidence: sourceEvidence.rows,
    };
  });
}

/** 租户内 KTQRE 只读投影：供教师内容 Agent 去重，也供 Teaching Agent 经受控端点查询。 */
async function loadLibraryProjection(tenantId: string, viewerId: string, admin: boolean, questionId?: string, includeStaging = true): Promise<LibraryProjection> {
  return withTenant(pool, tenantId, async (c) => {
    const visible = visibleScopeSql("s", "$1", admin);
    const questionFilter = `and ($2::text is null or q.question_id=$2) ${includeStaging ? "" : "and q.published"}`;
    const args = [viewerId, questionId ?? null];
    const k = await c.query(`select distinct c.dimension_id as id,c.name,c.payload from content_knowledge_component c
        join content_entity_scope s on s.tenant_id=c.tenant_id and s.entity_type='knowledge_component' and s.entity_id=c.dimension_id
        where ${visible} order by c.dimension_id`, [viewerId]);
    const t = await c.query(`select distinct c.dimension_id as id,c.name,c.payload from content_question_type c
        join content_entity_scope s on s.tenant_id=c.tenant_id and s.entity_type='question_type' and s.entity_id=c.dimension_id
        where ${visible} order by c.dimension_id`, [viewerId]);
    const q = await c.query(`select distinct q.question_id as id,q.chapter_id,q.published,q.payload->>'stem_markdown' as stem,q.measurement_dims
                 from content_question q join content_entity_scope s on s.tenant_id=q.tenant_id and s.entity_type='question' and s.entity_id=q.question_id
                where ${visible} ${questionFilter} order by q.question_id`, args);
    const e = await c.query(`select distinct c.dimension_id as id,c.name,c.payload from content_error_cause c
        join content_entity_scope s on s.tenant_id=c.tenant_id and s.entity_type='error_cause' and s.entity_id=c.dimension_id
        where ${visible} order by c.dimension_id`, [viewerId]);
    const r = await c.query(`select distinct c.rule_id as id,c.payload from content_diagnosis_rule c
        join content_entity_scope s on s.tenant_id=c.tenant_id and s.entity_type='diagnosis_rule' and s.entity_id=c.rule_id
        where ${visible} order by c.rule_id`, [viewerId]);
    const relatedDims = new Set<string>(q.rows.flatMap((row) => row.measurement_dims ?? []));
    const filterRelated = <T extends { id: string; payload?: unknown }>(rows: T[]): T[] => !questionId ? rows : rows.filter((row) => {
      if (relatedDims.has(row.id)) return true;
      const payload = row.payload as { dimension_ids?: string[]; related_dims?: string[] } | undefined;
      return [...(payload?.dimension_ids ?? []), ...(payload?.related_dims ?? [])].some((d) => relatedDims.has(d));
    });
    return { knowledge: filterRelated(k.rows), question_types: filterRelated(t.rows), questions: q.rows,
      error_causes: filterRelated(e.rows), diagnosis_rules: filterRelated(r.rows) };
  });
}

/**
 * KTQ 抽取 run：经 agent-runtime 创建独立 KTQ Extraction Agent Session
 * （只见 question_box 片段与 KTQ Schema，无 ER 材料）→ 结构化题目落 staging + 字段血缘。
 * 顺序（P0-4）：先确定性生成 staging ID → 注册复核任务（失败即 502，不留无任务的 staging）→
 * 后提交 staging 事务；事务失败补偿取消任务。服务层只做存在性校验，不做轮转猜测
 * （设计 §7.3 血缘不得伪造）。失败显式 502，不伪造抽取结果。
 */
async function ktqRunModel(
  req: { headers: Record<string, unknown>; body: unknown },
  reply: { code(n: number): { send(x: unknown): void } },
): Promise<void> {
  const tenantId = tenantOf(req);
  const actor = actorOf(req);
  if (!tenantId || !actor) return reply.code(400).send({ error: "missing tenant/actor headers" });
  const body = req.body as { document_id?: string; document_ids?: string[]; chapter_id?: string; agent_run_id?: string; recover_existing?: boolean; recovery_source_file?: string; continue_existing_session?: boolean };
  const documentIds = [...new Set([...(Array.isArray(body.document_ids) ? body.document_ids : []), ...(body.document_id ? [body.document_id] : [])])];
  const chapterId = body.chapter_id;
  if (!documentIds.length || !chapterId) return reply.code(422).send({ error: "document_ids and internal chapter_id required" });
  if (documentIds.length > 100) return reply.code(422).send({ error: "at most 100 documents per extraction batch" });
  if (body.agent_run_id && !/^run_ktq_[a-f0-9]{32}$/.test(body.agent_run_id)) {
    return reply.code(422).send({ error: "invalid agent_run_id" });
  }
  const agentRunId = body.agent_run_id ?? `run_ktq_${newId("x").slice(2)}`;
  const contentScope = await withTenant(pool, tenantId, async (c) => {
    const row = (await c.query(
      `select run_id,library_visibility,owner_teacher_id from content_pipeline_run
        where ktq_session_ref=$1 and created_by=$2`, [agentRunId, actor])).rows[0];
    return row ? { visibility: row.library_visibility as LibraryVisibility, ownerTeacherId: row.owner_teacher_id as string | null, pipelineId: row.run_id as string }
      : requestedScope(req, actor);
  });
  if (body.agent_run_id) {
    const used = await withTenant(pool, tenantId, async (c) => (await c.query(
      "select exists(select 1 from content_field_lineage where agent_run_id=$1) as used", [agentRunId],
    )).rows[0]?.used as boolean);
    if (used) return reply.code(409).send({ error: "agent_run_id already used" });
  }

  const source = await withTenant(pool, tenantId, async (c) => {
    const d = await c.query(
      `select d.document_id,d.payload from content_source_document d
        where d.document_id = any($1)
          and exists(select 1 from content_source_document_grant g
            where g.tenant_id=d.tenant_id and g.document_id=d.document_id
              and (g.visibility='public' or g.owner_teacher_id=$2))`,
      [documentIds, actor],
    );
    const r = await c.query(
      `select f.document_id, f.fragment_id, f.page_no, f.fragment_type,
              f.payload->>'text_markdown' as text,
              coalesce((f.payload->>'block_order')::integer, 2147483647) as block_order,
              coalesce(f.payload->'image_refs','[]'::jsonb) as image_refs,
              f.bbox
         from content_source_fragment f
        where f.document_id = any($1)
          and exists(select 1 from content_source_document_grant g
            where g.tenant_id=f.tenant_id and g.document_id=f.document_id
              and (g.visibility='public' or g.owner_teacher_id=$2))
          and f.fragment_type in ('heading','paragraph','question_box','table','image_region')
          and coalesce(f.payload->>'text_markdown','') <> ''
        order by f.document_id, f.page_no,
                 coalesce((f.payload->>'block_order')::integer, 2147483647),
                 f.created_at`,
      [documentIds, actor],
    );
    return { documents: d.rows as { document_id: string; payload: { artifact_manifest?: {
      artifact_ref?: string; workspace_path?: string; kind?: string; mime_type?: string; content_hash?: string;
    }[] } }[], fragments: r.rows as {
      document_id: string; fragment_id: string; page_no: number; fragment_type: string; text: string; block_order: number;
      image_refs: string[]; bbox: number[] | null;
    }[] };
  });
  if (source.documents.length !== documentIds.length) return reply.code(404).send({ error: "one or more documents not found" });
  const fragments = source.fragments.map((f) => ({ ...f,
    image_refs: (f.image_refs ?? []).map((ref) => `sources/${f.document_id}/${ref}`),
  }));
  const artifactManifest = source.documents.flatMap((doc) => (doc.payload.artifact_manifest ?? []).map((a) => ({ ...a, document_id: doc.document_id })));
  const inputArtifacts = artifactManifest.filter((a): a is typeof a & { artifact_ref: string; workspace_path: string } =>
    typeof a.artifact_ref === "string" && typeof a.workspace_path === "string")
    .map((a) => ({ artifactRef: a.artifact_ref, workspacePath: `sources/${a.document_id}/${a.workspace_path}` }));
  const catalogRef = `${tenantId}/batches/${agentRunId}/catalog/fragments.jsonl`;
  const catalog = fragments;
  const existingLibrary = await loadLibraryProjection(tenantId, actor, isTenantAdmin(req));
  if (catalog.length) {
    await writeArtifact(catalogRef, catalog.map((f) => JSON.stringify(f)).join("\n") + "\n");
    inputArtifacts.push({ artifactRef: catalogRef, workspacePath: "catalog/fragments.jsonl" });
  }

  const gen = body.recover_existing ? await (async () => {
    const response = await fetch(`${AGENT_RUNTIME_URL}/runtime/sessions/${encodeURIComponent(agentRunId)}/recover-legacy-ktq`, {
      method: "POST", headers: { "content-type": "application/json", "x-tenant-id": tenantId },
      body: JSON.stringify({ source_file: body.recovery_source_file ?? "tmp/final_output.json" }), signal: AbortSignal.timeout(150_000),
    });
    const recovered = await response.json() as { outputJson?: unknown; implementation?: string; promptVersion?: string; detail?: string };
    return response.ok
      ? { ok: true as const, outputJson: recovered.outputJson, implementation: recovered.implementation, promptVersion: recovered.promptVersion }
      : { ok: false as const, status: response.status, error: "legacy_recovery_failed", detail: recovered.detail };
  })() : await runtime.runTask({
    taskType: "ktq_extract",
    sessionRef: agentRunId,
    tenantId,
    context: {
      fragments: catalog.length
        ? "存在历史 OCR catalog：./input/catalog/fragments.jsonl；仍须先查看各资料原件。"
        : "只有原始资料；不要要求预先 OCR。先用 Core 查看，是否调用 PaddleOCR 由你按 ocr-routing Skill 决定。",
    },
    inputArtifacts,
    promptText: body.continue_existing_session
      ? "这是上一次超时后的同一个 KTQ Session。不要从头重新读取或重做已经完成的工作。先检查当前 /workspace/output、/workspace/tmp/build、/workspace/tmp/pages 和已有 transcript，总结已完成部分；直接从未完成的文档继续构建。复用已有题目脚本和裁图，完成 ktq-result.json、验证回执，并用 respond 引用文件。"
      : "读取 /opt/mathpilot-skills/ktq-extraction/SKILL.md 后执行。先检查全部原件；OCR 由你决定。查询既有库、跨文档去重，写文件、验证，再用 respond 引用文件。",
    databaseScope: { actorId: actor },
    workspaceLifecycle: "terminal",
    ...(body.continue_existing_session ? { freshModelContext: true } : {}),
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
      source?: { path?: string; page?: number; bbox?: number[] | null };
      stem_markdown?: string; answer_summary?: string;
      stem_format?: "single_choice" | "multiple_choice" | "fill_blank" | "true_false" | "open_solution";
      options?: { key?: string; text_markdown?: string }[];
      answer?: Record<string, unknown>;
      difficulty?: number;
      image_refs?: string[];
      knowledge_components?: { id?: string; name?: string }[];
      question_type?: { id?: string; name?: string };
      measurement_targets?: { dim?: string; role?: string; evidence_rule?: string }[];
      rubric?: { id?: string; description?: string }[];
      duplicate_of?: string;
      dedup_action?: "new" | "duplicate" | "merge";
    }[];
  };
  const candidates = (parsed.questions ?? []).filter((q) => q.stem_markdown && (q.measurement_targets?.length ?? 0) > 0);
  const normalizeStem = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").replace(/[，。；：！？、,.!?;:]/g, "").toLowerCase();
  const existingByStem = new Map(existingLibrary.questions.filter((q) => q.stem).map((q) => [normalizeStem(q.stem), q.id]));
  const knownQuestionIds = new Set(existingLibrary.questions.map((q) => q.id));
  const duplicates: { source_fragment_id?: string; duplicate_of: string; reason: string }[] = [];
  const seenBatch = new Map<string, string>();
  const questions = candidates.filter((q) => {
    const normalized = normalizeStem(q.stem_markdown!);
    const exact = existingByStem.get(normalized);
    const declared = q.duplicate_of && knownQuestionIds.has(q.duplicate_of) ? q.duplicate_of : undefined;
    const withinBatch = seenBatch.get(normalized);
    const duplicateOf = exact ?? withinBatch ?? (["duplicate", "merge"].includes(q.dedup_action ?? "") ? declared : undefined);
    if (!duplicateOf) {
      seenBatch.set(normalized, q.source_fragment_id ? `batch:${q.source_fragment_id}` : `batch:sha256:${createHash("sha256").update(normalized).digest("hex")}`);
      return true;
    }
    duplicates.push({ ...(q.source_fragment_id ? { source_fragment_id: q.source_fragment_id } : {}),
      duplicate_of: duplicateOf, reason: exact ? "normalized_stem_exact" : withinBatch ? "batch_normalized_stem_exact" : `agent_semantic_${q.dedup_action}` });
    return false;
  });
  if (questions.length === 0) return reply.code(200).send({
    agent_run_id: agentRunId, document_ids: documentIds, staged: [], duplicates,
    frozen: true, extractor: gen.implementation ?? "pi.unknown", note: "all extracted questions already exist",
  });

  // 模型声明的片段关联必须真实存在（设计 §7.3：血缘不得伪造）
  const knownFragmentIds = new Set(fragments.map((f) => f.fragment_id));
  const imageManifest = new Map<string, (typeof artifactManifest)[number]>(artifactManifest
    .filter((a) => (a.kind === "ocr_image" || (a.kind === "original" && a.mime_type?.startsWith("image/"))) && a.workspace_path && a.artifact_ref)
    .map((a) => [`sources/${a.document_id}/${a.workspace_path!}`, a] as const));
  const modelImpl = gen.implementation ?? "pi.unknown";

  // 题图只接受本 document manifest 中的引用；“如图”题可确定性回退到同页图片。
  const preparedAssets = await Promise.all(questions.map(async (q) => {
    const src = fragments.find((f) => f.fragment_id === q.source_fragment_id);
    let refs = (q.image_refs ?? []).map(normalizeInputWorkspaceRef).filter((r) => imageManifest.has(r));
    if (refs.length === 0 && src?.image_refs?.length) refs = src.image_refs.filter((r) => imageManifest.has(r));
    if (refs.length === 0 && /(?:如图|图中|下图|见图)/.test(q.stem_markdown ?? "") && src) {
      // 只在同一原始文档、同一页内选离题目块最近的图片块。旧实现按 page_no
      // 横跨全部文档并收集整页所有图片，容易把相邻题图甚至另一份资料的图片挂到本题。
      const nearest = fragments
        .filter((f) => f.document_id === src.document_id && f.page_no === src.page_no && (f.image_refs?.length ?? 0) > 0)
        .sort((a,b)=>Math.abs(a.block_order-src.block_order)-Math.abs(b.block_order-src.block_order))[0];
      refs = (nearest?.image_refs ?? []).filter((r) => imageManifest.has(r));
    }
    const seenHashes=new Set<string>();
    refs = [...new Set(refs)].filter((ref)=>{
      const hash=imageManifest.get(ref)?.content_hash??ref;
      if(seenHashes.has(hash))return false;
      seenHashes.add(hash);return true;
    });
    return Promise.all(refs.map(async (ref) => {
      const meta = imageManifest.get(ref)!;
      const owner = fragments.find((f) => f.image_refs?.includes(ref));
      return {
        workspacePath: ref,
        bytes: await readArtifact(meta.artifact_ref!),
        mimeType: meta.mime_type ?? "image/png",
        contentHash: meta.content_hash ?? `sha256:${createHash("sha256").update(ref).digest("hex")}`,
        sourceFragmentId: owner?.fragment_id ?? null,
        pageNo: owner?.page_no ?? src?.page_no ?? null,
        bbox: owner?.bbox ?? null,
      };
    }));
  }));

  // 确定性 staging ID（先于事务计算，供复核任务注册使用）
  const seqBase = await withTenant(pool, tenantId, async (c) => {
    const r = await c.query("select count(*)::int as n from content_question where chapter_id = $1", [chapterId]);
    return r.rows[0].n as number;
  });
  const prefix = (chapterId.replace(/^chap_/, "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3) || "GEN");
  const stagedIds = questions.map((_, i) => `Q_${prefix}_${String(seqBase + i + 1).padStart(3, "0")}`);

  // 新知识点与题型也需要独立复核。相同维度在一批题中只登记一次；既有库中的
  // 维度视为已在其原始管线复核，不为每次复用重复生成任务。
  const existingKnowledgeIds=new Set(existingLibrary.knowledge.map((item)=>item.id));
  const existingQuestionTypeIds=new Set(existingLibrary.question_types.map((item)=>item.id));
  const dimensionCandidates=new Map<string,{target_type:"knowledge_component"|"question_type";target_id:string;candidate:Record<string,unknown>} >();
  questions.forEach((question,index)=>{
    for(const item of question.knowledge_components??[]){
      if(!item.id||!item.name||existingKnowledgeIds.has(item.id))continue;
      const key=`knowledge_component:${item.id}`;
      const previous=dimensionCandidates.get(key);
      const related=[...new Set([...(Array.isArray(previous?.candidate.related_questions)?previous.candidate.related_questions as string[]:[]),stagedIds[index]!])];
      dimensionCandidates.set(key,{target_type:"knowledge_component",target_id:item.id,candidate:{id:item.id,name:item.name,related_questions:related,source_fragment_id:question.source_fragment_id??null}});
    }
    const item=question.question_type;
    if(item?.id&&item.name&&!existingQuestionTypeIds.has(item.id)){
      const key=`question_type:${item.id}`;
      const previous=dimensionCandidates.get(key);
      const related=[...new Set([...(Array.isArray(previous?.candidate.related_questions)?previous.candidate.related_questions as string[]:[]),stagedIds[index]!])];
      dimensionCandidates.set(key,{target_type:"question_type",target_id:item.id,candidate:{id:item.id,name:item.name,related_questions:related,source_fragment_id:question.source_fragment_id??null}});
    }
  });

  // ── 先注册复核任务（P0-4）：任一失败 → 502，此时无 staging 可留 ──
  const reviewCandidates:[string,string,Record<string,unknown>][]=[
    ...stagedIds.map((questionId,index)=>["question",questionId,questions[index]!] as [string,string,Record<string,unknown>]),
    ...[...dimensionCandidates.values()].map((item)=>[item.target_type,item.target_id,item.candidate] as [string,string,Record<string,unknown>]),
  ];
  const registered: { target_id: string; target_type: string; question_id?: string; review_task_id: string }[] = [];
  for (const [targetType,targetId,candidate] of reviewCandidates) {
    const res = await fetch(`${REVIEW_URL}/review/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tenant-id": tenantId },
      body: JSON.stringify({ queue: "content", target_type: targetType, target_id: targetId,
        payload: { candidate, chapter_id: chapterId, document_ids: documentIds,
          library_visibility: contentScope.visibility, owner_teacher_id: contentScope.ownerTeacherId,
          source_pipeline_id: contentScope.pipelineId ?? null } }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!res?.ok) {
      await cancelReviewTasks(tenantId, registered);
      return reply.code(502).send({ error: "review_task_registration_failed", target_type:targetType,target_id:targetId });
    }
    registered.push({target_id:targetId,target_type:targetType,...(targetType==="question"?{question_id:targetId}:{}),review_task_id:((await res.json()) as {task_id:string}).task_id});
  }
  const reviewTaskByTarget=new Map(registered.map((item)=>[`${item.target_type}:${item.target_id}`,item.review_task_id]));

  let out: { status: number; body: unknown };
  try {
    out = await withTenant(pool, tenantId, async (c) => {
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i]!;
        const questionId = stagedIds[i]!;
        const srcFragment = knownFragmentIds.has(q.source_fragment_id ?? "") ? q.source_fragment_id! : null;

        const kcs: { id: string; name: string }[] = [];
        for (const k of q.knowledge_components ?? []) {
          if (!k.id || !k.name) continue;
          kcs.push({ id: k.id, name: k.name });
          await c.query(
            `insert into content_knowledge_component (dimension_id, tenant_id, name, payload)
             values ($1,$2,$3,$4) on conflict (dimension_id) do nothing`,
            [k.id, tenantId, k.name, JSON.stringify({ dimension_id: k.id, name: k.name,
              review_task_id: reviewTaskByTarget.get(`knowledge_component:${k.id}`) })],
          );
          await insertEntityScope(c, tenantId, "knowledge_component", k.id, contentScope);
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
             JSON.stringify({ dimension_id: q.question_type.id, name: q.question_type.name,
               review_task_id: reviewTaskByTarget.get(`question_type:${q.question_type.id}`) })],
          );
          await insertEntityScope(c, tenantId, "question_type", q.question_type.id, contentScope);
          await insertLineage(c, {
            tenant_id: tenantId, entity_type: "question_type", entity_id: q.question_type.id,
            field_path: "/name", provenance_status: "model_generated", derivation_type: "extraction_agent",
            source_fragment_id: srcFragment, agent_run_id: agentRunId,
            prompt_version: gen.promptVersion ?? "unknown", model_id: modelImpl, confidence: 0.85,
          });
        }

        const declaredDimensionIds = new Set([
          ...kcs.map((k) => k.id),
          ...(q.question_type?.id ? [q.question_type.id] : []),
        ]);
        const measurementTargets = q.measurement_targets!.map((m) => ({
          dim: m.dim!, role: m.role as "primary" | "secondary" | "prerequisite", evidence_rule: m.evidence_rule!,
        }));
        if (measurementTargets.some((m) => !declaredDimensionIds.has(m.dim))) {
          throw new Error(`question ${questionId} has measurement target outside declared K/T dimensions`);
        }
        const rubricItems = (q.rubric ?? []).map((r) => ({
          id: r.id, description: r.description, score_weight: 0.5, evidence_rule: r.id,
        }));
        const allowedFormats = new Set(["single_choice", "multiple_choice", "fill_blank", "true_false", "open_solution"]);
        const stemFormat = allowedFormats.has(q.stem_format ?? "") ? q.stem_format! : "open_solution";
        const options = (q.options ?? []).filter((o): o is { key: string; text_markdown: string } =>
          Boolean(o.key?.trim() && o.text_markdown?.trim()));
        const answer = q.answer && typeof q.answer === "object" && !Array.isArray(q.answer)
          ? q.answer
          : { summary: q.answer_summary ?? "" };
        const payload = {
          question_id: questionId, tenant_id: tenantId, chapter_id: chapterId, question_version: 1,
          stem_markdown: q.stem_markdown, stem_format: stemFormat, options,
          answer, difficulty: typeof q.difficulty === "number" && q.difficulty >= 0 && q.difficulty <= 1 ? q.difficulty : 0.5,
          rubric: { items: rubricItems },
          tags: kcs.map((k) => k.id),
          question_type: q.question_type ?? null,
          measurement_targets: measurementTargets,
          assets: preparedAssets[i]!.map((a, ai) => ({
            asset_id: `${questionId}_IMG_${String(ai + 1).padStart(2, "0")}`,
            role: "stem_image", image_bytes_ref: a.workspacePath,
            mime_type: a.mimeType, content_hash: a.contentHash,
          })),
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
             values ($1,$2,$3,1,$4,$5,$6,false,$7)`,
          [questionId, tenantId, chapterId, stemFormat, kcs.map((k) => k.id),
           measurementTargets.map((m) => m.dim), JSON.stringify(payload)],
        );
        await insertEntityScope(c, tenantId, "question", questionId, contentScope);
        for (const m of measurementTargets) {
          await c.query(
            `insert into content_measurement_target (tenant_id, question_id, dim, role, evidence_rule)
             values ($1,$2,$3,$4,$5)`,
            [tenantId, questionId, m.dim, m.role, m.evidence_rule],
          );
        }
        for (let ai = 0; ai < preparedAssets[i]!.length; ai++) {
          const a = preparedAssets[i]![ai]!;
          const assetId = `${questionId}_IMG_${String(ai + 1).padStart(2, "0")}`;
          await c.query(
            `insert into content_question_asset
               (asset_id, tenant_id, question_id, role, image_bytes, mime_type,
                source_fragment_id, page_no, bbox, content_hash)
             values ($1,$2,$3,'stem_image',$4,$5,$6,$7,$8,$9)`,
            [assetId, tenantId, questionId,
             a.bytes, a.mimeType, a.sourceFragmentId, a.pageNo, a.bbox, a.contentHash],
          );
          for (const k of kcs) {
            await c.query(
              `insert into content_knowledge_asset_link (tenant_id, dimension_id, asset_id, relation)
               values ($1,$2,$3,'illustrates') on conflict do nothing`,
              [tenantId, k.id, assetId],
            );
          }
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
      }
      return { status: 200 as const, body: {
        agent_run_id: agentRunId, document_ids: documentIds, staged: registered, duplicates, frozen: true, extractor: modelImpl,
        question_assets: preparedAssets.reduce((n, a) => n + a.length, 0),
      } };
    });
  } catch (err) {
    // staging 事务失败：补偿取消任务，保持"有任务无内容/有内容无任务"都不发生（P0-4）
    await cancelReviewTasks(tenantId, registered);
    throw err;
  }
  return reply.code(out.status).send(out.body);
}

/**
 * ER 调研 run：经 agent-runtime 创建独立 ER Research Agent Session
 * （只见冻结 KTQ 只读投影，不见 KTQ 抽取过程与候选）→ 输出 E/R + 血缘。
 * 规则带 dimension_ids（适用 K/T 维度，供题目关联诊断上下文与章节包作用域使用，P0-7）；
 * 模型未声明时回退为冻结题目测量维度的并集（保证规则可发布、可关联）。
 */
async function erRunModel(
  req: { headers: Record<string, unknown>; body: unknown },
  reply: { code(n: number): { send(x: unknown): void } },
): Promise<void> {
  const tenantId = tenantOf(req);
  const actor = actorOf(req);
  if (!tenantId || !actor) return reply.code(400).send({ error: "missing tenant/actor headers" });
  const { chapter_id: chapterId, agent_run_id: requestedRunId } = req.body as { chapter_id: string; agent_run_id?: string };
  if (!chapterId) return reply.code(422).send({ error: "chapter_id required" });
  if (requestedRunId && !/^run_er_[a-f0-9]{32}$/.test(requestedRunId)) {
    return reply.code(422).send({ error: "invalid agent_run_id" });
  }
  const agentRunId = requestedRunId ?? `run_er_${newId("x").slice(2)}`;
  const contentScope = await withTenant(pool, tenantId, async (c) => {
    const row = (await c.query(
      `select run_id,library_visibility,owner_teacher_id,document_ids,ktq_session_ref from content_pipeline_run
        where er_session_ref=$1 and created_by=$2`, [agentRunId, actor])).rows[0];
    return row ? {
      visibility: row.library_visibility as LibraryVisibility,
      ownerTeacherId: row.owner_teacher_id as string | null,
      pipelineId: row.run_id as string,
      documentIds: row.document_ids as string[],
      ktqSessionRef: row.ktq_session_ref as string,
    }
      : requestedScope(req, actor);
  });
  if (requestedRunId) {
    const used = await withTenant(pool, tenantId, async (c) => (await c.query(
      "select exists(select 1 from content_field_lineage where agent_run_id=$1) as used", [agentRunId],
    )).rows[0]?.used as boolean);
    if (used) return reply.code(409).send({ error: "agent_run_id already used" });
  }

  const frozen = await withTenant(pool, tenantId, async (c) => {
    const r = await c.query(
      `select q.question_id, q.payload->>'stem_markdown' as stem, q.measurement_dims
         from content_question q
        where q.chapter_id = $1 and not q.published`,
      [chapterId],
    );
    return r.rows as { question_id: string; stem: string; measurement_dims: string[] }[];
  });
  if (frozen.length === 0) return reply.code(422).send({ error: "no frozen KTQ staging for chapter" });

  const existingLibrary = await loadLibraryProjection(tenantId, actor, isTenantAdmin(req));
  const frozenRef = `${tenantId}/batches/${agentRunId}/frozen/ktq.json`;
  await writeArtifact(frozenRef, JSON.stringify(frozen, null, 2));

  // ER 与 KTQ 保持独立 Session/transcript，但重新装配同一批原件、既有 OCR/版面
  // Artifact，并继承 KTQ 已固化的 output 证据。模型不再只看到一份精简 KTQ JSON。
  const sourceDocuments = "documentIds" in contentScope && contentScope.documentIds.length > 0
    ? await withTenant(pool, tenantId, async (c) => (await c.query(
      `select d.document_id,d.payload from content_source_document d
        where d.document_id=any($1)
          and exists(select 1 from content_source_document_grant g
            where g.tenant_id=d.tenant_id and g.document_id=d.document_id
              and (g.visibility='public' or g.owner_teacher_id=$2))`,
      [contentScope.documentIds, actor],
    )).rows as { document_id: string; payload: { artifact_manifest?: { artifact_ref?: string; workspace_path?: string }[] } }[])
    : [];
  const sourceArtifacts = sourceDocuments.flatMap((document) => (document.payload.artifact_manifest ?? [])
    .filter((item): item is { artifact_ref: string; workspace_path: string } =>
      typeof item.artifact_ref === "string" && typeof item.workspace_path === "string")
    .map((item) => ({ artifactRef: item.artifact_ref, workspacePath: `sources/${document.document_id}/${item.workspace_path}` })));

  const gen = await runtime.runTask({
    taskType: "er_research",
    sessionRef: agentRunId,
    tenantId,
    context: {
      frozenProjection: "冻结 KTQ 位于 ./input/frozen/ktq.json；同批原件/OCR 证据位于 ./input/sources/，KTQ 验证输出位于 ./input/ktq-evidence/。保持 ER 任务边界，不修改或重做 KTQ。",
    },
    inputArtifacts: [{ artifactRef: frozenRef, workspacePath: "frozen/ktq.json" }, ...sourceArtifacts],
    ...("ktqSessionRef" in contentScope && contentScope.ktqSessionRef ? { sessionEvidence: [{
      sessionRef: contentScope.ktqSessionRef,
      sourcePath: "output",
      workspacePath: "ktq-evidence",
    }] } : {}),
    promptText: "读取 /opt/mathpilot-skills/er-research/SKILL.md 后执行。检查冻结 KTQ、查询既有 E/R；需要时检索外部依据，写文件、验证，再用 respond 引用文件。",
    databaseScope: { actorId: actor },
    workspaceLifecycle: "terminal",
  });
  if (!gen.ok) {
    return reply.code(gen.status).send({ error: "research_failed", detail: gen.detail ?? gen.error });
  }
  if (gen.outputJson === undefined) {
    return reply.code(502).send({ error: "research_failed", detail: "agent 未产出结构化结果" });
  }
  const parsed = gen.outputJson as {
    error_causes?: { id?: string; name?: string; description?: string }[];
    diagnosis_rules?: { id?: string; trigger?: string; candidate_error_causes?: string[]; probe?: string; dimension_ids?: string[] }[];
  };
  const errorCauses = (parsed.error_causes ?? []).filter(
    (e): e is { id: string; name: string; description?: string } => Boolean(e.id && e.name),
  );
  const rules = (parsed.diagnosis_rules ?? []).filter(
    (r): r is { id: string; trigger: string; candidate_error_causes?: string[]; probe?: string; dimension_ids?: string[] } =>
      Boolean(r.id && r.trigger),
  );
  if (errorCauses.length === 0 && rules.length === 0) {
    return reply.code(502).send({ error: "research_empty", detail: "模型未产出有效错因/规则" });
  }
  const modelImpl = gen.implementation ?? "pi.unknown";
  // 规则作用域回退：冻结题目测量维度并集（P0-7 关联链 Q→K/T→R→E 的默认边）
  const fallbackDims = [...new Set(frozen.flatMap((f) => f.measurement_dims ?? []))];
  const existingErrorIds = new Set(existingLibrary.error_causes.map((e) => e.id));
  const existingRuleIds = new Set(existingLibrary.diagnosis_rules.map((r) => r.id));
  const newErrorCauses = errorCauses.filter((e) => !existingErrorIds.has(e.id));
  const newRules = rules.filter((r) => !existingRuleIds.has(r.id));
  const registered: { target_id: string; target_type: string; review_task_id: string }[] = [];
  for (const target of [
    ...newErrorCauses.map((item) => ({ target_id: item.id, target_type: "error_cause", payload: item })),
    ...newRules.map((item) => ({ target_id: item.id, target_type: "diagnosis_rule", payload: item })),
  ]) {
    const res = await fetch(`${REVIEW_URL}/review/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tenant-id": tenantId },
      body: JSON.stringify({ queue: "content", target_type: target.target_type, target_id: target.target_id, payload: { candidate: target.payload, chapter_id: chapterId,
        library_visibility: contentScope.visibility, owner_teacher_id: contentScope.ownerTeacherId,
        source_pipeline_id: contentScope.pipelineId ?? null } }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!res?.ok) {
      await cancelReviewTasks(tenantId, registered);
      return reply.code(502).send({ error: "review_task_registration_failed", target_id: target.target_id });
    }
    registered.push({ target_id: target.target_id, target_type: target.target_type,
      review_task_id: ((await res.json()) as { task_id: string }).task_id });
  }
  const reviewTaskByTarget = new Map(registered.map((r) => [r.target_id, r.review_task_id]));

  let out: { status: number; body: unknown };
  try {
    out = await withTenant(pool, tenantId, async (c) => {
    for (const ec of newErrorCauses) {
      await c.query(
        `insert into content_error_cause (dimension_id, tenant_id, name, payload)
         values ($1,$2,$3,$4)`,
        [ec.id, tenantId, ec.name, JSON.stringify({ dimension_id: ec.id, name: ec.name, description: ec.description ?? "",
          chapter_id: chapterId, review_task_id: reviewTaskByTarget.get(ec.id) })],
      );
      await insertEntityScope(c, tenantId, "error_cause", ec.id, contentScope);
      await insertLineage(c, {
        tenant_id: tenantId, entity_type: "error_cause", entity_id: ec.id,
        field_path: "/name", provenance_status: "model_generated", derivation_type: "research_agent",
        agent_run_id: agentRunId, prompt_version: gen.promptVersion ?? "unknown", model_id: modelImpl, confidence: 0.8,
      });
    }
    for (const r of newRules) {
      const dimensionIds = (r.dimension_ids?.length ? r.dimension_ids : fallbackDims)
        .filter((d) => typeof d === "string" && d.length > 0);
      await c.query(
        `insert into content_diagnosis_rule (rule_id, tenant_id, rule_version, payload)
         values ($1,$2,'0.1.0',$3)`,
        [r.id, tenantId, JSON.stringify({
          rule_id: r.id, trigger: r.trigger, candidate_error_causes: r.candidate_error_causes ?? [],
          probe: r.probe ?? "", dimension_ids: dimensionIds, chapter_id: chapterId,
          review_task_id: reviewTaskByTarget.get(r.id),
        })],
      );
      await insertEntityScope(c, tenantId, "diagnosis_rule", r.id, contentScope);
      await insertLineage(c, {
        tenant_id: tenantId, entity_type: "diagnosis_rule", entity_id: r.id,
        field_path: "/trigger", provenance_status: "model_generated", derivation_type: "research_agent",
        agent_run_id: agentRunId, prompt_version: gen.promptVersion ?? "unknown", model_id: modelImpl, confidence: 0.8,
      });
    }
    return {
      status: 200 as const,
      body: { agent_run_id: agentRunId, error_causes: newErrorCauses.map((e) => e.id), rules: newRules.map((r) => r.id),
        reused_error_causes: errorCauses.filter((e) => existingErrorIds.has(e.id)).map((e) => e.id),
        reused_rules: rules.filter((r) => existingRuleIds.has(r.id)).map((r) => r.id),
        review_tasks: registered, extractor: modelImpl },
    };
    });
  } catch (err) {
    await cancelReviewTasks(tenantId, registered);
    throw err;
  }
  return reply.code(out.status).send(out.body);
}

/** 复核任务裁决查询：按目标题目列表过滤（发布门用，P0-4） */
async function fetchReviewDecisions(
  tenantId: string,
  targetIds: string[],
): Promise<{ tasks: { task_id: string; target_id: string; status: string; assignee_id: string | null; payload: Record<string, unknown> }[]; ok: boolean }> {
  if (targetIds.length === 0) return { tasks: [], ok: true };
  const res = await fetch(
    `${REVIEW_URL}/review/tasks?queue=content&target_ids=${encodeURIComponent(targetIds.join(","))}`,
    { headers: { "x-tenant-id": tenantId }, signal: AbortSignal.timeout(10_000) },
  ).catch(() => null);
  if (!res?.ok) return { tasks: [], ok: false };
  const d = (await res.json()) as { tasks: { task_id: string; target_id: string; status: string; assignee_id: string | null; payload: Record<string, unknown> }[] };
  return { tasks: d.tasks, ok: true };
}

/** 应用教师 modified 裁决的内容修改（P0-4：modified 真正修改内容并记血缘） */
async function applyModification(
  c: { query: (q: string, v?: unknown[]) => Promise<unknown> },
  tenantId: string,
  questionId: string,
  mod: Record<string, unknown>,
  reviewerId: string | null,
  reviewDecision: string,
): Promise<void> {
  const cur = (await c.query("select payload from content_question where question_id = $1", [questionId])) as {
    rows: { payload?: Record<string, unknown> }[];
  };
  const p = cur.rows[0]?.payload ?? {};
  const next = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
  const changed: string[] = [];

  if (typeof mod.stem_markdown === "string" && mod.stem_markdown.trim()) {
    next.stem_markdown = mod.stem_markdown;
    changed.push("/stem_markdown");
  }
  if (typeof mod.answer_summary === "string") {
    next.answer = { ...(next.answer as Record<string, unknown> ?? {}), summary: mod.answer_summary };
    changed.push("/answer");
  }
  if (mod.answer && typeof mod.answer === "object" && !Array.isArray(mod.answer) && hasSubstantiveValue(mod.answer)) {
    next.answer = mod.answer;
    changed.push("/answer");
  }
  if (typeof mod.stem_format === "string" && ["single_choice", "multiple_choice", "fill_blank", "true_false", "open_solution"].includes(mod.stem_format)) {
    next.stem_format = mod.stem_format;
    await c.query("update content_question set stem_format=$2 where question_id=$1", [questionId, mod.stem_format]);
    changed.push("/stem_format");
  }
  if (Array.isArray(mod.options)) {
    const options = (mod.options as { key?: string; text_markdown?: string }[]).filter((o) => o.key?.trim() && o.text_markdown?.trim());
    next.options = options;
    changed.push("/options");
  }
  if (typeof mod.difficulty === "number" && mod.difficulty >= 0 && mod.difficulty <= 1) {
    next.difficulty = mod.difficulty;
    changed.push("/difficulty");
  }
  if (Array.isArray(mod.rubric)) {
    const items = (mod.rubric as { id?: string; description?: string }[]).filter((r) => r.id && r.description);
    if (items.length > 0) {
      next.rubric = { items };
      changed.push("/rubric");
    }
  }
  if (Array.isArray(mod.measurement_targets)) {
    const targets = (mod.measurement_targets as { dim?: string; role?: string; evidence_rule?: string }[])
      .filter((t) => t.dim && ["primary", "secondary", "prerequisite"].includes(t.role ?? "") && t.evidence_rule);
    if (targets.length > 0) {
      next.measurement_targets = targets;
      await c.query("delete from content_measurement_target where question_id = $1", [questionId]);
      for (const t of targets) {
        await c.query(
          `insert into content_measurement_target (tenant_id, question_id, dim, role, evidence_rule)
           values ($1,$2,$3,$4,$5)`,
          [tenantId, questionId, t.dim, t.role, t.evidence_rule],
        );
      }
      const dims = [...new Set(targets.map((t) => t.dim!))];
      await c.query("update content_question set measurement_dims = $2 where question_id = $1", [questionId, dims]);
      changed.push("/measurement_targets");
    }
  }
  if (Array.isArray(mod.remove_asset_ids)) {
    const requested = [...new Set(mod.remove_asset_ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
    if (requested.length > 0) {
      const owned = await c.query(
        "select asset_id from content_question_asset where question_id=$1 and asset_id=any($2::text[])",
        [questionId, requested],
      ) as { rows: { asset_id: string }[] };
      const assetIds = owned.rows.map((row) => row.asset_id);
      if (assetIds.length > 0) {
        await c.query("delete from content_knowledge_asset_link where asset_id=any($1::text[])", [assetIds]);
        await c.query("delete from content_question_asset where question_id=$1 and asset_id=any($2::text[])", [questionId, assetIds]);
        if (Array.isArray(next.assets)) next.assets = next.assets.filter((asset) => !assetIds.includes(String((asset as { asset_id?: unknown }).asset_id ?? "")));
        changed.push("/assets");
      }
    }
  }
  if (changed.length === 0) return;
  await c.query("update content_question set payload = $2 where question_id = $1", [questionId, JSON.stringify(next)]);
  for (const path of changed) {
    await insertLineage(c, {
      tenant_id: tenantId, entity_type: "question", entity_id: questionId, field_path: path,
      provenance_status: "human_authored", derivation_type: "teacher_edit",
      reviewer_id: reviewerId, review_decision: reviewDecision,
    });
  }
}

async function applyErModification(
  c: { query: (q: string, v?: unknown[]) => Promise<unknown> },
  tenantId: string,
  targetId: string,
  mod: Record<string, unknown>,
  reviewerId: string | null,
): Promise<void> {
  if (targetId.startsWith("E_")) {
    const cur = await c.query("select name,payload from content_error_cause where dimension_id = $1", [targetId]) as { rows: { name: string; payload: Record<string, unknown> }[] };
    const row = cur.rows[0]; if (!row) return;
    const next = { ...row.payload };
    let name = row.name; const changed: string[] = [];
    if (typeof mod.name === "string" && mod.name.trim()) { name = mod.name.trim(); next.name = name; changed.push("/name"); }
    if (typeof mod.description === "string") { next.description = mod.description; changed.push("/description"); }
    if (!changed.length) return;
    await c.query("update content_error_cause set name=$2,payload=$3 where dimension_id=$1", [targetId, name, JSON.stringify(next)]);
    for (const fieldPath of changed) await insertLineage(c, { tenant_id: tenantId, entity_type: "error_cause", entity_id: targetId,
      field_path: fieldPath, provenance_status: "human_authored", derivation_type: "teacher_edit", reviewer_id: reviewerId, review_decision: "modified" });
    return;
  }
  if (targetId.startsWith("R_")) {
    const cur = await c.query("select payload from content_diagnosis_rule where rule_id = $1", [targetId]) as { rows: { payload: Record<string, unknown> }[] };
    const row = cur.rows[0]; if (!row) return;
    const next = { ...row.payload }; const changed: string[] = [];
    for (const field of ["trigger", "probe"] as const) if (typeof mod[field] === "string") { next[field] = mod[field]; changed.push(`/${field}`); }
    for (const field of ["candidate_error_causes", "dimension_ids"] as const) if (Array.isArray(mod[field])) { next[field] = mod[field]; changed.push(`/${field}`); }
    if (!changed.length) return;
    await c.query("update content_diagnosis_rule set payload=$2 where rule_id=$1", [targetId, JSON.stringify(next)]);
    for (const fieldPath of changed) await insertLineage(c, { tenant_id: tenantId, entity_type: "diagnosis_rule", entity_id: targetId,
      field_path: fieldPath, provenance_status: "human_authored", derivation_type: "teacher_edit", reviewer_id: reviewerId, review_decision: "modified" });
  }
}

async function applyDimensionModification(
  c: { query: (q: string, v?: unknown[]) => Promise<unknown> },
  tenantId: string,
  targetType: "knowledge_component" | "question_type",
  targetId: string,
  mod: Record<string, unknown>,
  reviewerId: string | null,
): Promise<void> {
  const table = targetType === "knowledge_component" ? "content_knowledge_component" : "content_question_type";
  const cur = await c.query(`select name,payload from ${table} where dimension_id=$1`, [targetId]) as { rows: { name: string; payload: Record<string, unknown> }[] };
  const row = cur.rows[0];
  if (!row || typeof mod.name !== "string" || !mod.name.trim() || mod.name.trim() === row.name) return;
  const name = mod.name.trim();
  await c.query(`update ${table} set name=$2,payload=$3 where dimension_id=$1`, [targetId, name, JSON.stringify({ ...row.payload, name })]);
  await insertLineage(c, {
    tenant_id: tenantId, entity_type: targetType, entity_id: targetId, field_path: "/name",
    provenance_status: "human_authored", derivation_type: "teacher_edit", reviewer_id: reviewerId,
    review_decision: "modified",
  });
}

startService({
  name: "content",
  port: Number(process.env.PORT ?? 3006),
  register(app) {
    app.addHook("onReady", async () => {
      const rows = await pool.query("select * from mathpilot_pending_content_pipelines()");
      for (const row of rows.rows) setImmediate(() => void executePipeline({ ...row, document_ids: row.document_ids as string[] }));
    });

    /** 原始资料先保存为待确认资料集；确认后由 KTQ Agent 决定是否 OCR。 */
    app.post("/pipelines", async (req, reply) => {
      const tenantId=tenantOf(req), actor=actorOf(req);
      if (!tenantId || !actor) return reply.code(400).send({error:"missing tenant/actor headers"});
      const {files,library_visibility:libraryVisibility}=req.body as {files?:RawUpload[];library_visibility?:LibraryVisibility};
      if (!Array.isArray(files) || !files.length || files.length>100) return reply.code(422).send({error:"files must contain 1..100 items"});
      let documents;
      try { documents=[]; for (const file of files) documents.push(await storeRawDocument(tenantId,actor,file)); }
      catch (err) { return reply.code(422).send({error:"invalid_upload",detail:err instanceof Error?err.message:String(err)}); }
      const uniqueDocuments: typeof documents = [];
      const uniqueFiles: { name: string; document_id: string; duplicate: boolean }[] = [];
      for (const [index, document] of documents.entries()) {
        if (uniqueDocuments.some((item) => item.document_id === document.document_id)) continue;
        uniqueDocuments.push(document);
        uniqueFiles.push({ name: files[index]?.filename ?? `file-${index+1}`, document_id: document.document_id, duplicate: document.duplicate });
      }
      const scope=requestedScope(req,actor,libraryVisibility);
      const runId=`pipe_${crypto.randomUUID().replaceAll("-","")}`, suffix=runId.slice(-32);
      const row={run_id:runId,tenant_id:tenantId,created_by:actor,chapter_id:`batch_${suffix.slice(0,12)}`,document_ids:uniqueDocuments.map(d=>d.document_id),ktq_session_ref:`run_ktq_${suffix}`,er_session_ref:`run_er_${suffix}`,library_visibility:scope.visibility,owner_teacher_id:scope.ownerTeacherId};
      await withTenant(pool,tenantId,async(c)=>{await c.query(`insert into content_pipeline_run(run_id,tenant_id,created_by,chapter_id,status,stage,document_ids,ktq_session_ref,er_session_ref,payload,library_visibility,owner_teacher_id) values($1,$2,$3,$4,'draft','upload',$5,$6,$7,$8,$9,$10)`,[row.run_id,row.tenant_id,row.created_by,row.chapter_id,JSON.stringify(row.document_ids),row.ktq_session_ref,row.er_session_ref,JSON.stringify({files:uniqueFiles}),row.library_visibility,row.owner_teacher_id]);for(const documentId of row.document_ids)await c.query(`insert into content_source_document_grant(tenant_id,document_id,visibility,owner_teacher_id) values($1,$2,$3,$4) on conflict do nothing`,[tenantId,documentId,row.library_visibility,row.owner_teacher_id]);});
      // 上传只建立待确认资料集；确认动作之后才创建 Agent 运行。
      return reply.code(202).send({run_id:runId,status:"draft",stage:"upload",document_ids:row.document_ids,ktq_session_ref:row.ktq_session_ref,er_session_ref:row.er_session_ref});
    });

    /** 待确认资料集可继续追加；逐文件请求避免多份 Base64 聚合后超过网关请求上限。 */
    app.post("/pipelines/:id/files", async (req, reply) => {
      const tenantId=tenantOf(req),actor=actorOf(req);if(!tenantId||!actor)return reply.code(400).send({error:"missing tenant/actor headers"});
      const {id}=req.params as {id:string};const {files}=req.body as {files?:RawUpload[]};
      if(!Array.isArray(files)||!files.length||files.length>20)return reply.code(422).send({error:"files must contain 1..20 items"});
      const preflight=await withTenant(pool,tenantId,async(c)=>(await c.query(`select created_by,status,document_ids from content_pipeline_run where run_id=$1`,[id])).rows[0]);
      if(!preflight)return reply.code(404).send({error:"pipeline not found"});
      if(preflight.created_by!==actor)return reply.code(403).send({error:"only the creator can edit this task"});
      if(preflight.status!=="draft")return reply.code(409).send({error:"pipeline is no longer editable"});
      if((preflight.document_ids as string[]).length+files.length>100)return reply.code(422).send({error:"pipeline cannot contain more than 100 files"});
      let documents;
      try{documents=[];for(const file of files)documents.push(await storeRawDocument(tenantId,actor,file));}
      catch(err){return reply.code(422).send({error:"invalid_upload",detail:err instanceof Error?err.message:String(err)});}
      const updated=await withTenant(pool,tenantId,async(c)=>{
        const row=(await c.query(`select created_by,status,document_ids,payload,library_visibility,owner_teacher_id from content_pipeline_run where run_id=$1 for update`,[id])).rows[0];
        if(!row||row.created_by!==actor||row.status!=="draft")return null;
        const ids=[...(row.document_ids as string[])],entries=Array.isArray(row.payload?.files)?[...row.payload.files]:[];
        for(const [index,document] of documents.entries()){
          if(ids.includes(document.document_id))continue;
          ids.push(document.document_id);entries.push({name:files[index]?.filename??`file-${entries.length+1}`,document_id:document.document_id,duplicate:document.duplicate});
          await c.query(`insert into content_source_document_grant(tenant_id,document_id,visibility,owner_teacher_id) values($1,$2,$3,$4) on conflict do nothing`,[tenantId,document.document_id,row.library_visibility,row.owner_teacher_id]);
        }
        if(ids.length>100)throw new Error("pipeline cannot contain more than 100 files");
        await c.query(`update content_pipeline_run set document_ids=$2,payload=$3,updated_at=now() where run_id=$1`,[id,JSON.stringify(ids),JSON.stringify({...row.payload,files:entries})]);
        return {document_ids:ids,files:entries};
      });
      if(!updated)return reply.code(409).send({error:"pipeline is no longer editable"});
      return reply.code(200).send({run_id:id,status:"draft",...updated});
    });

    /** 确认前可从资料集移除单份文件；原始对象仍按内容存储策略保留和去重。 */
    app.delete("/pipelines/:id/files/:documentId", async (req, reply) => {
      const tenantId=tenantOf(req),actor=actorOf(req);if(!tenantId||!actor)return reply.code(400).send({error:"missing tenant/actor headers"});
      const {id,documentId}=req.params as {id:string;documentId:string};
      const updated=await withTenant(pool,tenantId,async(c)=>{
        const row=(await c.query(`select created_by,status,document_ids,payload from content_pipeline_run where run_id=$1 for update`,[id])).rows[0];
        if(!row)return {kind:"missing" as const};if(row.created_by!==actor)return {kind:"forbidden" as const};if(row.status!=="draft")return {kind:"locked" as const};
        const ids=(row.document_ids as string[]).filter((value)=>value!==documentId);if(ids.length===(row.document_ids as string[]).length)return {kind:"file_missing" as const};
        const entries=(Array.isArray(row.payload?.files)?row.payload.files:[]).filter((file:{document_id?:string})=>file.document_id!==documentId);
        await c.query(`update content_pipeline_run set document_ids=$2,payload=$3,updated_at=now() where run_id=$1`,[id,JSON.stringify(ids),JSON.stringify({...row.payload,files:entries})]);
        return {kind:"updated" as const,document_ids:ids,files:entries};
      });
      if(updated.kind==="missing"||updated.kind==="file_missing")return reply.code(404).send({error:"pipeline file not found"});
      if(updated.kind==="forbidden")return reply.code(403).send({error:"only the creator can edit this task"});
      if(updated.kind==="locked")return reply.code(409).send({error:"pipeline is no longer editable"});
      return {run_id:id,status:"draft",document_ids:updated.document_ids,files:updated.files};
    });

    /** 用户确认资料清单后，才进入 KTQ → ER。重复确认是幂等的。 */
    app.post("/pipelines/:id/confirm", async (req, reply) => {
      const tenantId = tenantOf(req), actor = actorOf(req);
      if (!tenantId || !actor) return reply.code(400).send({ error: "missing tenant/actor headers" });
      const { id } = req.params as { id: string };
      const row = await withTenant(pool, tenantId, async (c) => (await c.query(
        `select run_id,tenant_id,created_by,chapter_id,document_ids,ktq_session_ref,er_session_ref,status,stage,library_visibility,owner_teacher_id
           from content_pipeline_run where run_id=$1`, [id])).rows[0]);
      if (!row) return reply.code(404).send({ error: "pipeline not found" });
      if (row.created_by !== actor) return reply.code(403).send({ error: "only the creator can confirm this task" });
      if (row.status === "draft") {
        if (!Array.isArray(row.document_ids) || row.document_ids.length === 0) return reply.code(409).send({ error: "pipeline has no files" });
        await withTenant(pool, tenantId, async (c) => c.query(
          "update content_pipeline_run set status='queued',stage='upload',updated_at=now() where run_id=$1", [id]));
        setImmediate(() => void executePipeline({ ...row, document_ids: row.document_ids as string[] }));
      }
      return reply.code(202).send({ run_id: id, status: row.status === "draft" ? "queued" : row.status, stage: row.stage, ktq_session_ref: row.ktq_session_ref, er_session_ref: row.er_session_ref });
    });

    /**
     * 失败任务沿用同一 run_id 重启，避免最近任务中产生重复卡片。
     * KTQ 超时且尚未写入血缘时复用原章节与 Session；其他 KTQ 失败换新 Session。
     * ER 失败时保留已冻结的 KTQ，只换新 ER Session。
     * 旧 Session 与错误写入 retry_history，便于审计而不污染当前可打开的 Session 引用。
     */
    app.post("/pipelines/:id/retry", async (req, reply) => {
      const tenantId=tenantOf(req),actor=actorOf(req);
      if(!tenantId||!actor)return reply.code(400).send({error:"missing tenant/actor headers"});
      const {id}=req.params as {id:string};
      const retry=await withTenant(pool,tenantId,async(c)=>{
        const row=(await c.query(
          `select run_id,tenant_id,created_by,chapter_id,status,stage,document_ids,
                  ktq_session_ref,er_session_ref,payload,error_detail,library_visibility,owner_teacher_id
             from content_pipeline_run where run_id=$1 for update`,[id])).rows[0] as {
          run_id:string;tenant_id:string;created_by:string;chapter_id:string;status:string;stage:string;
          document_ids:string[];ktq_session_ref:string;er_session_ref:string;payload:Record<string,unknown>;
          error_detail:string|null;library_visibility:LibraryVisibility;owner_teacher_id:string|null;
        }|undefined;
        if(!row)return {kind:"missing" as const};
        if(row.created_by!==actor)return {kind:"forbidden" as const};
        if(row.status!=="failed")return {kind:"not_failed" as const};
        if(!Array.isArray(row.document_ids)||row.document_ids.length===0)return {kind:"no_files" as const};

        const now=new Date().toISOString();
        const suffix=crypto.randomUUID().replaceAll("-","");
        const payload=row.payload&&typeof row.payload==="object"&&!Array.isArray(row.payload)?{...row.payload}:{};
        const retryHistory=Array.isArray(payload.retry_history)?payload.retry_history.slice(-19):[];
        retryHistory.push({
          requested_at:now,requested_by:actor,failed_stage:row.stage,error_detail:row.error_detail,
          chapter_id:row.chapter_id,ktq_session_ref:row.ktq_session_ref,er_session_ref:row.er_session_ref,
        });
        const resumeEr=row.stage==="er"&&payload.ktq!==undefined;
        const resumeKtq=shouldResumeTimedOutKtq(row.stage,row.error_detail);
        const chapterId=resumeEr||resumeKtq?row.chapter_id:`batch_${suffix.slice(0,12)}`;
        const ktqSessionRef=resumeEr||resumeKtq?row.ktq_session_ref:`run_ktq_${suffix}`;
        const erSessionRef=`run_er_${suffix}`;
        const stage=resumeEr?"er":"ktq";
        const nextPayload:Record<string,unknown>={...payload,retry_history:retryHistory,retry_count:Number(payload.retry_count??0)+1};
        delete nextPayload.er;
        delete nextPayload.publication;
        if(!resumeEr)delete nextPayload.ktq;

        await c.query(
          `update content_pipeline_run
              set chapter_id=$2,status='queued',stage=$3,ktq_session_ref=$4,er_session_ref=$5,
                  payload=$6,error_detail=null,completed_at=null,updated_at=now()
            where run_id=$1`,
          [id,chapterId,stage,ktqSessionRef,erSessionRef,JSON.stringify(nextPayload)],
        );
        return {kind:"queued" as const,row:{
          run_id:id,tenant_id:tenantId,created_by:row.created_by,chapter_id:chapterId,
          document_ids:row.document_ids,ktq_session_ref:ktqSessionRef,er_session_ref:erSessionRef,
          stage,library_visibility:row.library_visibility,owner_teacher_id:row.owner_teacher_id,
          ...(resumeKtq?{continue_ktq_session:true}:{}),
        }};
      });
      if(retry.kind==="missing")return reply.code(404).send({error:"pipeline not found"});
      if(retry.kind==="forbidden")return reply.code(403).send({error:"only the creator can retry this task"});
      if(retry.kind==="not_failed")return reply.code(409).send({error:"only failed pipelines can be retried"});
      if(retry.kind==="no_files")return reply.code(409).send({error:"pipeline has no files"});
      setImmediate(()=>void executePipeline(retry.row));
      return reply.code(202).send({
        run_id:id,status:"queued",stage:retry.row.stage,chapter_id:retry.row.chapter_id,
        ktq_session_ref:retry.row.ktq_session_ref,er_session_ref:retry.row.er_session_ref,error_detail:null,
      });
    });

    /** 关闭只记录当前用户的列表偏好，流水线、Session、产物和审计记录都保留。 */
    app.post("/pipelines/:id/dismiss", async (req, reply) => {
      const tenantId=tenantOf(req),actor=actorOf(req);
      if(!tenantId||!actor)return reply.code(400).send({error:"missing tenant/actor headers"});
      const {id}=req.params as {id:string};
      const visible=await withTenant(pool,tenantId,async(c)=>{
        const found=(await c.query(
          `select 1 from content_pipeline_run where run_id=$1 and ($3::boolean or created_by=$2)`,
          [id,actor,isTenantAdmin(req)])).rowCount;
        if(!found)return false;
        await c.query(
          `insert into content_pipeline_card_dismissal(tenant_id,run_id,user_id)
           values($1,$2,$3) on conflict (tenant_id,run_id,user_id) do nothing`,
          [tenantId,id,actor],
        );
        return true;
      });
      if(!visible)return reply.code(404).send({error:"pipeline not found"});
      return {run_id:id,dismissed:true};
    });

    /** 采用一个已验证、已写入 staging 的旧 KTQ Session，从独立 ER 阶段继续；不再调用 KTQ 模型。 */
    app.post("/pipelines/adopt-recovered-ktq", async (req,reply) => {
      const tenantId=tenantOf(req),actor=actorOf(req); if(!tenantId||!actor)return reply.code(400).send({error:"missing tenant/actor headers"});
      const body=req.body as {document_ids?:string[];chapter_id?:string;ktq_session_ref?:string;er_session_ref?:string};
      if(!Array.isArray(body.document_ids)||!body.document_ids.length||!body.chapter_id||!/^run_ktq_[a-f0-9]{32}$/.test(body.ktq_session_ref??"")||!/^run_er_[a-f0-9]{32}$/.test(body.er_session_ref??""))return reply.code(422).send({error:"invalid recovered pipeline"});
      const recoveredScope=requestedScope(req,actor);const runId=`pipe_${crypto.randomUUID().replaceAll("-","")}`; const row={run_id:runId,tenant_id:tenantId,created_by:actor,chapter_id:body.chapter_id,document_ids:body.document_ids,ktq_session_ref:body.ktq_session_ref!,er_session_ref:body.er_session_ref!,stage:"er",library_visibility:recoveredScope.visibility,owner_teacher_id:recoveredScope.ownerTeacherId};
      try { await withTenant(pool,tenantId,async(c)=>c.query(`insert into content_pipeline_run(run_id,tenant_id,created_by,chapter_id,status,stage,document_ids,ktq_session_ref,er_session_ref,payload,library_visibility,owner_teacher_id) values($1,$2,$3,$4,'running','er',$5,$6,$7,$8,$9,$10)`,[runId,tenantId,actor,row.chapter_id,JSON.stringify(row.document_ids),row.ktq_session_ref,row.er_session_ref,JSON.stringify({recovered_ktq:true}),row.library_visibility,row.owner_teacher_id])); }
      catch(err){return reply.code(409).send({error:"recovered_pipeline_conflict",detail:err instanceof Error?err.message:String(err)});}
      setImmediate(()=>void executePipeline(row)); return reply.code(202).send({run_id:runId,status:"running",stage:"er",ktq_session_ref:row.ktq_session_ref,er_session_ref:row.er_session_ref});
    });

    app.get("/pipelines", async (req,reply) => {
      const tenantId=tenantOf(req),actor=actorOf(req); if(!tenantId||!actor)return reply.code(400).send({error:"missing tenant/actor headers"});const admin=isTenantAdmin(req);
      const rows=await withTenant(pool,tenantId,async(c)=>(await c.query(
        `select p.run_id,p.chapter_id,p.created_by,p.status,p.stage,p.document_ids,p.ktq_session_ref,p.er_session_ref,
                p.payload,p.error_detail,p.created_at,p.updated_at,p.completed_at,p.library_visibility
           from content_pipeline_run p
          where ($2::boolean or p.created_by=$1)
            and not exists(
              select 1 from content_pipeline_card_dismissal d
               where d.tenant_id=p.tenant_id and d.run_id=p.run_id and d.user_id=$1
            )
          order by p.created_at desc limit 100`,[actor,admin])).rows);
      return {runs:rows.map((row)=>({...row,can_retry:row.created_by===actor}))};
    });
    app.get("/pipelines/:id", async (req,reply) => {
      const tenantId=tenantOf(req),actor=actorOf(req); if(!tenantId||!actor)return reply.code(400).send({error:"missing tenant/actor headers"}); const {id}=req.params as {id:string};
      const row=await withTenant(pool,tenantId,async(c)=>(await c.query(`select run_id,chapter_id,status,stage,document_ids,ktq_session_ref,er_session_ref,payload,error_detail,created_at,updated_at,completed_at,library_visibility from content_pipeline_run where run_id=$1 and ($3::boolean or created_by=$2)`,[id,actor,isTenantAdmin(req)])).rows[0]);
      return row??reply.code(404).send({error:"pipeline not found"});
    });
    /** 兼容业务只读投影；Agent 不再把它复制成 JSON 文件，而使用受限 PostgreSQL 身份。 */
    app.get("/library", async (req, reply) => {
      const tenantId = tenantOf(req);
      const actor = actorOf(req);
      if (!tenantId || !actor) return reply.code(400).send({ error: "missing tenant/actor headers" });
      const { question_id: questionId } = req.query as { question_id?: string };
      const projection = await loadLibraryProjection(tenantId, actor, isTenantAdmin(req), questionId, false);
      return { ...projection, agent_transport: "postgresql_session_identity" };
    });

    /** 教师可浏览的已发布内容包。列表与详情都沿用公共库/本人教师库范围。 */
    app.get("/packages", async (req, reply) => {
      const tenantId=tenantOf(req),actor=actorOf(req);
      if(!tenantId||!actor)return reply.code(400).send({error:"missing tenant/actor headers"});
      const rows=await withTenant(pool,tenantId,async(c)=>(await c.query(
        `select distinct on(p.package_id) p.package_id,p.chapter_id,p.version,p.manifest_hash,p.published_at,
                s.visibility,
                jsonb_array_length(coalesce(p.payload->'contents'->'questions','[]'::jsonb)) as question_count,
                jsonb_array_length(coalesce(p.payload->'contents'->'knowledge_components','[]'::jsonb)) as knowledge_count,
                jsonb_array_length(coalesce(p.payload->'contents'->'question_types','[]'::jsonb)) as question_type_count,
                jsonb_array_length(coalesce(p.payload->'contents'->'error_causes','[]'::jsonb)) as error_cause_count,
                jsonb_array_length(coalesce(p.payload->'contents'->'diagnosis_rules','[]'::jsonb)) as diagnosis_rule_count
           from content_chapter_package p join content_entity_scope s
             on s.tenant_id=p.tenant_id and s.entity_type='chapter_package' and s.entity_id=p.package_id
          where p.published_at is not null and ${visibleScopeSql("s","$1",isTenantAdmin(req))}
          order by p.package_id,p.published_at desc`,[actor])).rows);
      return {packages:rows.sort((a,b)=>String(b.published_at).localeCompare(String(a.published_at)))};
    });

    app.get("/packages/:id", async (req, reply) => {
      const tenantId=tenantOf(req),actor=actorOf(req);
      if(!tenantId||!actor)return reply.code(400).send({error:"missing tenant/actor headers"});
      const {id}=req.params as {id:string};
      const out=await withTenant(pool,tenantId,async(c)=>{
        const row=(await c.query(
          `select distinct on(p.package_id) p.package_id,p.chapter_id,p.version,p.manifest_hash,p.published_at,p.payload,s.visibility
             from content_chapter_package p join content_entity_scope s
               on s.tenant_id=p.tenant_id and s.entity_type='chapter_package' and s.entity_id=p.package_id
            where p.package_id=$1 and p.published_at is not null and ${visibleScopeSql("s","$2",isTenantAdmin(req))}
            order by p.package_id,p.published_at desc`,[id,actor])).rows[0];
        if(!row)return null;
        const contents=row.payload?.contents??{};
        const ids=(key:string)=>Array.isArray(contents[key])?contents[key].filter((value:unknown):value is string=>typeof value==="string"):[];
        const questionIds=ids("questions"),knowledgeIds=ids("knowledge_components"),typeIds=ids("question_types"),errorIds=ids("error_causes"),ruleIds=ids("diagnosis_rules");
        const questions=questionIds.length?(await c.query(
          `select q.question_id,q.stem_format,q.payload,
                  (select count(*)::int from content_question_asset a where a.question_id=q.question_id) as asset_count
             from content_question q where q.question_id=any($1) order by q.question_id`,[questionIds])).rows:[];
        const knowledge=knowledgeIds.length?(await c.query(
          `select dimension_id,name,payload from content_knowledge_component where dimension_id=any($1) order by dimension_id`,[knowledgeIds])).rows:[];
        const questionTypes=typeIds.length?(await c.query(
          `select dimension_id,name,payload from content_question_type where dimension_id=any($1) order by dimension_id`,[typeIds])).rows:[];
        const errorCauses=errorIds.length?(await c.query(
          `select dimension_id,name,payload from content_error_cause where dimension_id=any($1) order by dimension_id`,[errorIds])).rows:[];
        const rules=ruleIds.length?(await c.query(
          `select rule_id,payload from content_diagnosis_rule where rule_id=any($1) order by rule_id`,[ruleIds])).rows:[];
        return {package:{package_id:row.package_id,chapter_id:row.chapter_id,version:row.version,manifest_hash:row.manifest_hash,published_at:row.published_at,visibility:row.visibility},
          questions,knowledge_components:knowledge,question_types:questionTypes,error_causes:errorCauses,diagnosis_rules:rules};
      });
      return out??reply.code(404).send({error:"published package not found"});
    });

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

    /** A1b: 真实教学资料 OCR 入库。原件、分页 Markdown、layout、fragments 和 OCR 图片
     *  先持久化为不可变 artifact，再登记数据库；KTQ Session 按 manifest 物化到工作区。 */
    app.post("/documents/ocr", async (req, reply) => {
      const tenantId = tenantOf(req);
      const actor = actorOf(req);
      if (!tenantId || !actor) return reply.code(400).send({ error: "missing tenant/actor headers" });
      const body = req.body as {
        kind?: string; file_base64?: string; filename?: string;
        mime_type?: string; page_ranges?: string; page_start?: number;
      };
      if (!body.file_base64) return reply.code(422).send({ error: "file_base64 required" });
      const ext = path.extname(body.filename ?? "").toLowerCase();
      const inferredMime: Record<string, string> = {
        ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
        ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      };
      const mimeType = body.mime_type && body.mime_type !== "application/octet-stream" ? body.mime_type : (inferredMime[ext] ?? "application/octet-stream");
      const supportedMime = mimeType === "application/pdf" || mimeType.startsWith("image/") || [
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-powerpoint",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ].includes(mimeType);
      if (!supportedMime) return reply.code(422).send({ error: "unsupported teaching material type", mime_type: mimeType });
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
        mimeType,
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
      const prefix = `${tenantId}/${documentId}`;
      const originalName = safeName(body.filename ?? "upload.pdf", "upload.pdf");
      const rawRef = `${prefix}/original/${originalName}`;
      type ImageMeta = {
        page_no: number; source_path: string; workspace_path: string; artifact_ref: string;
        mime_type: string; content_hash: string;
      };
      const imageMeta: ImageMeta[] = [];
      const artifactManifest: { artifact_ref: string; workspace_path: string; kind: string; mime_type: string; content_hash?: string }[] = [
        { artifact_ref: rawRef, workspace_path: `original/${originalName}`, kind: "original", mime_type: mimeType, content_hash: originalHash },
      ];
      const fragmentRecords: {
        fragment_id: string; page_no: number; fragment_type: string; bbox: number[] | null;
        content_hash: string; text: string; block_order: number | null; image_refs: string[];
      }[] = [];

      try {
        await writeArtifact(rawRef, bytes);
        for (const page of result.pages) {
          const pageName = `page-${String(page.page_no).padStart(4, "0")}.md`;
          const pageRef = `${prefix}/ocr/pages/${pageName}`;
          await writeArtifact(pageRef, page.markdown);
          artifactManifest.push({ artifact_ref: pageRef, workspace_path: `ocr/pages/${pageName}`, kind: "ocr_page", mime_type: "text/markdown" });
          for (let i = 0; i < page.images.length; i++) {
            const image = page.images[i]!;
            const relativeImage = safeImagePath(image.path, i);
            const workspacePath = `ocr/images/page-${String(page.page_no).padStart(4, "0")}/${relativeImage}`;
            const artifactRef = `${prefix}/${workspacePath}`;
            await writeArtifact(artifactRef, Buffer.from(image.bytes_base64, "base64"));
            imageMeta.push({ page_no: page.page_no, source_path: image.path, workspace_path: workspacePath,
              artifact_ref: artifactRef, mime_type: image.mime_type, content_hash: image.content_hash });
            artifactManifest.push({ artifact_ref: artifactRef, workspace_path: workspacePath, kind: "ocr_image",
              mime_type: image.mime_type, content_hash: image.content_hash });
          }
        }

        for (const page of result.pages) {
          const pageImages = imageMeta.filter((i) => i.page_no === page.page_no);
          const matched = new Set<string>();
          for (const block of page.blocks) {
            const text = block.markdown.trim();
            if (!text) continue;
            const fragmentType = block.block_type !== "paragraph" ? block.block_type : looksLikeQuestion(text) ? "question_box" : "paragraph";
            const refs = pageImages.filter((i) => text.includes(i.source_path) || text.includes(path.basename(i.source_path))).map((i) => i.workspace_path);
            refs.forEach((r) => matched.add(r));
            fragmentRecords.push({
              fragment_id: newId("frg"), page_no: page.page_no, fragment_type: fragmentType,
              bbox: block.bbox, content_hash: `sha256:${createHash("sha256").update(text).digest("hex")}`,
              text, block_order: block.block_order ?? null, image_refs: refs,
            });
          }
          const unmatchedImages=pageImages.filter((i) => !matched.has(i.workspace_path));
          const imageBlocks=page.blocks.filter((b)=>b.block_type==="image_region");
          for (let imageIndex=0;imageIndex<unmatchedImages.length;imageIndex++) {
            const image=unmatchedImages[imageIndex]!;
            const imageBlock=page.blocks.find((b)=>b.block_type==="image_region"
              && (b.markdown.includes(image.source_path)||b.markdown.includes(path.basename(image.source_path))))
              ?? imageBlocks[imageIndex] ?? null;
            const text = `![OCR image](${image.workspace_path})`;
            fragmentRecords.push({
              fragment_id: newId("frg"), page_no: page.page_no, fragment_type: "image_region",
              bbox: imageBlock?.bbox ?? null, content_hash: image.content_hash, text,
              block_order: imageBlock?.block_order ?? null, image_refs: [image.workspace_path],
            });
          }
        }

        const layoutRef = `${prefix}/ocr/layout.json`;
        const fragmentsRef = `${prefix}/ocr/fragments.jsonl`;
        await writeArtifact(layoutRef, JSON.stringify({ document_id: documentId, pages: result.pages.map((p) => ({
          page_no: p.page_no, blocks: p.blocks, images: imageMeta.filter((i) => i.page_no === p.page_no),
        })) }, null, 2));
        await writeArtifact(fragmentsRef, fragmentRecords.map((f) => JSON.stringify(f)).join("\n") + "\n");
        artifactManifest.push(
          { artifact_ref: layoutRef, workspace_path: "ocr/layout.json", kind: "ocr_layout", mime_type: "application/json" },
          { artifact_ref: fragmentsRef, workspace_path: "ocr/fragments.jsonl", kind: "ocr_fragments", mime_type: "application/x-ndjson" },
        );

        const out = await withTenant(pool, tenantId, async (c) => {
          await c.query(
            `insert into content_source_document
               (document_id, tenant_id, kind, original_hash, storage_ref, ocr_status, uploaded_by, payload)
             values ($1,$2,$3,$4,$5,'parsed',$6,$7)`,
            [documentId, tenantId, body.kind ?? "exercise_set", originalHash, rawRef, actor,
             JSON.stringify({
               document_id: documentId, tenant_id: tenantId, kind: body.kind ?? "exercise_set",
               original_hash: originalHash, storage_ref: rawRef, mime_type: mimeType,
               uploaded_by: actor, uploaded_at: new Date().toISOString(), ocr_status: "parsed",
               ocr: { implementation, parser_version: `${OCR_MODEL}@api-v2` },
               num_pages: result.pages.length, image_count: imageMeta.length,
               bytes_persisted: true, artifact_manifest: artifactManifest,
             })],
          );
          for (const f of fragmentRecords) {
            await c.query(
              `insert into content_source_fragment
                 (fragment_id, tenant_id, document_id, page_no, fragment_type, bbox, content_hash, payload)
               values ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [f.fragment_id, tenantId, documentId, f.page_no, f.fragment_type, f.bbox, f.content_hash,
               JSON.stringify({ fragment_id: f.fragment_id, document_id: documentId, page_no: f.page_no,
                 fragment_type: f.fragment_type, text_markdown: f.text, bbox: f.bbox,
                 block_order: f.block_order, image_refs: f.image_refs })],
            );
          }
          return { status: 201 as const, body: {
            document_id: documentId, original_hash: originalHash, ocr_implementation: implementation,
            storage_ref: rawRef, bytes_persisted: true, image_count: imageMeta.length,
            pages: result.pages.map((p) => ({ page_no: p.page_no, markdown_chars: p.markdown.length, images: p.images.length })),
            fragments: fragmentRecords.map((f) => ({ fragment_id: f.fragment_id, page_no: f.page_no, fragment_type: f.fragment_type, chars: f.text.length, image_refs: f.image_refs })),
            question_box_count: fragmentRecords.filter((f) => f.fragment_type === "question_box").length,
          } };
        });
        return reply.code(out.status).send(out.body);
      } catch (err) {
        await rm(path.join(CONTENT_ARTIFACT_ROOT, tenantId, documentId), { recursive: true, force: true }).catch(() => undefined);
        throw err;
      }
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
      const { chapter_id: chapterId, version, quality_profile: qualityProfile = "generic" } = req.body as {
        chapter_id: string; version: string; quality_profile?: "generic" | "competition_2026";
      };
      if (!chapterId || !/^\d+\.\d+\.\d+$/.test(version ?? "")) {
        return reply.code(422).send({ error: "chapter_id and semver version required" });
      }
      if (!["generic", "competition_2026"].includes(qualityProfile)) {
        return reply.code(422).send({ error: "quality_profile must be generic|competition_2026" });
      }
      const publishScope = await withTenant(pool, tenantId, async (c) => (await c.query(
        `select run_id,library_visibility,owner_teacher_id,created_by from content_pipeline_run
          where chapter_id=$1 order by created_at desc limit 1`, [chapterId])).rows[0] as
          {run_id:string;library_visibility:LibraryVisibility;owner_teacher_id:string|null;created_by:string}|undefined);
      if (!publishScope) return reply.code(404).send({ error: "content task not found" });
      if (!isTenantAdmin(req) && publishScope.owner_teacher_id !== actor) return reply.code(403).send({ error: "content task belongs to another teacher" });
      if (publishScope.library_visibility === "public" && !isTenantAdmin(req)) return reply.code(403).send({ error: "public library publishing requires tenant admin" });
      const packageScope: ContentScope = { visibility: publishScope.library_visibility, ownerTeacherId: publishScope.owner_teacher_id, pipelineId: publishScope.run_id };

      // ── 复核门（P0-4）：本章节待发布题目的复核任务必须全部裁决且无 rejected ──
      const stagedQuestions = await withTenant(pool, tenantId, async (c) => {
        const r = await c.query(
          "select question_id from content_question where chapter_id = $1 and not published order by question_id",
          [chapterId],
        );
        return r.rows as { question_id: string }[];
      });
      if (stagedQuestions.length === 0) return reply.code(422).send({ error: "nothing staged for chapter" });

      const erReviewTargets = await withTenant(pool, tenantId, async (c) => {
        const e = await c.query("select dimension_id as target_id from content_error_cause where payload->>'chapter_id'=$1 and payload ? 'review_task_id'", [chapterId]);
        const r = await c.query("select rule_id as target_id from content_diagnosis_rule where payload->>'chapter_id'=$1 and payload ? 'review_task_id'", [chapterId]);
        return [...e.rows, ...r.rows].map((x) => x.target_id as string);
      });
      const dimensionReviewTargets = await withTenant(pool, tenantId, async (c) => {
        const k = await c.query(
          `select distinct 'knowledge_component'::text as target_type,k.dimension_id as target_id
             from content_knowledge_component k join content_measurement_target mt on mt.dim=k.dimension_id
             join content_question q on q.question_id=mt.question_id
            where q.chapter_id=$1 and k.payload ? 'review_task_id'`, [chapterId]);
        const t = await c.query(
          `select distinct 'question_type'::text as target_type,t.dimension_id as target_id
             from content_question_type t join content_measurement_target mt on mt.dim=t.dimension_id
             join content_question q on q.question_id=mt.question_id
            where q.chapter_id=$1 and t.payload ? 'review_task_id'`, [chapterId]);
        return [...k.rows, ...t.rows] as { target_type: "knowledge_component" | "question_type"; target_id: string }[];
      });
      const reviewTargetIds = [...stagedQuestions.map((q) => q.question_id), ...dimensionReviewTargets.map((item) => item.target_id), ...erReviewTargets];
      const decisions = await fetchReviewDecisions(tenantId, reviewTargetIds);
      if (!decisions.ok) return reply.code(502).send({ error: "review_unreachable" });
      // 每题取"最新一次裁决"（P0-4）：历史 rejected 被修订后的新裁决取代（教师修订→重审流程）；
      // 最新裁决为 pending → 阻断；为 rejected → 阻断；confirmed/modified/merged → 放行
      // 注意：review GET 按 created_at desc 排序，数组第一个即最新——只 set 首个（Map.set 后者覆盖）
      const latestByTarget = new Map<string, { task_id: string; status: string; assignee_id: string | null; payload: Record<string, unknown> }>();
      for (const t of decisions.tasks) {
        if (!latestByTarget.has(t.target_id)) latestByTarget.set(t.target_id, t);
      }
      const taskByTarget = latestByTarget;
      const missing = reviewTargetIds.filter((id) => !taskByTarget.has(id));
      const pending = decisions.tasks.filter((t) => t.status === "pending");
      const rejected = decisions.tasks.filter((t) => t.status === "rejected");
      const staleRejected = rejected.filter((t) => taskByTarget.get(t.target_id)?.task_id !== t.task_id);
      const effectiveRejected = rejected.filter((t) => !staleRejected.some((s) => s.task_id === t.task_id));
      const effectivePending = pending.filter((t) => !staleRejected.some((s) => s.task_id === t.task_id) && taskByTarget.get(t.target_id)?.task_id === t.task_id);
      if (missing.length > 0 || effectivePending.length > 0 || effectiveRejected.length > 0) {
        return reply.code(422).send({
          error: "review_gate_not_passed",
          review_gate: {
            passed: false,
            missing_review_tasks: missing,
            pending: effectivePending.map((t) => t.task_id),
            rejected: effectiveRejected.map((t) => ({ task_id: t.task_id, target_id: t.target_id })),
          },
        });
      }

      const packageId = newId("pkg");
      const now = new Date().toISOString();
      const out = await withTenant(pool, tenantId, async (c) => {
        // 教师 modified 裁决在发布时真正生效（P0-4：审核结论与内容绑定）
        for (const q of stagedQuestions) {
          const task = taskByTarget.get(q.question_id);
          if (!task || task.status !== "modified") continue;
          const mod = (task.payload?.modification ?? {}) as Record<string, unknown>;
          if (Object.keys(mod).length > 0) {
            await applyModification(c, tenantId, q.question_id, mod, task.assignee_id, "modified");
          }
        }
        for (const targetId of erReviewTargets) {
          const task = taskByTarget.get(targetId);
          if (!task || task.status !== "modified") continue;
          const mod = (task.payload?.modification ?? {}) as Record<string, unknown>;
          if (Object.keys(mod).length > 0) await applyErModification(c, tenantId, targetId, mod, task.assignee_id);
        }
        for (const target of dimensionReviewTargets) {
          const task = taskByTarget.get(target.target_id);
          if (!task || task.status !== "modified") continue;
          const mod = (task.payload?.modification ?? {}) as Record<string, unknown>;
          if (Object.keys(mod).length > 0) await applyDimensionModification(c, tenantId, target.target_type, target.target_id, mod, task.assignee_id);
        }

        const questionIds = stagedQuestions.map((q) => q.question_id);
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
        const qs = await c.query("select payload from content_question where question_id = any($1)", [questionIds]);

        // 章节作用域内容（P0-5）：只收集该章节自己的 K/T/E/R
        const dimsRows = await c.query(
          `select distinct mt.dim from content_measurement_target mt
             join content_question q on q.question_id = mt.question_id
            where q.chapter_id = $1`,
          [chapterId],
        );
        const dims = dimsRows.rows.map((r) => r.dim as string);
        const kIds = dims.filter((d) => d.startsWith("K_"));
        const tIds = dims.filter((d) => d.startsWith("T_"));
        // 规则：dimension_ids 与本章节维度重叠，或暂无作用域声明的旧规则（回退兼容）
        const ruleRows = await c.query(
          `select rule_id, payload from content_diagnosis_rule
            where payload->'dimension_ids' ?| $1::text[]
               or jsonb_array_length(payload->'dimension_ids') = 0`,
          [dims],
        );
        const ruleIds = ruleRows.rows.map((r) => r.rule_id as string);
        const eIdSet = new Set<string>();
        for (const r of ruleRows.rows as { payload: { candidate_error_causes?: string[] } }[]) {
          for (const e of r.payload?.candidate_error_causes ?? []) eIdSet.add(e);
        }
        const eIds = [...eIdSet];
        const ecRows = eIds.length > 0
          ? await c.query("select dimension_id from content_error_cause where dimension_id = any($1)", [eIds])
          : { rows: [] as { dimension_id: string }[] };

        const checks = [
          { check: "id_uniqueness", passed: new Set(questionIds).size === questionIds.length },
          { check: "measurement_targets_nonempty", passed: questionIds.every((q) => (mtByQ.get(q) ?? 0) > 0) },
          { check: "provenance_complete", passed: questionIds.every((q) => (linByQ.get(q) ?? 0) > 0) },
          { check: "references_exist", passed: dims.every((d) => d.startsWith("K_") || d.startsWith("T_")) },
          { check: "answer_rubric_complete", passed: qs.rows.every((r) =>
            hasSubstantiveValue(r.payload?.answer) && (r.payload?.rubric?.items?.length ?? 0) > 0) },
          { check: "question_format_complete", passed: qs.rows.every((r) => {
            const f = r.payload?.stem_format;
            return !["single_choice", "multiple_choice"].includes(f)
              || (r.payload?.options?.length ?? 0) >= 2;
          }) },
        ];
        if (qualityProfile === "competition_2026") checks.push(
          { check: "competition_knowledge_min_25", passed: kIds.length >= 25 },
          { check: "competition_question_type_min_20", passed: tIds.length >= 20 },
          { check: "competition_error_cause_min_20", passed: ecRows.rows.length >= 20 },
          { check: "competition_question_min_80", passed: questionIds.length >= 80 },
          { check: "competition_diagnosis_rule_min_20", passed: ruleIds.length >= 20 },
        );
        const passed = checks.every((ck) => ck.passed);
        if (!passed) return { status: 422 as const, body: { error: "publish_validation_failed", validation_report: { passed, checks } } };

        const contents = {
          knowledge_components: kIds,
          question_types: tIds,
          error_causes: ecRows.rows.map((r) => r.dimension_id),
          questions: questionIds,
          diagnosis_rules: ruleIds,
        };
        const manifestHash = `sha256:${createHash("sha256").update(JSON.stringify(contents)).digest("hex")}`;
        const dup = await c.query(
          "select 1 from content_chapter_package where tenant_id = $1 and chapter_id = $2 and version = $3",
          [tenantId, chapterId, version],
        );
        if (dup.rows.length > 0) return { status: 409 as const, body: { error: "version already published" } };

        const packagePayload = {
          package_id: packageId, tenant_id: tenantId, chapter_id: chapterId, version, quality_profile: qualityProfile,
          manifest_hash: manifestHash, contents, validation_report: { passed, checks },
          published_by: actor, published_at: now,
        };
        await c.query(
          `insert into content_chapter_package
             (package_id, tenant_id, chapter_id, version, manifest_hash, published_by, published_at, payload)
           values ($1,$2,$3,$4,$5,$6,now(),$7)`,
          [packageId, tenantId, chapterId, version, manifestHash, actor, JSON.stringify(packagePayload)],
        );
        await insertEntityScope(c, tenantId, "chapter_package", packageId, packageScope);
        await c.query("update content_question set published = true where question_id = any($1)", [questionIds]);
        for (const q of stagedQuestions) {
          const task = taskByTarget.get(q.question_id);
          await insertLineage(c, {
            tenant_id: tenantId, entity_type: "question", entity_id: q.question_id,
            field_path: "/published", provenance_status: "human_authored", derivation_type: "teacher_edit",
            reviewer_id: task?.assignee_id ?? actor,
            review_decision: (task?.status as "confirmed" | "modified" | "rejected" | "merged") ?? "confirmed",
          });
        }
        await c.query(
          `update content_pipeline_run
              set status='published', stage='review', completed_at=now(), updated_at=now(),
                  payload=payload || jsonb_build_object('publication',$2::jsonb)
            where run_id=$1`,
          [publishScope.run_id, JSON.stringify({ package_id: packageId, version, manifest_hash: manifestHash, published_at: now })],
        );
        return { status: 201 as const, body: { package_id: packageId, version, manifest_hash: manifestHash, validation_report: { passed, checks }, questions: questionIds } };
      });
      return reply.code(out.status).send(out.body);
    });

    /** 学生题面：只返回作答所需字段；标准答案、rubric、测量目标和血缘绝不下发。 */
    app.get("/questions/:id/student", async (req, reply) => {
      const tenantId = tenantOf(req);
      const actor = actorOf(req);
      if (!tenantId || !actor) return reply.code(400).send({ error: "missing tenant/actor headers" });
      const { id } = req.params as { id: string };
      const detail = await loadQuestionDetail(tenantId, actor, isTenantAdmin(req), id);
      if (!detail) return reply.code(404).send({ error: "question not found or not published" });
      const q = detail.payload;
      return {
        question_id: q.question_id,
        chapter_id: q.chapter_id,
        question_version: q.question_version,
        stem_markdown: q.stem_markdown,
        stem_format: q.stem_format,
        options: Array.isArray(q.options) ? q.options : [],
        difficulty: q.difficulty ?? null,
        published_packages: detail.published_packages,
        assets: detail.assets,
      };
    });

    /** 教师复核题卡：允许读取本人暂存题及题图；API 网关只向教师角色暴露。 */
    app.get("/questions/:id/review", async (req, reply) => {
      const tenantId = tenantOf(req);
      const actor = actorOf(req);
      if (!tenantId || !actor) return reply.code(400).send({ error: "missing tenant/actor headers" });
      const { id } = req.params as { id: string };
      const detail = await loadQuestionDetail(tenantId, actor, isTenantAdmin(req), id, true);
      if (!detail) return reply.code(404).send({ error: "question not found in your content library" });
      return { ...detail.payload, dimension_names: detail.dimension_names,
        published_packages: detail.published_packages, assets: detail.assets,
        source_evidence: detail.source_evidence };
    });

    /** 知识点、题型、错因与诊断规则的复核详情。路由只接受白名单实体，
     *  来源片段按 fragment 聚合，避免一个来源因多字段血缘重复显示。 */
    app.get("/entities/:type/:id/review", async (req, reply) => {
      const tenantId=tenantOf(req),actor=actorOf(req);
      if(!tenantId||!actor)return reply.code(400).send({error:"missing tenant/actor headers"});
      const {type,id}=req.params as {type:string;id:string};
      const configs:Record<string,{table:string;idColumn:string;nameColumn?:string}>={
        knowledge_component:{table:"content_knowledge_component",idColumn:"dimension_id",nameColumn:"name"},
        question_type:{table:"content_question_type",idColumn:"dimension_id",nameColumn:"name"},
        error_cause:{table:"content_error_cause",idColumn:"dimension_id",nameColumn:"name"},
        diagnosis_rule:{table:"content_diagnosis_rule",idColumn:"rule_id"},
      };
      const config=configs[type];
      if(!config)return reply.code(422).send({error:"unsupported review entity type"});
      const out=await withTenant(pool,tenantId,async(c)=>{
        const row=(await c.query(
          `select distinct on(e.${config.idColumn}) e.${config.idColumn} as id,e.payload${config.nameColumn?`,e.${config.nameColumn} as name`:""}
             from ${config.table} e join content_entity_scope s
               on s.tenant_id=e.tenant_id and s.entity_type=$2 and s.entity_id=e.${config.idColumn}
            where e.${config.idColumn}=$1 and ${visibleScopeSql("s","$3",isTenantAdmin(req))}
            order by e.${config.idColumn}`,[id,type,actor])).rows[0];
        if(!row)return null;
        const evidence=(await c.query(
          `select l.source_fragment_id,f.document_id,f.page_no,f.fragment_type,f.bbox,
                  left(coalesce(f.payload->>'text_markdown',''),2400) as excerpt,
                  jsonb_agg(distinct l.field_path order by l.field_path) as field_paths
             from content_field_lineage l left join content_source_fragment f on f.fragment_id=l.source_fragment_id
            where l.entity_type=$1 and l.entity_id=$2 and l.source_fragment_id is not null
            group by l.source_fragment_id,f.document_id,f.page_no,f.fragment_type,f.bbox,f.payload
            order by f.document_id,f.page_no,l.source_fragment_id`,[type,id])).rows;
        const related=(type==="knowledge_component"||type==="question_type")?(await c.query(
          `select q.question_id,q.stem_format,left(q.payload->>'stem_markdown',240) as stem
             from content_measurement_target mt join content_question q on q.question_id=mt.question_id
            where mt.dim=$1 order by q.question_id`,[id])).rows:[];
        return {...row.payload,id,name:row.name??row.payload?.name,source_evidence:evidence,related_questions:related};
      });
      return out??reply.code(404).send({error:"review entity not found in your content library"});
    });

    /** 内部/教师题卡：含判答规格。content 服务不直接暴露公网。 */
    app.get("/questions/:id", async (req, reply) => {
      const tenantId = tenantOf(req);
      const actor = actorOf(req);
      if (!tenantId || !actor) return reply.code(400).send({ error: "missing tenant/actor headers" });
      const { id } = req.params as { id: string };
      const detail = await loadQuestionDetail(tenantId, actor, isTenantAdmin(req), id);
      if (!detail) return reply.code(404).send({ error: "question not found or not published" });
      return { ...detail.payload, published_packages: detail.published_packages, assets: detail.assets };
    });

    /** 已发布题目列表（选题器候选源，§10 阶段 B）：id/测量目标/可验证性 */
    app.get("/questions", async (req, reply) => {
      const tenantId = tenantOf(req);
      const actor = actorOf(req);
      if (!tenantId || !actor) return reply.code(400).send({ error: "missing tenant/actor headers" });
      const rows = await withTenant(pool, tenantId, async (c) => {
        const visible=visibleScopeSql("s","$1",isTenantAdmin(req));
        const r = await c.query(
          `select distinct question_id, tags, measurement_dims, coalesce((payload->>'difficulty')::double precision,0.5) as difficulty,
                  (payload->'measurement_targets') as measurement_targets,
                  (payload->'rubric'->'items') is not null as answer_verifiable
             from content_question q join content_entity_scope s on s.tenant_id=q.tenant_id and s.entity_type='question' and s.entity_id=q.question_id
            where q.published and ${visible}
            order by question_id`,
          [actor],
        );
        return r.rows;
      });
      return {
        questions: rows.map((r) => ({
          question_id: r.question_id,
          tags: r.tags,
          measurement_dims: r.measurement_dims,
          measurement_targets: r.measurement_targets ?? [],
          difficulty: r.difficulty,
          answer_verifiable: r.answer_verifiable === true,
        })),
      };
    });

    /**
     * 诊断上下文（§8.3 / P0-7：候选只能来自题目关联 E-ID 与诊断规则）：
     * 由本题测量维度（K/T）→ 适用诊断规则（dimension_ids 重叠）→ 规则引用的错因，
     * 形成可证明的关联链 Q→K/T→R→E。错因带 related_dims（规则维度并集），供消歧目标维度使用。
     */
    app.get("/questions/:id/diagnosis-context", async (req, reply) => {
      const tenantId = tenantOf(req);
      const actor = actorOf(req);
      if (!tenantId || !actor) return reply.code(400).send({ error: "missing tenant/actor headers" });
      const { id } = req.params as { id: string };
      const out = await withTenant(pool, tenantId, async (c) => {
        const visible=visibleScopeSql("s","$2",isTenantAdmin(req));
        const q = await c.query(
          `select distinct q.payload from content_question q join content_entity_scope s on s.tenant_id=q.tenant_id and s.entity_type='question' and s.entity_id=q.question_id
            where q.question_id=$1 and q.published and ${visible}`,
          [id,actor],
        );
        if (q.rows.length === 0) return { status: 404 as const };
        const question = q.rows[0].payload as { measurement_dims?: string[]; measurement_targets?: { dim?: string }[] };
        const dims = [...new Set([
          ...(question.measurement_dims ?? []),
          ...(question.measurement_targets ?? []).map((t) => t.dim ?? "").filter(Boolean),
        ])];
        let rules: { rule_id: string; payload: { rule_id: string; trigger: string; candidate_error_causes?: string[]; probe?: string; dimension_ids?: string[] } }[] = [];
        if (dims.length > 0) {
          const r = await c.query(
            `select distinct r.rule_id,r.payload from content_diagnosis_rule r
              join content_entity_scope s on s.tenant_id=r.tenant_id and s.entity_type='diagnosis_rule' and s.entity_id=r.rule_id
             where r.payload->'dimension_ids' ?| $1::text[] and ${visibleScopeSql("s","$2",isTenantAdmin(req))}`,
            [dims,actor],
          );
          rules = r.rows as typeof rules;
        }
        // 错因：适用规则引用的 E 集合，related_dims = 引用它的规则维度并集
        const eIds = [...new Set(rules.flatMap((r) => r.payload.candidate_error_causes ?? []))];
        const ecRows = eIds.length > 0
          ? await c.query(`select distinct e.dimension_id,e.payload from content_error_cause e
              join content_entity_scope s on s.tenant_id=e.tenant_id and s.entity_type='error_cause' and s.entity_id=e.dimension_id
             where e.dimension_id=any($1) and ${visibleScopeSql("s","$2",isTenantAdmin(req))}`,[eIds,actor])
          : { rows: [] as { dimension_id: string; payload: { dimension_id: string; name: string; description?: string } }[] };
        const errorCauses = ecRows.rows.map((e) => ({
          ...e.payload,
          related_dims: [...new Set(rules
            .filter((r) => (r.payload.candidate_error_causes ?? []).includes(e.dimension_id))
            .flatMap((r) => r.payload.dimension_ids ?? []))],
        }));
        return {
          status: 200 as const,
          body: {
            question_id: id,
            question: q.rows[0].payload,
            error_causes: errorCauses,
            diagnosis_rules: rules.map((r) => r.payload),
          },
        };
      });
      if (out.status === 404) return reply.code(404).send({ error: "question not found or not published" });
      return out.body;
    });

    /** 验收：任一正式字段可追溯到片段/页码、Agent Run、模型、Prompt、审核决定（设计 §7.3） */
    app.get("/questions/:id/lineage", async (req, reply) => {
      const tenantId = tenantOf(req);
      const actor = actorOf(req);
      if (!tenantId || !actor) return reply.code(400).send({ error: "missing tenant/actor headers" });
      const { id } = req.params as { id: string };
      const rows = await withTenant(pool, tenantId, async (c) => {
        const r = await c.query(
          `select distinct l.field_path, l.provenance_status, l.derivation_type, l.source_fragment_id,
                  f.page_no, f.document_id, l.agent_run_id, l.prompt_version, l.model_id,
                  l.reviewer_id, l.review_decision, l.confidence, l.created_at
             from content_field_lineage l
             left join content_source_fragment f on f.fragment_id = l.source_fragment_id
             join content_entity_scope s on s.tenant_id=l.tenant_id and s.entity_type='question' and s.entity_id=l.entity_id
            where l.entity_type = 'question' and l.entity_id = $1 and ${visibleScopeSql("s","$2",isTenantAdmin(req))}
            order by l.created_at, l.field_path`,
          [id,actor],
        );
        return r.rows;
      });
      if (rows.length === 0) return reply.code(404).send({ error: "no lineage recorded" });
      return { question_id: id, lineage: rows };
    });
  },
});
