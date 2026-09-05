// retry-item-10.mjs — 重试 #10 AI 补全（最多 3 次）
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const requirePkg = createRequire(import.meta.resolve('../../src/services/content-next/package.json'));
const pgMod = requirePkg('pg');
const pg = pgMod?.default ?? pgMod;
import { completeQuestionAnalysis, normalizeBankAnswer } from '../../src/services/content-next/src/answer-analysis.ts';

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
const ORDER = 10;

const { rows } = await pool.query(
  `select i.item_order, q.stem_format, q.stem_markdown,
          coalesce((select string_agg(a.answer_text, ' ' order by ri.position)
                      from content_revision_item ri
                      join content_question_answer_item a on a.item_id=ri.item_id
                     where ri.revision_id=i.revision_id and ri.item_kind='question_answer'), '') as answer_text
     from content_paper_item i
     join content_question_revision q on q.revision_id=i.revision_id
    where i.paper_id=$1 and i.item_order=$2`,
  [PAPER_ID, ORDER],
);
const row = rows[0];
const { rows: opts } = await pool.query(
  `select o.option_key, o.option_text
     from content_revision_item ri
     join content_question_option o on o.item_id=ri.item_id
    where ri.revision_id=(select revision_id from content_paper_item where paper_id=$1 and item_order=$2)
      and ri.item_kind='question_option'
    order by ri.position`,
  [PAPER_ID, ORDER],
);
const question = {
  item_order: row.item_order,
  stem_format: row.stem_format,
  stem_markdown: row.stem_markdown,
  options: opts.map((o) => ({ option_key: o.option_key, option_text: o.option_text })),
  answer_text: normalizeBankAnswer(row.answer_text ?? ''),
  analysis_text: '',
};

let lastError = null;
for (let attempt = 1; attempt <= 3; attempt++) {
  console.log(`尝试 ${attempt}/3 ...`);
  try {
    const result = await completeQuestionAnalysis(question);
    console.log('  答案:', result.answer_text);
    console.log('  解析:', (result.analysis_text ?? '').slice(0, 150));
    console.log('  need_review:', result.need_review, 'source:', result.source);
    await pool.query(
      `update content_paper_answer_item
          set answer_text=$1, analysis_text=$2, need_review=$3, review_note=$4, source=$5, updated_at=now()
        where paper_id=$6 and item_order=$7`,
      [result.answer_text, result.analysis_text, result.need_review, result.review_note, result.source, PAPER_ID, ORDER],
    );
    console.log('  ✓ 已更新');
    break;
  } catch (error) {
    lastError = error;
    console.error(`  ✗ 失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (lastError && !(await pool.query('select 1')).rows) {}
await pool.end();
