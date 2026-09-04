// self-test 域：content 库只读查询（知识点树 / 可抽题池 / 题目素材 / 判答依据）。
// 全部 SQL 在 withPrincipal 事务内执行（RLS 已按 current_* 生效）。
import type pg from "pg";

export const SELF_TEST_FORMATS = ["single_choice", "fill_blank"] as const;
export type SelfTestFormat = (typeof SELF_TEST_FORMATS)[number];

// 最新 ready revision 的可抽题（choice/fill、带 answer_item、学生可见）
const DRAWABLE_BASE_SQL = `
with latest_q as (
  select distinct on (e.entity_id) e.entity_id, r.revision_id
    from content_entity e
    join content_entity_revision r on r.tenant_id = e.tenant_id and r.entity_id = e.entity_id
   where e.tenant_id = $1 and e.entity_kind = 'question' and r.lifecycle_status = 'ready'
   order by e.entity_id, r.revision_no desc
), q as (
  select lq.entity_id, qr.revision_id, qr.stem_format, qr.difficulty
    from latest_q lq
    join content_question_revision qr
      on qr.tenant_id = $1 and qr.revision_id = lq.revision_id
   where qr.stem_format in ('single_choice','fill_blank')
     and exists (
       select 1 from content_revision_item i
        join content_question_answer_item a using(item_id)
       where i.tenant_id = $1 and i.revision_id = qr.revision_id
     )
     and mathpilot_content_entity_visible($1,$2,array['student']::text[],'question',lq.entity_id,false)
), mt as (
  select i.revision_id as question_revision_id, m.dimension_revision_id as dimension_revision_id
    from content_revision_item i
    join content_question_measurement_target m using(item_id)
   where i.tenant_id = $1 and i.item_kind = 'question_measurement_target'
)
`;

export interface KnowledgePointRow {
  knowledgeId: string;          // K_TRI_002
  name: string;
  gradeBand: string | null;     // 一级模块（章节）
  moduleName: string | null;    // 二级模块
  difficulty: number | null;
  masteryStandard: string | null;
  remediationAdvice: string | null;
  drawable: number;             // 可抽题数（选择/填空、带答案、学生可见）
  formats: string[];
}

/** 知识树：只返回「有可抽题」的知识点（含 章节/模块 分级信息与题量），供自测选点。 */
export async function loadKnowledgeTree(
  client: pg.PoolClient,
  tenantId: string,
  userId: string,
  chapter?: string,
): Promise<KnowledgePointRow[]> {
  const kRows = (await client.query(
    `with k as (
       select distinct on (e.entity_id)
              e.entity_id as knowledge_id, r.revision_id, r.lifecycle_status
         from content_entity e
         join content_entity_revision r
           on r.tenant_id = e.tenant_id and r.entity_id = e.entity_id
        where e.tenant_id = $1 and e.entity_kind = 'knowledge'
        order by e.entity_id, r.revision_no desc
     )
     select k.knowledge_id, k.revision_id, kv.name, kv.grade_band, kv.description,
            kv.difficulty, kv.mastery_standard, kv.remediation_advice
       from k
       join content_knowledge_revision kv
         on kv.tenant_id = $1 and kv.revision_id = k.revision_id
      where k.lifecycle_status in ('approved','ready')`,
    [tenantId],
  )).rows as {
    knowledge_id: string; revision_id: string; name: string; grade_band: string | null;
    description: string; difficulty: number | null; mastery_standard: string | null;
    remediation_advice: string | null;
  }[];

  const drawRows = (await client.query(
    `${DRAWABLE_BASE_SQL}
     select mt.dimension_revision_id, count(distinct q.entity_id)::int as drawable,
            array_agg(distinct q.stem_format) as formats
       from mt join q on q.revision_id = mt.question_revision_id
      group by mt.dimension_revision_id`,
    [tenantId, userId],
  )).rows as { dimension_revision_id: string; drawable: number; formats: string[] }[];
  const drawByRevision = new Map(drawRows.map((row) => [row.dimension_revision_id, row]));

  const rows: KnowledgePointRow[] = [];
  for (const k of kRows) {
    const draw = drawByRevision.get(k.revision_id);
    if (!draw || draw.drawable <= 0) continue; // 只看「可抽」
    rows.push({
      knowledgeId: k.knowledge_id,
      name: k.name,
      gradeBand: k.grade_band,
      moduleName: moduleOfDescription(k.description, k.grade_band),
      difficulty: k.difficulty,
      masteryStandard: k.mastery_standard,
      remediationAdvice: k.remediation_advice,
      drawable: draw.drawable,
      formats: draw.formats.filter((f) => (SELF_TEST_FORMATS as readonly string[]).includes(f)),
    });
  }
  if (chapter) return rows.filter((row) => row.gradeBand === chapter);
  return rows;
}

/** description 形如 "解三角形 / 入门题型 / 基本定理"，二级模块取 "/" 第二段；无则回退章节名。 */
function moduleOfDescription(description: string, gradeBand: string | null): string | null {
  const parts = description.split("/").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) return parts[1] ?? null;
  return gradeBand;
}

export interface QuestionCandidate {
  questionEntityId: string;    // Q_TRI_2xx
  questionRevisionId: string;  // qrev_*
  stemFormat: SelfTestFormat;
  difficulty: number;
}

