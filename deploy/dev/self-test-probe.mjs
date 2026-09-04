// 一次性/回归探针：验证 self-test 闭环（web 8081 网关）——
// 登录 → 知识树 → current(续测入口) → 建轮 → 逐题作答(BKT 推进) → 结束报告。
// 与 state-probe.mjs 同款会话机制：fetch + 手动 cookie（不经 curl jar，规避 Secure/路径语义）。
const API = process.env.ST_API ?? "http://localhost:8081";
const EMAIL = process.env.ST_EMAIL ?? "student@mathpilot.local";
const PASSWORD = process.env.ST_PASSWORD ?? "MathPilotStudent123!";

let cookies = {};
function cookieHeader() { return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; "); }
function absorbSetCookie(res) {
  const list = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : (res.headers.get("set-cookie") ?? "").split(/,(?=\s*[a-zA-Z0-9_.-]+=)/);
  for (const line of list) {
    const pair = line.split(";")[0].trim();
    const eq = pair.indexOf("=");
    if (eq > 0) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
}
async function req(method, path, body) {
  const headers = { origin: API };
  const ch = cookieHeader();
  if (ch) headers.cookie = ch;
  let payload;
  if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(`${API}${path}`, { method, headers, body: payload, redirect: "manual" });
  absorbSetCookie(res);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 300) }; }
  return { status: res.status, json };
}
const ok = (r, what) => {
  if (r.status >= 200 && r.status < 300) return;
  console.error(`✗ ${what} 失败: http ${r.status}`, JSON.stringify(r.json).slice(0, 600));
  process.exit(1);
};
const dimLine = (dims) => dims.map((d) => `${d.knowledgeId}:${d.answered}答/${d.correct}对 p=${d.pMastery} ${d.state}${d.transferEvidence ? `(迁移${d.transferEvidence})` : ""}`).join("  |  ");

// ---- 1) 登录 ----------------------------------------------------------------
let r = await req("POST", "/api/auth/sign-in/email", { email: EMAIL, password: PASSWORD, rememberMe: false });
ok(r, "登录");
console.log(`[1] 登录 ${EMAIL} → http ${r.status}（cookies: ${Object.keys(cookies).join(", ") || "(无)"}）`);

// ---- 2) 知识树 --------------------------------------------------------------
r = await req("GET", "/api/learning/self-test/knowledge-tree");
ok(r, "知识树");
const chapters = r.json?.chapters ?? [];
let picked = null;
for (const ch of chapters) {
  for (const md of ch.modules ?? []) {
    const kps = (md.knowledgePoints ?? []).filter((kp) => kp.drawable > 0);
    if (kps.length >= 1) { picked = { chapterName: ch.chapterName, moduleName: md.moduleName, kps }; break; }
  }
  if (picked) break;
}
if (!picked) { console.error("✗ 知识树无可抽知识点"); process.exit(1); }
console.log(`[2] 知识树章节数=${chapters.length}；选定 章节=${picked.chapterName} / ${picked.moduleName}`);
for (const kp of picked.kps.slice(0, 4)) console.log(`    - ${kp.knowledgeId} ${kp.name}（可抽 ${kp.drawable}，${(kp.formats ?? []).join("/") || "-"}）`);
const overrideKids = (process.env.ST_KIDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const knowledgeIds = overrideKids.length ? overrideKids : picked.kps.slice(0, 2).map((kp) => kp.knowledgeId);

// ---- 3) current（续测入口，期望无 active 轮） --------------------------------
r = await req("GET", "/api/learning/self-test/current");
ok(r, "current");
const existingRun = r.json?.run;
console.log(`[3] current → ${existingRun ? `有进行中轮 ${existingRun.runId}（先收尾再建新轮）` : "无进行中轮（可建新轮）"}`);
if (existingRun?.status === "active") {
  r = await req("POST", `/api/learning/self-test/runs/${existingRun.runId}/finish`, {});
  ok(r, "清理旧轮 finish");
  console.log(`    已收尾旧轮 ${existingRun.runId}（报告 appended=${r.json?.appended}）`);
}

// ---- 4) 建轮 ----------------------------------------------------------------
const runKey = `self-test-probe-${Date.now().toString(36)}`;
r = await req("POST", "/api/learning/self-test/runs", {
  thread_id: "",
  knowledge_ids: knowledgeIds,
  chapter_name: picked.chapterName,
  quick: "medium",
  idempotency_key: `${runKey}:create`,
});
ok(r, "建轮");
const run = r.json?.run;
const threadId = r.json?.thread_id;
console.log(`[4] 建轮 → ${run.runId} status=${run.status}（thread=${threadId}）questionCap=${run.questionCap}`);
console.log(`    初始维度: ${dimLine(run.dimensions)}`);
console.log(`    第 1 题: [${run.question?.index}] ${run.question?.stemFormat} 难度=${run.question?.difficulty}\n    stem: ${(run.question?.stemMarkdown ?? "").slice(0, 160).replace(/\n/g, " ")}`);

// ---- 5) 作答循环（上限 12 题，跑完为止） --------------------------------------
let cur = run;
let seq = 0;
while (cur.status === "active" && cur.question && seq < 12) {
  seq += 1;
  const q = cur.question;
  const response = q.options?.length ? q.options[0].key : "略";
  const key = `${runKey}:ans${seq}`;
  r = await req("POST", `/api/learning/self-test/runs/${cur.runId}/answers`, {
    response,
    idempotency_key: key,
  });
  ok(r, `作答 #${seq}`);
  cur = r.json?.run;
  const dupe = r.json?.duplicated ? "（幂等命中）" : "";
  console.log(
    `[5.${seq}] ${q.stemFormat} 答「${response}」 → ${r.json?.verdict ?? "?"}${dupe}  | expected=${(r.json?.expected ?? []).join("/") || "—"}`,
  );
  if (cur) {
    console.log(`        进度 ${cur.answeredTotal}/${cur.questionCap}  维度: ${dimLine(cur.dimensions)}`);
    if (cur.status === "active" && cur.question) {
      console.log(`        下一题: [${cur.question.index}] ${cur.question.stemFormat}（stem 前 80 字: ${(cur.question.stemMarkdown ?? "").slice(0, 80).replace(/\n/g, " ")}）`);
    }
  }
}

// ---- 6) 收尾 / 报告 ----------------------------------------------------------
if (cur.status === "active") {
  r = await req("POST", `/api/learning/self-test/runs/${cur.runId}/finish`, {});
  ok(r, "finish");
  cur = r.json?.run;
  console.log(`[6] finish → 报告 appended=${r.json?.appended}`);
} else {
  r = await req("POST", `/api/learning/self-test/runs/${cur.runId}/finish`, {});
  ok(r, "finish(已结束重取报告)");
  console.log(`[6] 轮已自动结束（${cur.status}），重取报告 appended=${r.json?.appended}`);
}
console.log(`    终态维度: ${dimLine(cur.dimensions)}`);
const report = r.json?.report ?? "";
console.log(`    --- 报告（${report.length} 字） ---\n${report.slice(0, 1400)}`);

// ---- 7) 复查 current 应回到 null ---------------------------------------------
r = await req("GET", "/api/learning/self-test/current");
ok(r, "current复查");
console.log(`[7] current 复查 → ${r.json?.run ? `仍存在 ${r.json.run.runId}` : "无进行中轮（单例锁正常释放）"}`);
console.log("\n✅ self-test 闭环探针完成");
