/**
 * One-time importer for the human-confirmed home library snapshot.
 *
 * The importer deliberately reads the extracted CSV files, not the legacy
 * content tables.  It first verifies every manifest hash and row count, emits
 * a reconciliation report, and only writes when --execute is present.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

type Row = Record<string, string>;
type Kind = "knowledge" | "question_type" | "question" | "error_cause" | "diagnosis_rule";
type ManifestRow = { source_file: string; entity_kind: Kind; id_column: string; row_count: number; sha256: string; origin: "official"; owner_user_id: string };

const root = path.resolve(process.env.MATHPILOT_REPO_ROOT ?? process.cwd());
const manifestPath = path.resolve(root, process.env.OFFICIAL_CONTENT_MANIFEST ?? "db/migration-data/official-content-manifest.csv");
const databaseUrl = process.env.DATABASE_URL ?? "postgres://localhost:5432/mathpilot";
const tenantId = process.env.DEFAULT_TENANT_ID ?? process.env.DEV_TENANT_ID ?? "tnt_dev00001";
const execute = process.argv.includes("--execute");
const reportArg = process.argv.find((value) => value.startsWith("--report="))?.slice("--report=".length);

function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"' && field.length === 0) quoted = true;
    else if (character === ",") { row.push(field); field = ""; }
    else if (character === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (character !== "\r") field += character;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift() ?? [];
  return rows.filter((values) => values.some(Boolean)).map((values) => Object.fromEntries(header.map((key, index) => [key, values[index] ?? ""])));
}

function split(value: string | undefined): string[] {
  return (value ?? "").split("|").map((item) => item.trim()).filter(Boolean);
}

function hash(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
const revisionPrefix: Readonly<Record<Kind,string>> = {
  knowledge: "krev",
  question_type: "trev",
  question: "qrev",
  error_cause: "erev",
  diagnosis_rule: "rrev",
};
function revisionId(kind: Kind, id: string): string {
  return `${revisionPrefix[kind]}_official_${hash(Buffer.from(id)).slice(0, 24)}`;
}
function sourceId(fileHash: string): string { return `src_official_${fileHash.slice(0, 24)}`; }
function packageId(): string { return "pkg_official_home_v1"; }
function numberDifficulty(value: string): number { return value === "低" ? 0.25 : value === "高" ? 0.8 : 0.5; }
function stemFormat(value: string): "single_choice" | "multiple_choice" | "fill_blank" | "true_false" | "open_solution" {
  if (value.includes("选择")) return "single_choice";
  if (value.includes("填空")) return "fill_blank";
  if (value.includes("判断")) return "true_false";
  return "open_solution";
}
async function loadManifest(): Promise<{ entries: ManifestRow[]; files: Map<string, Row[]>; hashes: Map<string, string> }> {
  const manifest = parseCsv(await readFile(manifestPath, "utf8"));
  if (!manifest.length) throw new Error(`official manifest is empty: ${manifestPath}`);
  const entries: ManifestRow[] = [];
  const files = new Map<string, Row[]>();
  const hashes = new Map<string, string>();
  for (const item of manifest) {
    const kind = item.entity_kind as Kind;
    if (!["knowledge", "question_type", "question", "error_cause", "diagnosis_rule", "question"].includes(kind)) throw new Error(`unsupported manifest entity kind: ${item.entity_kind}`);
    const relative = typeof item.source_file === "string" ? item.source_file.replaceAll("\\", "/") : "";
    const idColumn = typeof item.id_column === "string" ? item.id_column : "";
    if (!relative || !idColumn) throw new Error("manifest source_file and id_column are required");
    if (relative.startsWith("/") || relative.split("/").includes("..")) throw new Error(`unsafe manifest path: ${relative}`);
    const bytes = await readFile(path.resolve(root, relative));
    const digest = hash(bytes);
    const rows = parseCsv(bytes.toString("utf8"));
    if (digest !== item.sha256) throw new Error(`${relative}: sha256 mismatch (expected ${item.sha256}, got ${digest})`);
    if (rows.length !== Number(item.row_count)) throw new Error(`${relative}: row count mismatch (expected ${item.row_count}, got ${rows.length})`);
    if (rows.some((row) => !row[idColumn])) throw new Error(`${relative}: ${idColumn} is missing in a row`);
    entries.push({ source_file: relative, entity_kind: kind, id_column: idColumn, row_count: Number(item.row_count), sha256: digest, origin: "official", owner_user_id: item.owner_user_id ?? "" });
    files.set(relative, rows); hashes.set(relative, digest);
  }
  return { entries, files, hashes };
}

async function defaultTeacher(client: pg.PoolClient): Promise<{ userId: string; count: number }> {
  const result = await client.query<{ user_id: string }>(
    `select u.user_id from identity_user u join identity_user_role r on r.user_id=u.user_id and r.tenant_id=u.tenant_id
      where u.tenant_id=$1 and r.role='teacher' order by u.created_at,u.user_id`, [tenantId],
  );
  const configured = process.env.DEFAULT_TEACHER_USER_ID;
  if (configured && !result.rows.some((row) => row.user_id === configured)) {
    throw new Error(`DEFAULT_TEACHER_USER_ID is not a teacher in tenant ${tenantId}`);
  }
  if (!configured && result.rows.length !== 1) {
    throw new Error(`tenant ${tenantId} must have exactly one teacher or DEFAULT_TEACHER_USER_ID must be configured`);
  }
  const userId = configured ?? result.rows[0]?.user_id;
  if (!userId) throw new Error(`no teacher exists for tenant ${tenantId}; set DEFAULT_TEACHER_USER_ID after bootstrapping the sole teacher`);
  return { userId, count: result.rows.length };
}

async function report(manifest: Awaited<ReturnType<typeof loadManifest>>, teacher: { userId: string; count: number }): Promise<Record<string, unknown>> {
  return {
    schema: "mathpilot.official-content-import-report/v1",
    tenant_id: tenantId,
    manifest: manifest.entries,
    total_rows: manifest.entries.reduce((sum, item) => sum + item.row_count, 0),
    default_teacher_user_id: teacher.userId,
    teacher_count: teacher.count,
    owner_fallback: "Manifest rows without a traceable owner are assigned to the configured default administrator; this deployment has one teacher.",
    execute,
  };
}

async function insertRelations(client: pg.PoolClient, kind: Kind, id: string, data: Row): Promise<void> {
  const rev = revisionId(kind, id);
  if (kind === "knowledge") {
    for (const [position, prerequisite] of split(data["前置知识点"]).entries()) {
      const itemId = `item_official_${hash(Buffer.from(`${rev}:pre:${position}`)).slice(0, 20)}`;
      await client.query(`insert into content_revision_item(item_id,revision_id,tenant_id,item_kind,position) values($1,$2,$3,'knowledge_prerequisite',$4) on conflict do nothing`, [itemId, rev, tenantId, position]);
      await client.query(`insert into content_knowledge_prerequisite(item_id,tenant_id,prerequisite_revision_id) values($1,$2,$3) on conflict do nothing`, [itemId, tenantId, revisionId("knowledge", prerequisite)]);
    }
  } else if (kind === "question_type") {
    for (const [position, knowledge] of split(data["关联知识点"]).entries()) {
      const itemId = `item_official_${hash(Buffer.from(`${rev}:k:${position}`)).slice(0, 20)}`;
      await client.query(`insert into content_revision_item(item_id,revision_id,tenant_id,item_kind,position) values($1,$2,$3,'question_type_knowledge',$4) on conflict do nothing`, [itemId, rev, tenantId, position]);
      await client.query(`insert into content_question_type_knowledge(item_id,tenant_id,knowledge_revision_id,role) values($1,$2,$3,'primary') on conflict do nothing`, [itemId, tenantId, revisionId("knowledge", knowledge)]);
    }
  } else if (kind === "error_cause") {
    await client.query(
      `insert into science_v3_error_cause_policy(
         tenant_id,error_cause_revision_id,accepted_verification_sets,
         confirmed_near_due_days,improving_followup_due_days,resolved_delayed_due_days,
         policy_version,published_at
       ) values($1,$2,$3::jsonb,1,7,30,1,now()) on conflict do nothing`,
      [tenantId,rev,JSON.stringify([["near_transfer","far_transfer"],["near_transfer","delayed_verification"]])],
    );
  } else if (kind === "diagnosis_rule") {
    for (const [position, dimension] of [...split(data["知识点ID"]), ...split(data["题型ID"])].entries()) {
      const itemId = `item_official_${hash(Buffer.from(`${rev}:d:${position}`)).slice(0, 20)}`;
      await client.query(`insert into content_revision_item(item_id,revision_id,tenant_id,item_kind,position) values($1,$2,$3,'diagnosis_rule_dimension',$4) on conflict do nothing`, [itemId, rev, tenantId, position]);
      await client.query(`insert into content_diagnosis_rule_dimension(item_id,tenant_id,dimension_revision_id) values($1,$2,$3) on conflict do nothing`, [itemId, tenantId, revisionId(dimension.startsWith("T_") ? "question_type" : "knowledge", dimension)]);
    }
    for (const [position, error] of split(data["错因ID"]).entries()) {
      const itemId = `item_official_${hash(Buffer.from(`${rev}:e:${position}`)).slice(0, 20)}`;
      await client.query(`insert into content_revision_item(item_id,revision_id,tenant_id,item_kind,position) values($1,$2,$3,'diagnosis_rule_error_cause',$4) on conflict do nothing`, [itemId, rev, tenantId, position]);
      await client.query(`insert into content_diagnosis_rule_error_cause(item_id,tenant_id,error_cause_revision_id) values($1,$2,$3) on conflict do nothing`, [itemId, tenantId, revisionId("error_cause", error)]);
    }
    const bins = [
      {
        id: "trigger_matched",
        label: data["诊断结论"] || "符合该诊断规则",
        quality: "strong",
        status: "concluded",
        criterion: data["触发条件"] || "回答符合已发布规则的触发条件",
        relation: "supports",
      },
      {
        id: "trigger_not_matched",
        label: "不符合该诊断规则",
        quality: "strong",
        status: "concluded",
        criterion: `回答有明确证据反对：${data["触发条件"] || id}`,
        relation: "counters",
      },
      {
        id: "unresolved",
        label: "无法由当前回答区分",
        quality: "weak",
        status: "inconclusive",
        criterion: "回答缺失、不相关或证据不足，不能支持或反对候选",
        relation: "non_discriminating",
      },
    ] as const;
    const errors = split(data["错因ID"]);
    for (const bin of bins) {
      await client.query(
        `insert into science_v3_diagnosis_outcome_bin(
           tenant_id,rule_revision_id,outcome_bin_id,label,quality,terminal_status,classification_criterion
         ) values($1,$2,$3,$4,$5,$6,$7) on conflict do nothing`,
        [tenantId,rev,bin.id,bin.label,bin.quality,bin.status,bin.criterion],
      );
      for (const error of errors) {
        await client.query(
          `insert into science_v3_diagnosis_outcome_relation(
             tenant_id,rule_revision_id,outcome_bin_id,error_cause_revision_id,relation
           ) values($1,$2,$3,$4,$5) on conflict do nothing`,
          [tenantId,rev,bin.id,revisionId("error_cause",error),bin.relation],
        );
      }
    }
  } else {
    const options = split(data["选项"]);
    for (const [position, option] of options.entries()) {
      const match = /^([A-ZＡ-Ｚ])[.、:]?\s*(.*)$/.exec(option);
      const itemId = `item_official_${hash(Buffer.from(`${rev}:o:${position}`)).slice(0, 20)}`;
      await client.query(`insert into content_revision_item(item_id,revision_id,tenant_id,item_kind,position) values($1,$2,$3,'question_option',$4) on conflict do nothing`, [itemId, rev, tenantId, position]);
      await client.query(`insert into content_question_option(item_id,tenant_id,option_key,option_text,is_correct) values($1,$2,$3,$4,false) on conflict do nothing`, [itemId, tenantId, match?.[1] ?? String.fromCharCode(65 + position), match?.[2] ?? option]);
    }
    if (data["答案"]) {
      const itemId = `item_official_${hash(Buffer.from(`${rev}:a`)).slice(0, 20)}`;
      await client.query(`insert into content_revision_item(item_id,revision_id,tenant_id,item_kind,position) values($1,$2,$3,'question_answer',$4) on conflict do nothing`, [itemId, rev, tenantId, 0]);
      await client.query(`insert into content_question_answer_item(item_id,tenant_id,answer_text) values($1,$2,$3) on conflict do nothing`, [itemId, tenantId, data["答案"]]);
    }
    for (const [position, dimension] of [...split(data["知识点ID"]), ...split(data["题型ID"])].entries()) {
      const itemId = `item_official_${hash(Buffer.from(`${rev}:m:${position}`)).slice(0, 20)}`;
      await client.query(`insert into content_revision_item(item_id,revision_id,tenant_id,item_kind,position) values($1,$2,$3,'question_measurement_target',$4) on conflict do nothing`, [itemId, rev, tenantId, position]);
      await client.query(`insert into content_question_measurement_target(item_id,tenant_id,dimension_revision_id,target_role,evidence_rule) values($1,$2,$3,$4,$5) on conflict do nothing`, [itemId, tenantId, revisionId(dimension.startsWith("T_") ? "question_type" : "knowledge", dimension), position === 0 ? "primary" : "secondary", "官方清单关联维度"]);
    }
  }
}

async function insertRevision(
  client: pg.PoolClient,
  kind: Kind,
  id: string,
  data: Row,
  packageRevisions: string[],
  ownerTeacherUserId: string,
  writeRelations = true,
): Promise<void> {
  const rev = revisionId(kind, id);
  await client.query(
    `insert into content_entity(entity_id,tenant_id,entity_kind,origin,owner_teacher_user_id,created_by_user_id)
     values($1,$2,$3,'official',$4,$4) on conflict (entity_id) do nothing`, [id, tenantId, kind, ownerTeacherUserId],
  );
  await client.query(
    `insert into content_entity_revision(revision_id,entity_id,tenant_id,revision_no,candidate_set_id,lifecycle_status,created_by_thread_id,model_id,prompt_version)
     values($1,$2,$3,1,null,'ready',null,null,'official-home-manifest-v1') on conflict (revision_id) do nothing`, [rev, id, tenantId],
  );
  if (kind === "knowledge") {
    await client.query(
      `insert into content_knowledge_revision(revision_id,tenant_id,name,description,grade_band,difficulty,mastery_standard,remediation_advice)
       values($1,$2,$3,$4,$5,$6,$7,$8) on conflict (revision_id) do nothing`,
      [rev, tenantId, data["三级知识点"] || id, [data["一级模块"], data["二级模块"]].filter(Boolean).join(" / "), data["一级模块"] || null, numberDifficulty(data["难度"] ?? "中"), data["掌握标准"] || null, data["补弱建议"] || null],
    );
  } else if (kind === "question_type") {
    await client.query(
      `insert into content_question_type_revision(revision_id,tenant_id,name,description,identifying_features,standard_method)
       values($1,$2,$3,$4,$5,$6) on conflict (revision_id) do nothing`,
      [rev, tenantId, data["题型名称"] || id, data["关联知识点"] || "", data["典型问法"] || "", data["标准步骤"] || ""],
    );
  } else if (kind === "error_cause") {
    await client.query(
      `insert into content_error_cause_revision(revision_id,tenant_id,category,name,description,manifestation,judgment_basis,remediation)
       values($1,$2,$3,$4,$5,$6,$7,$8) on conflict (revision_id) do nothing`,
      [rev, tenantId, data["错因大类"] || "", data["错因名称"] || id, data["表现形式"] || "", data["表现形式"] || "", data["判断依据"] || "", data["补救建议"] || ""],
    );
  } else if (kind === "diagnosis_rule") {
    await client.query(
      `insert into content_diagnosis_rule_revision(revision_id,tenant_id,rule_version,trigger_text,probe_text)
       values($1,$2,$3,$4,$5) on conflict (revision_id) do nothing`,
      [rev, tenantId, data["优先级"] || "1", data["触发条件"] || id, [data["诊断结论"], data["学习建议"]].filter(Boolean).join("；") || ""],
    );
  } else {
    const typeId = split(data["题型ID"])[0];
    await client.query(
      `insert into content_question_revision(revision_id,tenant_id,chapter_id,stem_format,stem_markdown,difficulty,question_type_revision_id,analysis_markdown)
       values($1,$2,$3,$4,$5,$6,$7,$8) on conflict (revision_id) do nothing`,
      [rev, tenantId, data["来源"] || "official-home", stemFormat(data["题型"] || ""), data["题干"] || id, numberDifficulty(data["难度"] ?? "中"), typeId ? revisionId("question_type", typeId) : null, data["解析"] || ""],
    );
  }
  if (writeRelations) await insertRelations(client, kind, id, data);
  packageRevisions.push(rev);
}

async function executeImport(
  manifest: Awaited<ReturnType<typeof loadManifest>>,
  client: pg.PoolClient,
  teacher: { userId: string; count: number },
): Promise<{ package_id: string; revision_count: number; source_count: number }> {
  const packageRevisions: string[] = [];
  const sources: Array<{ sourceId: string; file: string; digest: string }> = [];
  // Source documents are independent of entity ordering and are created once.
  for (const entry of manifest.entries) {
    const rows = manifest.files.get(entry.source_file) ?? [];
    const digest = manifest.hashes.get(entry.source_file)!;
    const id = sourceId(digest);
    if (sources.some((source) => source.sourceId === id)) continue;
    sources.push({ sourceId: id, file: entry.source_file, digest });
    await client.query(
      `insert into content_source
         (source_id,tenant_id,origin,owner_teacher_user_id,uploaded_by_user_id,source_kind,
          original_sha256,storage_object_id,source_uri,verified_at)
       values($1,$2,'official',$3,$3,'official-csv',$4,null,$5,now())
       on conflict (source_id) do nothing`,
      [id, tenantId, teacher.userId, digest, `manifest://${entry.source_file}`],
    );
  }
  // Build every parent revision before writing cross-entity relations.  This
  // keeps the importer valid even when a CSV row points to a later K/T/E row.
  const kindOrder: Kind[] = ["knowledge", "question_type", "error_cause", "diagnosis_rule", "question"];
  for (const kind of kindOrder) {
    for (const entry of manifest.entries.filter((item) => item.entity_kind === kind)) {
      const rows = manifest.files.get(entry.source_file) ?? [];
      for (const row of rows) await insertRevision(client, kind, row[entry.id_column]!, row, packageRevisions, teacher.userId, false);
    }
  }
  for (const kind of kindOrder) {
    for (const entry of manifest.entries.filter((item) => item.entity_kind === kind)) {
      const rows = manifest.files.get(entry.source_file) ?? [];
      for (const row of rows) await insertRelations(client, kind, row[entry.id_column]!, row);
    }
  }
  const uniqueRevisions = [...new Set(packageRevisions)];
  await client.query(
    `insert into content_package(package_id,tenant_id,origin,owner_teacher_user_id,title,version_no,status,manifest_sha256)
     values($1,$2,'official',$3,'MathPilot 官方初始内容库',1,'ready',$4)
     on conflict (package_id) do nothing`, [packageId(), tenantId, teacher.userId, hash(Buffer.from(JSON.stringify(manifest.entries)))],
  );
  for (const [position, revision] of uniqueRevisions.entries()) {
    await client.query(`insert into content_package_item(tenant_id,package_id,revision_id,item_order) values($1,$2,$3,$4) on conflict do nothing`, [tenantId, packageId(), revision, position]);
  }
  return { package_id: packageId(), revision_count: uniqueRevisions.length, source_count: sources.length };
}

async function main(): Promise<void> {
  const manifest = await loadManifest();
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`select set_config('app.current_tenant',$1,true),set_config('app.current_user',$2,true),set_config('app.current_roles','teacher',true)`, [tenantId, process.env.DEFAULT_TEACHER_USER_ID ?? "official-import"]);
      const teacher = await defaultTeacher(client);
      await client.query(`select set_config('app.current_user',$1,true)`, [teacher.userId]);
      const summary = await report(manifest, teacher);
      const reportPath = path.resolve(root, reportArg ?? "db/migration-data/official-content-import-report.json");
      await writeFile(reportPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
      console.log(JSON.stringify(summary, null, 2));
      if (!execute) { await client.query("rollback"); console.log(`dry-run only; pass --execute after reviewing ${reportPath}`); return; }
      const imported = await executeImport(manifest, client, teacher);
      await client.query("commit");
      console.log(JSON.stringify({ ...imported, executed: true }, null, 2));
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  } finally { await pool.end(); }
}

await main();
