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

const OUT = 'd:/南华碎片/长株潭数据大赛/数据库变更文档/data/';
const csv = (rows) => rows.map((r) => Object.values(r).map((v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}).join(',')).join('\n');

// paper_items
const items = await pool.query(
  `select p.title as 试卷标题, i.item_order as 题号, i.difficulty as 难度,
          i.entity_id as 题目实体, i.revision_id as 题目修订
     from content_paper_item i
     join content_paper p on p.paper_id = i.paper_id
    order by p.created_at, i.item_order`);
writeFileSync(OUT + 'paper_items.csv',
  '试卷标题,题号,难度,题目实体,题目修订\n' + csv(items.rows), 'utf8');

// answer_items
const ans = await pool.query(
  `select p.title as 试卷标题, a.item_order as 题号, a.need_review as 待复核,
          a.source as 来源, a.answer_text as 答案, a.analysis_text as 解析
     from content_paper_answer_item a
     join content_paper p on p.paper_id = a.paper_id
    order by p.created_at, a.item_order`);
writeFileSync(OUT + 'answer_items.csv',
  '试卷标题,题号,待复核,来源,答案,解析\n' + csv(ans.rows), 'utf8');

// question_modules
const qmod = await pool.query(
  `select chapter_id as 一级模块, module_2 as 二级模块, module_3 as 三级模块,
          count(*)::int as 题目数
     from content_question_revision
    where module_2 is not null or module_3 is not null
    group by chapter_id, module_2, module_3
    order by chapter_id, module_2, module_3`);
writeFileSync(OUT + 'question_modules.csv',
  '一级模块,二级模块,三级模块,题目数\n' + csv(qmod.rows), 'utf8');

// paper_objects
const so = await pool.query(
  `select object_id as 对象ID, original_name as 文件名, byte_size as 大小字节,
          sha256 as SHA256, created_at as 创建时间
     from storage_object where purpose='paper'
    order by created_at`);
writeFileSync(OUT + 'paper_objects.csv',
  '对象ID,文件名,大小字节,SHA256,创建时间\n' + csv(so.rows), 'utf8');

console.log('CSV 已生成: paper_items, answer_items, question_modules, paper_objects');
await pool.end();
