import type pg from "pg";
import {
  finiteNumber,
  jsonObject,
  newId,
  stringValue,
  type Principal,
  withPrincipal,
} from "./lib.ts";

type Json = Record<string, unknown>;

export interface PaperCounts {
  single_choice: number;
  multiple_choice: number;
  fill_blank: number;
  true_false: number;
  open_solution: number;
}

export interface PaperConfig {
  counts: PaperCounts;
  difficulty_ratio: { easy: number; medium: number; hard: number };
}

const COUNT_KEYS = ["single_choice", "multiple_choice", "fill_blank", "true_false", "open_solution"] as const;

const STEM_TO_COUNT_KEY: Record<string, keyof PaperCounts> = {
  single_choice: "single_choice",
  multiple_choice: "multiple_choice",
  fill_blank: "fill_blank",
  true_false: "true_false",
  open_solution: "open_solution",
};

const TYPE_LABEL: Record<string, string> = {
  single_choice: "选择题",
  multiple_choice: "多选题",
  fill_blank: "填空题",
  true_false: "判断题",
  open_solution: "解答题",
};

function shuffle<T>(items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function parseCounts(raw: unknown): PaperCounts {
  const counts = jsonObject(raw);
  const parsed = {} as PaperCounts;
  for (const key of COUNT_KEYS) {
    const value = parseInt(String(counts[key] ?? 0), 10);
    if (!Number.isInteger(value) || value < 0 || value > 200) {
      throw new Error("question counts must be non-negative integers (max 200 per type)");
    }
    parsed[key] = value;
  }
  if (COUNT_KEYS.reduce((sum, key) => sum + parsed[key], 0) < 1) {
    throw new Error("paper must contain at least one question");
  }
  return parsed;
}

function parseConfig(raw: unknown): PaperConfig {
  const config = jsonObject(raw);
  const counts = parseCounts(config.counts);
  const ratio = jsonObject(config.difficulty_ratio);
  const easy = finiteNumber(ratio.easy, 0);
  const medium = finiteNumber(ratio.medium, 0);
  const hard = finiteNumber(ratio.hard, 0);
  if (easy < 0 || medium < 0 || hard < 0) throw new Error("difficulty ratio parts must be non-negative");
  if (easy + medium + hard <= 0) throw new Error("difficulty ratio must sum to a positive total");
  return { counts, difficulty_ratio: { easy, medium, hard } };
}

export class PaperRepository {
  constructor(private readonly pool: pg.Pool) {}

  async listPapers(principal: Principal): Promise<Json[]> {
    return withPrincipal(this.pool, principal, async (client) => {
      const result = await client.query(
        `select p.paper_id,p.title,p.version_no,p.status,p.source,p.config_snapshot,p.pdf_sha256,p.created_at,p.finalized_at,
                count(i.revision_id)::int as item_count
           from content_paper p left join content_paper_item i on i.paper_id=p.paper_id
          where p.tenant_id=$1 and p.owner_teacher_user_id=$2
          group by p.paper_id order by p.created_at desc limit 100`,
        [principal.tenantId, principal.userId],
      );
      return result.rows as Json[];
    });
  }

  async getPaper(principal: Principal, paperId: string): Promise<Json | null> {
    return withPrincipal(this.pool, principal, async (client) => {
      const paper = await client.query<{
        paper_id: string; title: string; version_no: number; status: string; source: string;
        config_snapshot: Json; pdf_object_id: string | null; pdf_sha256: string | null; created_at: string; finalized_at: string | null;
        answer_pdf_object_id: string | null; answer_pdf_sha256: string | null;
      }>(
        `select paper_id,title,version_no,status,source,config_snapshot,pdf_object_id,pdf_sha256,created_at,finalized_at,
                answer_pdf_object_id,answer_pdf_sha256
           from content_paper where tenant_id=$1 and paper_id=$2 and owner_teacher_user_id=$3`,
        [principal.tenantId, paperId, principal.userId],
      );
      if (!paper.rows[0]) return null;
      const items = await client.query(
        `select i.item_order,i.entity_id,i.revision_id,i.difficulty,
                qr.stem_format,qr.chapter_id,qr.stem_markdown,qr.analysis_markdown,tr.name as question_type_name,
                st.item_data, ans.answer_text, rub.rubric
           from content_paper_item i
           join content_entity_revision r on r.revision_id=i.revision_id and r.tenant_id=i.tenant_id
           join content_question_revision qr on qr.revision_id=i.revision_id
           left join content_question_type_revision tr on tr.revision_id=qr.question_type_revision_id
           left join lateral (
             select jsonb_agg(jsonb_build_object('option_key', o.option_key, 'option_text', o.option_text)
                             order by ri.position) as item_data
               from content_revision_item ri
               join content_question_option o on o.item_id=ri.item_id
              where ri.revision_id=i.revision_id and ri.item_kind='question_option'
           ) as st on true
           left join lateral (
             select string_agg(a.answer_text, ' ' order by ri.position) as answer_text
               from content_revision_item ri
               join content_question_answer_item a on a.item_id=ri.item_id
              where ri.revision_id=i.revision_id and ri.item_kind='question_answer'
           ) as ans on true
           left join lateral (
             select jsonb_agg(jsonb_build_object('criterion', r.criterion, 'score', r.score)
                             order by ri.position) as rubric
               from content_revision_item ri
               join content_question_rubric_item r on r.item_id=ri.item_id
              where ri.revision_id=i.revision_id and ri.item_kind='question_rubric'
           ) as rub on true
          where i.tenant_id=$1 and i.paper_id=$2
          order by i.item_order`,
        [principal.tenantId, paperId],
      );
      return {
        ...paper.rows[0],
        config: paper.rows[0].config_snapshot,
        items: items.rows.map((row) => ({
          item_order: row.item_order,
          entity_id: row.entity_id,
          revision_id: row.revision_id,
          difficulty: row.difficulty,
          stem_format: row.stem_format,
          chapter_id: row.chapter_id,
          question_type_name: row.question_type_name,
          stem_markdown: row.stem_markdown,
          analysis_markdown: row.analysis_markdown ?? "",
          answer_text: row.answer_text ?? "",
          rubric: row.rubric ?? [],
          options: row.item_data ?? [],
        })),
      };
    });
  }

  /** 教师自选题目创建 draft 试卷：校验题目归属/形态/数量与配置一致。 */
  async createManualPaper(principal: Principal, title: string, config: PaperConfig, revisions: Array<{ entity_id: string; revision_id: string }>): Promise<Json> {
    const cleanTitle = String(title ?? "").trim().slice(0, 200) || "未命名试卷";
    const parsedConfig = parseConfig(config);
    const ids = [...new Set(revisions.map((row) => String(row.revision_id).trim()).filter(Boolean))];
    if (!ids.length) throw new Error("select at least one question");
    return withPrincipal(this.pool, principal, async (client) => {
      const picks = await client.query<{ entity_id: string; revision_id: string; entity_kind: string; owner_teacher_user_id: string; lifecycle_status: string; stem_format: string; difficulty: number | null }>(
        `select e.entity_id,e.entity_kind,e.owner_teacher_user_id,r.revision_id,r.lifecycle_status,qr.stem_format,qr.difficulty
           from content_entity e
           join content_entity_revision r on r.entity_id=e.entity_id and r.tenant_id=e.tenant_id
           join content_question_revision qr on qr.revision_id=r.revision_id
          where r.tenant_id=$1 and r.revision_id=any($2::text[])`,
        [principal.tenantId, ids],
      );
      if (picks.rows.length !== ids.length) throw new Error("some selected questions are not found");
      const byRevision = new Map(picks.rows.map((row) => [row.revision_id, row]));
      const used = new Set<string>();
      const buckets: Record<string, number> = {};
      for (const key of COUNT_KEYS) buckets[key] = 0;
      for (const row of picks.rows) {
        if (row.entity_kind !== "question") throw new Error("only question revisions can be selected");
        if (row.owner_teacher_user_id !== principal.userId) throw new Error("question is not owned by this teacher");
        if (row.lifecycle_status !== "approved" && row.lifecycle_status !== "ready") throw new Error("question revision is not approved");
        if (used.has(row.entity_id)) throw new Error("duplicate question in selection");
        used.add(row.entity_id);
        const bucket = STEM_TO_COUNT_KEY[row.stem_format];
        if (!bucket) throw new Error(`unsupported stem_format for paper: ${row.stem_format}`);
        buckets[bucket] = (buckets[bucket] ?? 0) + 1;
      }
      for (const key of COUNT_KEYS) {
        if (buckets[key] !== parsedConfig.counts[key]) {
          throw new Error(`${key} count mismatch: selected ${buckets[key]}, config ${parsedConfig.counts[key]}`);
        }
      }
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`paper-version:${principal.tenantId}:${principal.userId}`]);
      const version = await client.query<{ version_no: number }>(
        `select coalesce(max(version_no),0)+1 as version_no from content_paper where tenant_id=$1 and owner_teacher_user_id=$2`,
        [principal.tenantId, principal.userId],
      );
      const paperId = newId("paper");
      const versionNo = Number(version.rows[0]?.version_no ?? 1);
      await client.query(
        `insert into content_paper(paper_id,tenant_id,owner_teacher_user_id,title,version_no,status,source,config_snapshot)
         values ($1,$2,$3,$4,$5,'draft','manual',$6::jsonb)`,
        [paperId, principal.tenantId, principal.userId, cleanTitle, versionNo, JSON.stringify(parsedConfig)],
      );
      let order = 0;
      for (const revisionId of ids) {
        const row = byRevision.get(revisionId)!;
        const difficulty = row.difficulty ?? 0.5;
        await client.query(
          `insert into content_paper_item(tenant_id,paper_id,entity_id,revision_id,item_order,difficulty)
           values ($1,$2,$3,$4,$5,$6)`,
          [principal.tenantId, paperId, row.entity_id, revisionId, order, difficulty],
        );
        order += 1;
      }
      return { paper_id: paperId, title: cleanTitle, version_no: versionNo, status: "draft", item_count: ids.length };
    });
  }

  /** 自动组卷：按配置（题型×题量、难度比例）从教师已解析的问题池抽样成卷。 */
  async createAutoPaper(principal: Principal, title: string, config: PaperConfig): Promise<Json> {
    const cleanTitle = String(title ?? "").trim().slice(0, 200) || "自动组卷";
    const parsedConfig = parseConfig(config);
    const required = COUNT_KEYS.reduce((sum, key) => sum + parsedConfig.counts[key], 0);
    if (required < 1) throw new Error("paper must contain at least one question");
    return withPrincipal(this.pool, principal, async (client) => {
      const pool = await client.query<{ entity_id: string; revision_id: string; stem_format: string; difficulty: number }>(
        `select distinct on (e.entity_id) e.entity_id, r.revision_id, qr.stem_format, qr.difficulty
           from content_entity e
           join content_entity_revision r on r.entity_id=e.entity_id and r.tenant_id=e.tenant_id
           join content_question_revision qr on qr.revision_id=r.revision_id
          where e.tenant_id=$1 and e.entity_kind='question' and e.origin='teacher'
            and e.owner_teacher_user_id=$2 and r.lifecycle_status in ('approved','ready')
            and qr.stem_format in ('single_choice','multiple_choice','fill_blank','true_false','open_solution')
          order by e.entity_id, r.revision_no desc`,
        [principal.tenantId, principal.userId],
      );
      const byType = new Map<string, Array<{ entity_id: string; revision_id: string; difficulty: number }>>();
      for (const row of pool.rows) {
        const list = byType.get(row.stem_format) ?? [];
        list.push({ entity_id: row.entity_id, revision_id: row.revision_id, difficulty: row.difficulty ?? 0.5 });
        byType.set(row.stem_format, list);
      }
      const ratio = parsedConfig.difficulty_ratio;
      const ratioTotal = ratio.easy + ratio.medium + ratio.hard;
      type Bucket = "easy" | "medium" | "hard";
      const bucket = (difficulty: number): Bucket => difficulty < 0.33 ? "easy" : difficulty <= 0.67 ? "medium" : "hard";
      const picks: Array<{ entity_id: string; revision_id: string; difficulty: number }> = [];
      const used = new Set<string>();
      // 优先在对应难度桶里取样，桶不足时回退到该题型的其它难度。
      for (const [stemFormat, countKey] of Object.entries(STEM_TO_COUNT_KEY)) {
        const need = parsedConfig.counts[countKey as keyof PaperCounts];
        if (need < 1) continue;
        const candidates = byType.get(stemFormat) ?? [];
        if (candidates.length < need) throw new Error(`题目池不足：${TYPE_LABEL[countKey] ?? stemFormat} 需要 ${need} 道，可用 ${candidates.length} 道`);
        const byBucket = new Map<Bucket, Array<{ entity_id: string; revision_id: string; difficulty: number }>>();
        for (const c of candidates) {
          const b = bucket(c.difficulty);
          if (!byBucket.get(b)) byBucket.set(b, []);
          byBucket.get(b)!.push(c);
        }
        // 期望该题型分配到每个难度桶的题量
        let remaining = need;
        const order: Bucket[] = (["easy", "medium", "hard"] as const).filter((b) => byBucket.has(b));
        if (order.length === 0) throw new Error(`无可用${TYPE_LABEL[countKey] ?? stemFormat}题目`);
        // 按比例目标值排序桶，先取比例配额，余量再补充
        const targetOf = (b: Bucket): number => Math.round((need * ratio[b]) / ratioTotal);
        for (const b of [...order].sort((x, y) => targetOf(y) - targetOf(x))) {
          if (remaining <= 0) break;
          const available = byBucket.get(b)!.filter((c) => !used.has(c.entity_id));
          const take = Math.min(remaining, targetOf(b), available.length);
          const sampled = take >= available.length ? available : shuffle(available).slice(0, take);
          for (const c of sampled) { used.add(c.entity_id); picks.push(c); }
          remaining -= sampled.length;
        }
        if (remaining > 0) {
          const rest = order.flatMap((b) => byBucket.get(b) ?? []).filter((c) => !used.has(c.entity_id));
          if (rest.length < remaining) throw new Error(`题目池不足：${TYPE_LABEL[countKey] ?? stemFormat} 剩余 ${rest.length} 道`);
          for (const c of shuffle(rest).slice(0, remaining)) { used.add(c.entity_id); picks.push(c); }
        }
      }
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`paper-version:${principal.tenantId}:${principal.userId}`]);
      const version = await client.query<{ version_no: number }>(
        `select coalesce(max(version_no),0)+1 as version_no from content_paper where tenant_id=$1 and owner_teacher_user_id=$2`,
        [principal.tenantId, principal.userId],
      );
      const paperId = newId("paper");
      const versionNo = Number(version.rows[0]?.version_no ?? 1);
      await client.query(
        `insert into content_paper(paper_id,tenant_id,owner_teacher_user_id,title,version_no,status,source,config_snapshot)
         values ($1,$2,$3,$4,$5,'draft','auto',$6::jsonb)`,
        [paperId, principal.tenantId, principal.userId, cleanTitle, versionNo, JSON.stringify(parsedConfig)],
      );
      let order = 0;
      for (const c of picks) {
        await client.query(
          `insert into content_paper_item(tenant_id,paper_id,entity_id,revision_id,item_order,difficulty)
           values ($1,$2,$3,$4,$5,$6)`,
          [principal.tenantId, paperId, c.entity_id, c.revision_id, order, c.difficulty],
        );
        order += 1;
      }
      return { paper_id: paperId, title: cleanTitle, version_no: versionNo, status: "draft", item_count: picks.length };
    });
  }

  /** 预览换题：同一槽位替换 revision（可选调难度），仅 draft。 */
  async patchItem(principal: Principal, paperId: string, order: number, input: { revision_id?: string; difficulty?: number | null }): Promise<Json> {
    return withPrincipal(this.pool, principal, async (client) => {
      const paper = await client.query<{ status: string }>(
        `select status from content_paper where tenant_id=$1 and paper_id=$2 and owner_teacher_user_id=$3 for update`,
        [principal.tenantId, paperId, principal.userId],
      );
      if (!paper.rows[0] || paper.rows[0].status !== "draft") throw new Error("paper is not editable");
      const current = await client.query<{ entity_id: string }>(
        `select entity_id from content_paper_item where tenant_id=$1 and paper_id=$2 and item_order=$3`,
        [principal.tenantId, paperId, order],
      );
      if (!current.rows[0]) throw new Error("paper item not found");
      if (input.revision_id !== undefined) {
        const replacement = await client.query<{ entity_id: string; difficulty: number | null }>(
          `select e.entity_id, qr.difficulty from content_entity e
             join content_entity_revision r on r.entity_id=e.entity_id and r.tenant_id=e.tenant_id
             join content_question_revision qr on qr.revision_id=r.revision_id
            where r.tenant_id=$1 and r.revision_id=$2 and e.owner_teacher_user_id=$3
              and r.lifecycle_status in ('approved','ready')`,
          [principal.tenantId, input.revision_id, principal.userId],
        );
        if (!replacement.rows[0]) throw new Error("replacement revision is not available");
        await client.query(
          `update content_paper_item set revision_id=$4, difficulty=$5
            where tenant_id=$1 and paper_id=$2 and item_order=$3`,
          [principal.tenantId, paperId, order, input.revision_id, replacement.rows[0].difficulty ?? null],
        );
      } else if (input.difficulty !== undefined && input.difficulty !== null) {
        const difficulty = finiteNumber(input.difficulty, 0.5);
        await client.query(
          `update content_paper_item set difficulty=$4 where tenant_id=$1 and paper_id=$2 and item_order=$3`,
          [principal.tenantId, paperId, order, difficulty],
        );
      }
      return { ok: true };
    });
  }

  /** 自动换题：从教师题池按同题型+目标难度选一道未使用题目替换。 */
  async swapItem(principal: Principal, paperId: string, order: number, input: { action?: "harder" | "easier" | "same" }): Promise<Json> {
    return withPrincipal(this.pool, principal, async (client) => {
      const paper = await client.query<{ status: string }>(
        `select status from content_paper where tenant_id=$1 and paper_id=$2 and owner_teacher_user_id=$3 for update`,
        [principal.tenantId, paperId, principal.userId],
      );
      if (!paper.rows[0] || paper.rows[0].status !== "draft") throw new Error("paper is not editable");
      const current = await client.query<{ entity_id: string; stem_format: string; difficulty: number }>(
        `select i.entity_id, qr.stem_format, i.difficulty
           from content_paper_item i join content_question_revision qr on qr.revision_id=i.revision_id
          where i.tenant_id=$1 and i.paper_id=$2 and i.item_order=$3`,
        [principal.tenantId, paperId, order],
      );
      if (!current.rows[0]) throw new Error("paper item not found");
      const currentEntity = current.rows[0].entity_id;
      const stemFormat = current.rows[0].stem_format;
      const base = current.rows[0].difficulty ?? 0.5;
      const target = input.action === "harder" ? Math.min(base + 0.2, 1) : input.action === "easier" ? Math.max(base - 0.2, 0) : base;
      const result = await client.query(
        `with latest as (
           select distinct on (e.entity_id) e.entity_id, r.revision_id, qr.stem_format, qr.difficulty
             from content_entity e
             join content_entity_revision r on r.entity_id=e.entity_id and r.tenant_id=e.tenant_id
             join content_question_revision qr on qr.revision_id=r.revision_id
            where e.tenant_id=$1 and e.entity_kind='question' and e.origin='teacher'
              and e.owner_teacher_user_id=$2 and r.lifecycle_status in ('approved','ready')
              and qr.stem_format=$4
            order by e.entity_id, r.revision_no desc
         )
         select l.entity_id, l.revision_id, l.difficulty
           from latest l
          where l.entity_id <> $5
          order by abs(coalesce(l.difficulty,0.5)-$3) asc
          limit 1`,
        [principal.tenantId, principal.userId, target, stemFormat, currentEntity],
      );
      if (!result.rows[0]) throw new Error("no replacement question available with the same type");
      await client.query(
        `update content_paper_item set revision_id=$4, difficulty=$5
          where tenant_id=$1 and paper_id=$2 and item_order=$3`,
        [principal.tenantId, paperId, order, result.rows[0].revision_id, result.rows[0].difficulty ?? target],
      );
      return { ok: true, revision_id: result.rows[0].revision_id, difficulty: result.rows[0].difficulty ?? target };
    });
  }

  /** 记录导出的 PDF 成品（storage_object）。finalized 后首次落 PDF 被守卫允许，之后锁定。 */
  async setPaperPdf(principal: Principal, paperId: string, objectId: string, sha256: string): Promise<boolean> {
    return withPrincipal(this.pool, principal, async (client) => {
      const result = await client.query(
        `update content_paper set pdf_object_id=$4, pdf_sha256=$5
          where tenant_id=$1 and paper_id=$2 and owner_teacher_user_id=$3 returning paper_id`,
        [principal.tenantId, paperId, principal.userId, objectId, sha256],
      );
      return (result.rowCount ?? 0) === 1;
    });
  }

  /** 记录导出的答案解析 PDF 成品。finalized 后首次落盘被守卫允许，之后锁定。 */
  async setPaperAnswerPdf(principal: Principal, paperId: string, objectId: string, sha256: string): Promise<boolean> {
    return withPrincipal(this.pool, principal, async (client) => {
      const result = await client.query(
        `update content_paper set answer_pdf_object_id=$4, answer_pdf_sha256=$5
          where tenant_id=$1 and paper_id=$2 and owner_teacher_user_id=$3 returning paper_id`,
        [principal.tenantId, paperId, principal.userId, objectId, sha256],
      );
      return (result.rowCount ?? 0) === 1;
    });
  }

  /** 读取逐题答案解析草稿（组卷答案）。 */
  async getAnswerItems(principal: Principal, paperId: string): Promise<Json[]> {
    return withPrincipal(this.pool, principal, async (client) => {
      const result = await client.query(
        `select item_order,answer_text,analysis_text,need_review,review_note,source,updated_at
           from content_paper_answer_item
          where tenant_id=$1 and paper_id=$2 order by item_order`,
        [principal.tenantId, paperId],
      );
      return result.rows as Json[];
    });
  }

  /** 保存教师复核后的逐题答案解析（覆盖式 upsert）。 */
  async upsertAnswerItems(principal: Principal, paperId: string, items: Array<{
    item_order: number;
    answer_text: string;
    analysis_text: string;
    need_review: boolean;
    review_note: string | null;
  }>): Promise<void> {
    return withPrincipal(this.pool, principal, async (client) => {
      const paper = await client.query<{ status: string }>(
        `select status from content_paper where tenant_id=$1 and paper_id=$2 and owner_teacher_user_id=$3`,
        [principal.tenantId, paperId, principal.userId],
      );
      if (!paper.rows[0]) throw new Error("paper not found");
      if (paper.rows[0].status !== "finalized") throw new Error("answer analysis is only available after finalization");
      for (const item of items) {
        const order = Number(item.item_order);
        if (!Number.isInteger(order) || order < 0) throw new Error("item_order must be a non-negative integer");
        const answer = String(item.answer_text ?? "").trim().slice(0, 4000);
        const analysis = String(item.analysis_text ?? "").trim().slice(0, 12000);
        const needReview = Boolean(item.need_review);
        const reviewNote = item.review_note ? String(item.review_note).trim().slice(0, 2000) : null;
        await client.query(
          `insert into content_paper_answer_item(paper_id,tenant_id,item_order,answer_text,analysis_text,need_review,review_note,source,updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,'teacher',now())
           on conflict (paper_id,item_order) do update set
             answer_text=excluded.answer_text, analysis_text=excluded.analysis_text,
             need_review=excluded.need_review, review_note=excluded.review_note,
             source='teacher', updated_at=now()`,
          [paperId, principal.tenantId, order, answer, analysis, needReview, reviewNote],
        );
      }
    });
  }

  /** 覆盖式写入 prepare 生成的答案解析草稿（题库答案 + AI 补全）。 */
  async replaceAnswerItems(principal: Principal, paperId: string, items: Array<{
    item_order: number;
    answer_text: string;
    analysis_text: string;
    need_review: boolean;
    review_note: string | null;
    source: string;
  }>): Promise<void> {
    return withPrincipal(this.pool, principal, async (client) => {
      await client.query(
        `delete from content_paper_answer_item where tenant_id=$1 and paper_id=$2`,
        [principal.tenantId, paperId],
      );
      for (const item of items) {
        const order = Number(item.item_order);
        const answer = String(item.answer_text ?? "").trim().slice(0, 4000);
        const analysis = String(item.analysis_text ?? "").trim().slice(0, 12000);
        const needReview = Boolean(item.need_review);
        const reviewNote = item.review_note ? String(item.review_note).trim().slice(0, 2000) : null;
        const source = item.source === "ai" || item.source === "teacher" ? item.source : "bank";
        await client.query(
          `insert into content_paper_answer_item(paper_id,tenant_id,item_order,answer_text,analysis_text,need_review,review_note,source,updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,now())`,
          [paperId, principal.tenantId, order, answer, analysis, needReview, reviewNote, source],
        );
      }
    });
  }

  async finalizePaper(principal: Principal, paperId: string): Promise<Json> {
    return withPrincipal(this.pool, principal, async (client) => {
      const result = await client.query(
        `update content_paper set status='finalized', finalized_at=now()
          where tenant_id=$1 and paper_id=$2 and owner_teacher_user_id=$3 and status='draft'
          returning paper_id`,
        [principal.tenantId, paperId, principal.userId],
      );
      if (!result.rows[0]) throw new Error("paper not found or already finalized");
      return { paper_id: paperId, status: "finalized" };
    });
  }

  /** 版本迭代：复制标题+配置+题目为新 draft（version_no+1）。 */
  async iteratePaper(principal: Principal, paperId: string): Promise<Json> {
    return withPrincipal(this.pool, principal, async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`paper-version:${principal.tenantId}:${principal.userId}`]);
      const source = await client.query<{ title: string; config_snapshot: Json }>(
        `select title,config_snapshot from content_paper where tenant_id=$1 and paper_id=$2 and owner_teacher_user_id=$3`,
        [principal.tenantId, paperId, principal.userId],
      );
      if (!source.rows[0]) throw new Error("paper not found");
      const version = await client.query<{ version_no: number }>(
        `select coalesce(max(version_no),0)+1 as version_no from content_paper where tenant_id=$1 and owner_teacher_user_id=$2`,
        [principal.tenantId, principal.userId],
      );
      const paperIdNew = newId("paper");
      const versionNo = Number(version.rows[0]?.version_no ?? 1);
      await client.query(
        `insert into content_paper(paper_id,tenant_id,owner_teacher_user_id,title,version_no,status,source,config_snapshot)
         values ($1,$2,$3,$4,$5,'draft','manual',$6::jsonb)`,
        [paperIdNew, principal.tenantId, principal.userId, source.rows[0].title, versionNo, JSON.stringify(source.rows[0].config_snapshot)],
      );
      const items = await client.query<{ entity_id: string; revision_id: string; difficulty: number | null }>(
        `select entity_id,revision_id,difficulty from content_paper_item where tenant_id=$1 and paper_id=$2 order by item_order`,
        [principal.tenantId, paperId],
      );
      for (const [index, item] of items.rows.entries()) {
        await client.query(
          `insert into content_paper_item(tenant_id,paper_id,entity_id,revision_id,item_order,difficulty) values ($1,$2,$3,$4,$5,$6)`,
          [principal.tenantId, paperIdNew, item.entity_id, item.revision_id, index, item.difficulty],
        );
      }
      return { paper_id: paperIdNew, version_no: versionNo, status: "draft", item_count: items.rows.length };
    });
  }

  async renamePaper(principal: Principal, paperId: string, title: string): Promise<boolean> {
    const cleanTitle = String(title ?? "").trim().slice(0, 200);
    if (!cleanTitle) return false;
    return withPrincipal(this.pool, principal, async (client) => {
      const result = await client.query(
        `update content_paper set title=$4 where tenant_id=$1 and paper_id=$2 and owner_teacher_user_id=$3 returning paper_id`,
        [principal.tenantId, paperId, principal.userId, cleanTitle],
      );
      return (result.rowCount ?? 0) === 1;
    });
  }

  async deletePaper(principal: Principal, paperId: string): Promise<boolean> {
    return withPrincipal(this.pool, principal, async (client) => {
      const result = await client.query(
        `delete from content_paper where tenant_id=$1 and paper_id=$2 and owner_teacher_user_id=$3 and status='draft' returning paper_id`,
        [principal.tenantId, paperId, principal.userId],
      );
      return (result.rowCount ?? 0) === 1;
    });
  }
}