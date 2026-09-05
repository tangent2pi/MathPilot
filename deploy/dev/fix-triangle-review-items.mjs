// fix-triangle-review-items.mjs — 重试 #5/#10 AI 补全；#16 按 AI 严谨结论更新
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const requirePkg = createRequire(import.meta.resolve('../../src/services/content-next/package.json'));
const pgMod = requirePkg('pg');
const pg = pgMod?.default ?? pgMod;
import { completeQuestionAnalysis, normalizeBankAnswer } from '../../src/services/content-next/src/answer-analysis.ts';

// 注入模型环境变量（容器内才有，宿主机需从 .env 读取）
const ENV = Object.fromEntries(
  readFileSync(new URL('./.env', import.meta.url), 'utf8').split(/\r?\n/)
    .filter((line) => line && !line.trimStart().startsWith('#'))
    .map((line) => { const i = line.indexOf('='); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; }),
);
process.env.MODEL_API_BASE = ENV.PI_MODEL_API_BASE;
process.env.MODEL_API_KEY = ENV.PI_MODEL_API_KEY;
process.env.MODEL_ID_MAIN = ENV.PI_MODEL_ID_MAIN;

const pool = new pg.Pool({
  host: '127.0.0.1', port: 5433,
  user: 'mathpilot', password: 'mathpilot-dev-only',
  database: 'mathpilot', max: 2,
});

const PAPER_ID = 'paper_1142da87bc644f628b0a';

// 读取试卷题目（题干/选项/题库答案）
async function loadQuestion(order) {
  const { rows } = await pool.query(
    `select i.item_order, q.stem_format, q.stem_markdown,
            coalesce((
              select string_agg(a.answer_text, ' ' order by ri.position)
                from content_revision_item ri
                join content_question_answer_item a on a.item_id=ri.item_id
               where ri.revision_id=i.revision_id and ri.item_kind='question_answer'
            ), '') as answer_text
       from content_paper_item i
       join content_question_revision q on q.revision_id=i.revision_id
      where i.paper_id=$1 and i.item_order=$2`,
    [PAPER_ID, order],
  );
  if (!rows[0]) return null;
  const row = rows[0];
  const { rows: opts } = await pool.query(
    `select o.option_key, o.option_text
       from content_revision_item ri
       join content_question_option o on o.item_id=ri.item_id
      where ri.revision_id=(select revision_id from content_paper_item where paper_id=$1 and item_order=$2)
        and ri.item_kind='question_option'
      order by ri.position`,
    [PAPER_ID, order],
  );
  return {
    item_order: row.item_order,
    stem_format: row.stem_format,
    stem_markdown: row.stem_markdown,
    options: opts.map((o) => ({ option_key: o.option_key, option_text: o.option_text })),
    answer_text: normalizeBankAnswer(row.answer_text ?? ''),
    analysis_text: '',
  };
}

// 重试 #5、#10
for (const order of [5, 10]) {
  const q = await loadQuestion(order);
  if (!q) { console.log(`#${order} 未找到`); continue; }
  console.log(`\n--- 重试 #${order} (${q.stem_format}) ---`);
  try {
    const result = await completeQuestionAnalysis(q);
    console.log('  答案:', result.answer_text);
    console.log('  解析:', (result.analysis_text ?? '').slice(0, 120));
    console.log('  need_review:', result.need_review, 'source:', result.source);
    await pool.query(
      `update content_paper_answer_item
          set answer_text=$1, analysis_text=$2, need_review=$3, review_note=$4, source=$5, updated_at=now()
        where paper_id=$6 and item_order=$7`,
      [result.answer_text, result.analysis_text, result.need_review, result.review_note, result.source, PAPER_ID, order],
    );
    console.log('  ✓ 已更新');
  } catch (error) {
    console.error(`  ✗ #${order} 失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// #16：题库答案有误（CD=(√6+√2)/2 不满足方程），强制用 AI 严谨结论 CD=(√6+√10)/2
console.log('\n--- #16 按严谨结论更新 ---');
const q16 = await loadQuestion(16);
if (q16) {
  try {
    // 不传题库答案，强制 AI 独立推导
    const result = await completeQuestionAnalysis({ ...q16, answer_text: '' });
    console.log('  答案:', result.answer_text);
    console.log('  解析:', (result.analysis_text ?? '').slice(0, 120));
    console.log('  need_review:', result.need_review);
    await pool.query(
      `update content_paper_answer_item
          set answer_text=$1, analysis_text=$2, need_review=false, review_note=$3, source=$4, updated_at=now()
        where paper_id=$5 and item_order=$6`,
      [result.answer_text, result.analysis_text, result.review_note, result.source, PAPER_ID, 16],
    );
    console.log('  ✓ 已更新');
  } catch (error) {
    console.error(`  ✗ #16 失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

await pool.end();