/** 指定知识点维度下的可抽题池（含难度/题型）。 */
export async function loadDrawablePool(
  client: pg.PoolClient,
  tenantId: string,
  userId: string,
  knowledgeId: string,
): Promise<QuestionCandidate[]> {
  const krev = await knowledgeRevisionOf(client, tenantId, knowledgeId);
  if (!krev) return [];
  const result = await client.query(
    `${DRAWABLE_BASE_SQL}
     select q.entity_id as question_entity_id, q.revision_id as question_revision_id,
            q.stem_format, q.difficulty
       from mt join q on q.revision_id = mt.question_revision_id
      where mt.dimension_revision_id = $3`,
    [tenantId, userId, krev],
  );
  // pg 返回 snake_case 列名；QuestionCandidate 为 camelCase 契约，需显式映射
  //（此前 `as QuestionCandidate[]` 直接断言导致 revision_id/stem_format 为 undefined，
  //   建轮预取与作答后抽下一题都会 500 material_missing）
  return (result.rows as {
    question_entity_id: string; question_revision_id: string;
    stem_format: SelfTestFormat; difficulty: number;
  }[]).map((row) => ({
    questionEntityId: row.question_entity_id,
    questionRevisionId: row.question_revision_id,
    stemFormat: row.stem_format,
    difficulty: row.difficulty,
  }));
}

async function knowledgeRevisionOf(
  client: pg.PoolClient,
  tenantId: string,
  knowledgeId: string,
): Promise<string | null> {
  const result = await client.query(
    `select r.revision_id
       from content_entity e
       join content_entity_revision r
         on r.tenant_id = e.tenant_id and r.entity_id = e.entity_id
      where e.tenant_id = $1 and e.entity_kind = 'knowledge' and e.entity_id = $2
        and r.lifecycle_status in ('approved','ready')
      order by r.revision_no desc
      limit 1`,
    [tenantId, knowledgeId],
  );
  return (result.rows[0]?.revision_id as string | undefined) ?? null;
}

export interface QuestionMaterial {
  questionEntityId: string;
  questionRevisionId: string;
  stemFormat: SelfTestFormat;
  difficulty: number;
  stemMarkdown: string;
  analysisMarkdown: string;
  options: { key: string; text: string }[]; // 不返回 is_correct（判答只在服务端）
  knowledgeIds: string[];
}

export async function loadQuestionMaterial(
  client: pg.PoolClient,
  tenantId: string,
  questionRevisionId: string,
): Promise<QuestionMaterial | null> {
  const q = await client.query(
    `select qr.stem_format, qr.difficulty, qr.stem_markdown, qr.analysis_markdown,
            coalesce((select jsonb_agg(jsonb_build_object('key',o.option_key,'text',o.option_text)
                                        order by i.position)
                        from content_revision_item i
                        join content_question_option o using(item_id)
                       where i.tenant_id = $1 and i.revision_id = qr.revision_id
                         and i.item_kind = 'question_option'),'[]'::jsonb) as options
       from content_question_revision qr
      where qr.tenant_id = $1 and qr.revision_id = $2`,
    [tenantId, questionRevisionId],
  );
  const row = q.rows[0] as {
    stem_format: SelfTestFormat; difficulty: number; stem_markdown: string;
    analysis_markdown: string; options: { key: string; text: string }[];
  } | undefined;
  if (!row) return null;
  const e = await client.query(
    `select e.entity_id
       from content_entity e
       join content_entity_revision r
         on r.tenant_id = e.tenant_id and r.entity_id = e.entity_id
      where e.tenant_id = $1 and e.entity_kind = 'question' and r.revision_id = $2`,
    [tenantId, questionRevisionId],
  );
  const k = await client.query(
    `select e.entity_id
       from content_revision_item i
       join content_question_measurement_target m using(item_id)
       join content_entity_revision r2
         on r2.tenant_id = m.tenant_id and r2.revision_id = m.dimension_revision_id
       join content_entity e
         on e.tenant_id = r2.tenant_id and e.entity_id = r2.entity_id
        and e.entity_kind = 'knowledge'
      where i.tenant_id = $1 and i.revision_id = $2 and i.item_kind = 'question_measurement_target'`,
    [tenantId, questionRevisionId],
  );
  return {
    questionEntityId: (e.rows[0]?.entity_id as string | undefined) ?? "",
    questionRevisionId,
    stemFormat: row.stem_format,
    difficulty: row.difficulty,
    stemMarkdown: row.stem_markdown,
    analysisMarkdown: row.analysis_markdown,
    options: row.options,
    knowledgeIds: (k.rows as { entity_id: string }[]).map((item) => item.entity_id),
  };
}

export interface GradeBasis {
  answerTexts: string[];       // content_question_answer_item.answer_text
  options: { key: string; text: string; isCorrect: boolean }[];
}

export async function loadGradeBasis(
  client: pg.PoolClient,
  tenantId: string,
  questionRevisionId: string,
): Promise<GradeBasis | null> {
  const result = await client.query(
    `select coalesce((select jsonb_agg(a.answer_text order by i.position)
                        from content_revision_item i
                        join content_question_answer_item a using(item_id)
                       where i.tenant_id = $1 and i.revision_id = $2
                         and i.item_kind = 'question_answer'),'[]'::jsonb) as answer_texts,
            coalesce((select jsonb_agg(jsonb_build_object('key',o.option_key,'text',o.option_text,'isCorrect',o.is_correct)
                                        order by i.position)
                        from content_revision_item i
                        join content_question_option o using(item_id)
                       where i.tenant_id = $1 and i.revision_id = $2
                         and i.item_kind = 'question_option'),'[]'::jsonb) as options
       from content_question_revision qr
      where qr.tenant_id = $1 and qr.revision_id = $2`,
    [tenantId, questionRevisionId],
  );
  const row = result.rows[0] as { answer_texts: string[]; options: { key: string; text: string; isCorrect: boolean }[] } | undefined;
  if (!row) return null;
  return { answerTexts: row.answer_texts, options: row.options };
}
