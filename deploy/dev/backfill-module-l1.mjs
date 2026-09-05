/**
 * 一级模块归一化回填二：将历史题目一级模块统一为"章节名"（解三角形）。
 * 第一次回填误把知识点单级主题（正余弦定理与基本应用、定理与模型、中线角平分线高线、
 * 圆与多三角形、最值与范围等）当成了一级模块。这些实为"解三角形"章下的专题/中观主题，
 * 应作为二级模块。
 *
 * 本脚本：对 chapter_id <> '解三角形' 的已批准/就绪题目，一级改为 '解三角形'；
 * 当其 module_2 为空时，把原 chapter_id 作为 module_2 下沉。
 * （module_2 已填的题目保持其原有二级，因为那已是结构化的三级路径。）
 *
 * 幂等：只处理 module_2 为空 或 chapter_id <> '解三角形' 的行；重复执行随已回填而收敛。
 *
 * 用法：与 backfill-question-module.mjs 相同（APPLY=1 落库，APPLY=0 预览）。
 */
import { createRequire } from "node:module";
const requirePkg = createRequire(new URL("../../src/services/content-next/package.json", import.meta.url));
const pgMod = requirePkg("pg");
const pg = pgMod?.default ?? pgMod;

const env = process.env;
const port = env.PGPORT || "5433";
const dbUrl =
  env.DATABASE_URL ||
  `postgres://${env.PGUSER || "mathpilot"}:${env.PGPASSWORD || "mathpilot-dev-only"}@${env.PGHOST || "127.0.0.1"}:${port}/${env.PGDATABASE || "mathpilot"}`;
const apply = String(env.APPLY || "0") === "1";
const batch = Number(env.BATCH || 200);
const pool = new pg.Pool({ connectionString: dbUrl, max: 2, connectionTimeoutMillis: 10_000 });

const TARGET_L1 = "解三角形";

async function main() {
  let scanned = 0;
  let changed = 0;
  let errors = 0;
  let lastId = "";
  console.log(`[backfill-module-l1] mode=${apply ? "APPLY" : "dry-run"} db=${dbUrl.replace(/\/\/[^@]*@/, "//***@")} target_l1=${TARGET_L1}`);

  // 仅扫描一级不是"解三角形"、且 module_2 为空的行（会下沉原一级为二级）。
  // 注意：一级已是解三角形但 module_2 为空的（如解三角形/入门题型两级）不在此处理。
  const FILTER = "qr.chapter_id <> $3 AND qr.module_2 IS NULL";
  while (true) {
    const { rows } = await pool.query(
      `select qr.revision_id as rid, qr.chapter_id, qr.module_2
         from content_question_revision qr
         join content_entity_revision r
           on r.revision_id = qr.revision_id
          and r.lifecycle_status in ('approved','ready')
        where ${FILTER}
          and qr.revision_id > $1
        order by qr.revision_id
        limit $2`,
      [lastId, batch, TARGET_L1],
    );
    if (rows.length === 0) break;

    const pending = [];
    for (const row of rows) {
      scanned++;
      changed++;
      pending.push([row.rid, row.chapter_id]);
      if (!apply && scanned <= 12) {
        console.log(`  [归一] ${row.rid}: ${row.chapter_id} -> ${TARGET_L1} / ${row.chapter_id}${row.module_2 ? "" : " (module_2 下沉)"}`);
      }
    }

    if (apply && pending.length) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL session_replication_role = replica");
        for (const [rid, oldLvl1] of pending) {
          try {
            await client.query(
              `update content_question_revision
                  set chapter_id=$1, module_2=coalesce(module_2,$2)
                where revision_id=$3`,
              [TARGET_L1, oldLvl1, rid],
            );
          } catch (error) {
            errors++;
            console.error(`  [${rid}] update failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        await client.query("COMMIT");
      } catch (error) {
        errors++;
        console.error(`  batch commit failed: ${error instanceof Error ? error.message : String(error)}`);
        await client.query("ROLLBACK").catch(() => {});
      } finally {
        client.release();
      }
    }

    lastId = rows[rows.length - 1].rid;
    if (rows.length < batch) break;
  }
  console.log(`[backfill-module-l1] done: scanned=${scanned} changed=${changed} errors=${errors} applied=${apply ? "yes" : "no"}`);
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});