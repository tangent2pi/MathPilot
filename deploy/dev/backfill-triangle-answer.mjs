/**
 * 三角形卷答案回填：把 content_paper_answer_item 中"混合格式"答案
 * （如 c^$2 = a$^2 + b^2 - $2ab cosC$）转换成统一的 $...$ LaTeX 格式。
 *
 * 幂等：casualToLatex 对已是 LaTeX 的片段原样保留。
 *
 * 用法：
 *   $env:APPLY=0; src/services/content-next/node_modules/.bin/tsx deploy/dev/backfill-triangle-answer.mjs   # 预览
 *   $env:APPLY=1; ...   # 落库
 */
import { createRequire } from "node:module";
const requirePkg = createRequire(new URL("../../src/services/content-next/package.json", import.meta.url));
const pgMod = requirePkg("pg");
const pg = pgMod?.default ?? pgMod;
import { casualToLatex } from "../../src/services/content-next/src/math-latex.ts";

const env = process.env;
const port = env.PGPORT || env.PGPORT || "5433";
const dbUrl =
  env.DATABASE_URL ||
  `postgres://${env.PGUSER || "mathpilot_app"}:${env.PGPASSWORD || "mathpilot-app-dev-only"}@${env.PGHOST || "127.0.0.1"}:${port}/${env.PGDATABASE || "mathpilot"}`;
const apply = String(env.APPLY || "0") === "1";
const paperId = env.PAPER_ID;

const pool = new pg.Pool({ connectionString: dbUrl, max: 2, connectionTimeoutMillis: 10_000 });

async function main() {
  if (!paperId) {
    // 列出所有卷及其答案条数
    const { rows: papers } = await pool.query(
      `SELECT p.paper_id, p.title, count(a.*) as answer_count
         FROM content_paper p LEFT JOIN content_paper_answer_item a ON p.paper_id = a.paper_id
         GROUP BY p.paper_id, p.title
         ORDER BY p.created_at DESC`,
    );
    console.log('可用试卷:');
    for (const p of papers) {
      console.log(`  ${p.paper_id} | ${p.title} | ${p.answer_count} 条答案`);
    }
    console.log('\n用法: $env:PAPER_ID="paper_xxx"; $env:APPLY=1; node backfill-triangle-answer.mjs');
    return;
  }

  let scanned = 0;
  let changed = 0;

  console.log(`[backfill-triangle] paper=${paperId} mode=${apply ? "APPLY" : "dry-run"}`);

  const { rows } = await pool.query(
    `SELECT paper_id, tenant_id, item_order, answer_text, analysis_text
       FROM content_paper_answer_item
      WHERE paper_id = $1
      ORDER BY item_order`,
    [paperId],
  );

  for (const row of rows) {
    scanned++;
    const oldAnswer = row.answer_text ?? "";
    const oldAnalysis = row.analysis_text ?? "";
    const newAnswer = casualToLatex(oldAnswer);
    const newAnalysis = casualToLatex(oldAnalysis);
    if (newAnswer === oldAnswer && newAnalysis === oldAnalysis) continue;
    changed++;
    if (!apply) {
      if (newAnswer !== oldAnswer) console.log(`  #${row.item_order} answer: ${oldAnswer.slice(0, 80)}... -> ${newAnswer.slice(0, 80)}...`);
      if (newAnalysis !== oldAnalysis) console.log(`  #${row.item_order} analysis: ${oldAnalysis.slice(0, 80)}... -> ${newAnalysis.slice(0, 80)}...`);
      continue;
    }
    try {
      await pool.query(
        `UPDATE content_paper_answer_item
            SET answer_text = $1, analysis_text = $2, updated_at = now()
          WHERE paper_id = $3 AND item_order = $4 AND tenant_id = $5`,
        [newAnswer, newAnalysis, row.paper_id, row.item_order, row.tenant_id],
      );
      console.log(`  ✓ #${row.item_order} updated`);
    } catch (error) {
      console.error(`  ✗ #${row.item_order} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`\n[backfill-triangle] done: scanned=${scanned} changed=${changed}`);
  await pool.end();
}

main().catch((error) => {
  console.error("[backfill-triangle] fatal:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
