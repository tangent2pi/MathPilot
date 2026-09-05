/**
 * 存量答案解析回填：把 content_paper_answer_item 中历史"通俗符号"（√3、π/3、45°、
 * a²、≤ 等）转成 LaTeX 数学（$...$），与新版 prepare/PUT 入库规则对齐。
 *
 * 幂等：casualToLatex 对已是 LaTeX 的片段原样保留，重复执行为 0 更新。
 *
 * 用法（宿主机连接，postgres 端口见 deploy/dev/.env 的 PGPORT，默认 5433）：
 *   node_modules 解析锚定 content-next，用其 tsx 运行：
 *     src/services/content-next/node_modules/.bin/tsx deploy/dev/backfill-math-answer.mjs
 *   预览（只统计，不写库）：
 *     APPLY=0 ... run
 *   落库：
 *     APPLY=1 ... run
 *   可用环境变量：DATABASE_URL、PGHOST、PGPORT、PGUSER、PGPASSWORD、PGDATABASE、APPLY、BATCH
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
const batch = Number(env.BATCH || 200);

const pool = new pg.Pool({ connectionString: dbUrl, max: 2, connectionTimeoutMillis: 10_000 });

async function main() {
  let scanned = 0;
  let changed = 0;
  let errors = 0;
  let lastPaper = "";
  let lastOrder = 0;
  console.log(`[backfill-math-answer] mode=${apply ? "APPLY" : "dry-run"} db=${dbUrl.replace(/\/\/[^@]*@/, "//***@")}`);

  // 优先只扫描可能命中通俗符号的行，减少全表扫描；无法判断时退化为全表逐页。
  // 增加对 ^ 上标的匹配（如 c^2、a^2+b^2 等）
  const WHERE = "(answer_text ~ '[√α-ωΑ-Ω±×÷≤≥≠≡①②③④⑤⑥⑦⑧⑨⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉°^]' OR analysis_text ~ '[√α-ωΑ-Ω±×÷≤≥≠≡①②③④⑤⑥⑦⑧⑨⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉°^]')";
  while (true) {
    const { rows } = await pool.query(
      `select paper_id, tenant_id, item_order, answer_text, analysis_text
         from content_paper_answer_item
        where (paper_id, item_order) > ($1, $2)
          and ${WHERE}
        order by paper_id, item_order
        limit $3`,
      [lastPaper, lastOrder, batch],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      scanned++;
      const oldAnswer = row.answer_text ?? "";
      const oldAnalysis = row.analysis_text ?? "";
      const newAnswer = casualToLatex(oldAnswer);
      const newAnalysis = casualToLatex(oldAnalysis);
      if (newAnswer === oldAnswer && newAnalysis === oldAnalysis) continue;
      changed++;
      if (!apply) {
        if (newAnswer !== oldAnswer) console.log(`  [paper=${row.paper_id} #${row.item_order}] answer: ${oldAnswer} -> ${newAnswer}`);
        if (newAnalysis !== oldAnalysis) console.log(`  [paper=${row.paper_id} #${row.item_order}] analysis: ${oldAnalysis} -> ${newAnalysis}`);
        continue;
      }
      try {
        await pool.query(
          `update content_paper_answer_item
              set answer_text=$1, analysis_text=$2, updated_at=now()
            where paper_id=$3 and item_order=$4 and tenant_id=$5`,
          [newAnswer, newAnalysis, row.paper_id, row.item_order, row.tenant_id],
        );
      } catch (error) {
        errors++;
        console.error(`  [paper=${row.paper_id} #${row.item_order}] update failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (rows.length < batch) break;
    lastPaper = rows[rows.length - 1].paper_id;
    lastOrder = rows[rows.length - 1].item_order;
  }
  console.log(`[backfill-math-answer] done: scanned=${scanned} changed=${changed} errors=${errors} applied=${apply ? "yes" : "no"}`);
  await pool.end();
}

main().catch((error) => {
  console.error("[backfill-math-answer] fatal:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});