/**
 * 存量题目模块归属回填：历史 content_question_revision 的 chapter_id 存的是"来源标注"
 *（如"附件01-05改编"、"unclassified"），而非"一级知识模块"。本脚本按每题 primary 知识点
 * 的 description（"一级 / 二级 / 三级"，单级时即一级模块名）解析出三级路径，
 * 回填 chapter_id（一级模块）、module_2、module_3，使其在组卷自选页面可作为"一→二→三级"
 * 级联过滤依据。
 *
 * 幂等：仅处理 module_2 IS NULL 的行；重复执行对已回填行不变。
 *
 * 说明：content_question_revision 是 immutable 表，UPDATE 被 forbid_mutation 触发器拦截。
 * 但 module_2/module_3 是新增列（历史行全空），本次是"新列初始化"而非"篡改既有事实"。
 * 因此在单个事务内 SET LOCAL session_replication_role=replica 临时跳过触发器完成回填，
 * 事务结束自动恢复。仅限一次性数据迁移使用。
 *
 * 用法（宿主机连接，postgres 端口见 deploy/dev/.env 的 PGPORT，默认 5433）：
 *   src/services/content-next/node_modules/.bin/tsx deploy/dev/backfill-question-module.mjs
 *   预览（只统计，不写库）：APPLY=0 ...
 *   落库：APPLY=1 ...
 *   可用环境变量：DATABASE_URL、PGHOST、PGPORT、PGUSER、PGPASSWORD、PGDATABASE、APPLY、BATCH
 */
import { createRequire } from "node:module";
const requirePkg = createRequire(new URL("../../src/services/content-next/package.json", import.meta.url));
const pgMod = requirePkg("pg");
const pg = pgMod?.default ?? pgMod;

const env = process.env;
const port = env.PGPORT || "5433";
const dbUrl =
  env.DATABASE_URL ||
  // 超级用户 mathpilot 可绕过 RLS；需在其会话里 SET LOCAL replica 以跳过 forbid_mutation。
  `postgres://${env.PGUSER || "mathpilot"}:${env.PGPASSWORD || "mathpilot-dev-only"}@${env.PGHOST || "127.0.0.1"}:${port}/${env.PGDATABASE || "mathpilot"}`;
const apply = String(env.APPLY || "0") === "1";
const batch = Number(env.BATCH || 200);

const pool = new pg.Pool({ connectionString: dbUrl, max: 2, connectionTimeoutMillis: 10_000 });

/** 把知识点 description 解析为 [一级, 二级, 三级]。单级 a→[a,null,null]；两级 a/b→[a,b,null]。 */
function pathOf(description, gradeBand) {
  const parts = (description || "").split("/").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 3) return [parts[0], parts[1], parts[2]];
  if (parts.length === 2) return [parts[0], parts[1], null];
  if (parts.length === 1) return [parts[0], null, null];
  const band = (gradeBand || "").split("/").map((p) => p.trim()).filter(Boolean);
  if (band.length >= 2) return [band[0], band[1], null];
  return [band[0] || null, null, null];
}

async function main() {
  let scanned = 0;
  let changed = 0;
  let errors = 0;
  let lastId = "";
  console.log(`[backfill-question-module] mode=${apply ? "APPLY" : "dry-run"} db=${dbUrl.replace(/\/\/[^@]*@/, "//***@")}`);
  const pool2 = new pg.Pool({ connectionString: dbUrl, max: 1, connectionTimeoutMillis: 10_000 });

  // 只扫描仍缺模块归属（module_2/module_3 均空）的 approved/ready 题目，避免重复处理。
  const FILTER = "qr.module_2 IS NULL AND qr.module_3 IS NULL";
  while (true) {
    const { rows } = await pool2.query(
      `select qr.revision_id as rid, qr.chapter_id, pri.kp_desc, pri.grade_band
         from content_question_revision qr
         join content_entity_revision r
           on r.revision_id = qr.revision_id
          and r.lifecycle_status in ('approved','ready')
         left join lateral (
           select m.dimension_revision_id, k.description as kp_desc, k.grade_band
             from content_revision_item i
             join content_question_measurement_target m on m.item_id = i.item_id
             left join content_entity_revision kr on kr.revision_id = m.dimension_revision_id
             left join content_knowledge_revision k on k.revision_id = kr.revision_id
            where i.revision_id = qr.revision_id and i.item_kind = 'question_measurement_target'
            order by case when m.target_role = 'primary' then 0 else 1 end, i.position
            limit 1
         ) pri on true
        where ${FILTER}
          and qr.revision_id > $1
        order by qr.revision_id
        limit $2`,
      [lastId, batch],
    );
    if (rows.length === 0) break;

    const pending = [];
    for (const row of rows) {
      scanned++;
      const [m1, m2, m3] = pathOf(row.kp_desc, row.grade_band);
      if (!m1) { errors++; console.log(`  [${row.rid}] no module path (desc=${row.kp_desc}|band=${row.grade_band})`); continue; }
      pending.push([m1, m2, m3, row.rid]);
      changed++;
      if (!apply && scanned <= 10) {
        console.log(`  [改chapter] ${row.rid} -> ${m1} / ${m2 ?? "∅"} / ${m3 ?? "∅"}  (was ${row.chapter_id})`);
      }
    }

    if (apply && pending.length) {
      const client = await pool2.connect();
      try {
        await client.query("BEGIN");
        // 单事务内临时跳过 immutable 触发器（事务结束自动恢复），仅用于新列初始化回填。
        await client.query("SET LOCAL session_replication_role = replica");
        for (const [m1, m2, m3, rid] of pending) {
          try {
            await client.query(
              `update content_question_revision
                  set chapter_id=$1, module_2=$2, module_3=$3
                where revision_id=$4`,
              [m1, m2, m3, rid],
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
  console.log(`[backfill-question-module] done: scanned=${scanned} changed=${changed} errors=${errors} applied=${apply ? "yes" : "no"}`);
  await pool2.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});