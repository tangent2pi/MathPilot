import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const requirePkg = createRequire(import.meta.resolve('../../src/services/content-next/package.json'));
const pgMod = requirePkg('pg');
const pg = pgMod?.default ?? pgMod;

const pool = new pg.Pool({
  host: '127.0.0.1', port: 5433,
  user: 'mathpilot', password: 'mathpilot-dev-only',
  database: 'mathpilot', max: 3,
});

const out = [];
const log = (s = '') => out.push(s);

// 1. 迁移状态
log('===== 1. infra_schema_migration 迁移状态 =====');
const mig = await pool.query('select version, applied_at from infra_schema_migration order by version');
for (const r of mig.rows) log(`${r.version}\t${r.applied_at}`);

// 2. 试卷相关表结构
const tables = ['content_paper', 'content_paper_item', 'content_paper_answer_item', 'content_candidate_set', 'content_question_revision', 'storage_object'];
for (const t of tables) {
  log(`\n===== 2. 表结构: ${t} =====`);
  const cols = await pool.query(
    `select column_name, data_type, is_nullable, column_default
       from information_schema.columns
      where table_schema='public' and table_name=$1
      order by ordinal_position`, [t]);
  for (const c of cols.rows) log(`${c.column_name}\t${c.data_type}\tnull=${c.is_nullable}\tdefault=${c.column_default ?? ''}`);
}

// 3. 索引
log('\n===== 3. 试卷相关索引 =====');
const idx = await pool.query(
  `select tablename, indexname, indexdef
     from pg_indexes
    where schemaname='public'
      and tablename = any($1)
    order by tablename, indexname`, [tables]);
for (const r of idx.rows) log(`${r.tablename}\t${r.indexname}\n  ${r.indexdef}`);

// 4. 约束
log('\n===== 4. 试卷相关约束 =====');
const cons = await pool.query(
  `select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def
     from pg_constraint
    where connamespace='public'::regnamespace
      and conrelid::regclass::text = any($1)
    order by tbl, conname`, [tables]);
for (const r of cons.rows) log(`${r.tbl}\t${r.conname}\n  ${r.def}`);

// 5. 触发器
log('\n===== 5. 触发器 =====');
const trig = await pool.query(
  `select event_object_table, trigger_name, action_timing, event_manipulation, action_statement
     from information_schema.triggers
    where trigger_schema='public'
    order by event_object_table, trigger_name`);
for (const r of trig.rows) log(`${r.event_object_table}\t${r.trigger_name}\t${r.action_timing} ${r.event_manipulation}\n  ${r.action_statement}`);

// 6. 函数定义
log('\n===== 6. 守卫函数定义 =====');
const funcs = ['mathpilot_paper_guard', 'mathpilot_paper_item_guard'];
for (const f of funcs) {
  const fn = await pool.query(
    `select pg_get_functiondef(oid) as def from pg_proc where proname=$1`, [f]);
  for (const r of fn.rows) log(`--- ${f} ---\n${r.def}`);
}

// 7. RLS 策略
log('\n===== 7. RLS 策略 =====');
const pol = await pool.query(
  `select tablename, policyname, permissive, roles, cmd, qual, with_check
     from pg_policies
    where schemaname='public' and tablename = any($1)
    order by tablename, policyname`, [tables]);
for (const r of pol.rows) log(`${r.tablename}\t${r.policyname}\t${r.cmd}\n  USING: ${r.qual}\n  CHECK: ${r.with_check}`);

// 8. 数据
log('\n===== 8. 数据 =====');
const paper = await pool.query('select * from content_paper order by created_at');
log(`--- content_paper (${paper.rowCount} 行) ---`);
for (const r of paper.rows) {
  log(JSON.stringify({ paper_id: r.paper_id, title: r.title, version_no: r.version_no, status: r.status, source: r.source, config_snapshot: r.config_snapshot, pdf_object_id: r.pdf_object_id, pdf_sha256: r.pdf_sha256, answer_pdf_object_id: r.answer_pdf_object_id, answer_pdf_sha256: r.answer_pdf_sha256, created_at: r.created_at, finalized_at: r.finalized_at, owner: r.owner_teacher_user_id }, null, 2));
}

const qcols = await pool.query(
  `select column_name from information_schema.columns
    where table_schema='public' and table_name='content_question_revision'`);
log('--- content_question_revision 列 ---');
log(qcols.rows.map((r) => r.column_name).join(', '));

const items = await pool.query(
  `select i.paper_id, i.item_order, i.difficulty, i.entity_id, i.revision_id
     from content_paper_item i
    order by i.paper_id, i.item_order`);
log(`\n--- content_paper_item (${items.rowCount} 行) ---`);
for (const r of items.rows) log(`${r.paper_id}\t#${r.item_order}\tdiff=${r.difficulty}\t${r.entity_id}\t${r.revision_id}`);

const ans = await pool.query(
  `select paper_id, item_order, need_review, source, left(answer_text, 40) as ans, left(analysis_text, 40) as ana
     from content_paper_answer_item order by paper_id, item_order`);
log(`\n--- content_paper_answer_item (${ans.rowCount} 行) ---`);
for (const r of ans.rows) log(`${r.paper_id}\t#${r.item_order}\treview=${r.need_review}\tsrc=${r.source}\tans=${r.ans}\tana=${r.ana}`);

const cand = await pool.query(
  `select * from content_candidate_set order by created_at`);
log(`\n--- content_candidate_set (${cand.rowCount} 行) ---`);
for (const r of cand.rows) log(JSON.stringify(r));

const qmod = await pool.query(
  `select revision_id, chapter_id, module_2, module_3
     from content_question_revision
    where module_2 is not null or module_3 is not null
    order by chapter_id, module_2, module_3 limit 60`);
log(`\n--- content_question_revision 含 module_2/module_3 (${qmod.rowCount} 行) ---`);
for (const r of qmod.rows) log(`${r.revision_id}\tchapter=${r.chapter_id}\tm2=${r.module_2}\tm3=${r.module_3}`);

const so = await pool.query(
  `select * from storage_object where purpose='paper' order by created_at`);
log(`\n--- storage_object purpose=paper (${so.rowCount} 行) ---`);
for (const r of so.rows) log(JSON.stringify(r));

writeFileSync(new URL('./db-dump.txt', import.meta.url), out.join('\n'), 'utf8');
console.log(`dumped ${out.length} lines → deploy/dev/db-dump.txt`);
await pool.end();
