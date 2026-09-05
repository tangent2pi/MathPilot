// self-test v2 冒烟（Task #33）：3 轮 × 15 题，验证分层出题计划、多轮累积、
// 轮小结 vs 终版报告分流、单例锁、report/latest 入口。
// 用法：node deploy/dev/self-test-v2-smoke.mjs   （环境：web 网关 8081 + 后端在跑）
const API = process.env.ST_API ?? "http://localhost:8081";
const EMAIL = process.env.ST_EMAIL ?? "student@mathpilot.local";
const PASSWORD = process.env.ST_PASSWORD ?? "MathPilotStudent123!";

// ROUND_PLAN 的 1–5 难度档序列（入门8=1,1,1,2,2,2,3,3 + 进阶5=3,3,4,4,4 + 综合2=5,5）
const EXPECTED_DIFF = [1, 1, 1, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 5, 5];
const ROUND_SIZE = 15;

let cookies = {};
const cookieHeader = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
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
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 400) }; }
  return { status: res.status, json };
}

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---- 登录 --------------------------------------------------------------------
let r = await req("POST", "/api/auth/sign-in/email", { email: EMAIL, password: PASSWORD, rememberMe: false });
if (r.status >= 300) { console.error("✗ 登录失败", r.status, JSON.stringify(r.json).slice(0, 400)); process.exit(1); }
console.log(`[0] 登录 ${EMAIL} → http ${r.status}`);

// ---- 知识树：选 3 个可抽点（尽量跨模块） ---------------------------------------
r = await req("GET", "/api/learning/self-test/knowledge-tree");
const chapters = r.json?.chapters ?? [];
const pool = [];
for (const ch of chapters) for (const md of ch.modules ?? []) {
  for (const kp of md.knowledgePoints ?? []) if (kp.drawable > 0) pool.push({ ...kp, moduleName: md.moduleName });
}
const byModule = new Map();
for (const kp of pool) if (!byModule.has(kp.moduleName)) byModule.set(kp.moduleName, kp);
const knowledgeIds = [...byModule.values()].slice(0, 3).map((kp) => kp.knowledgeId);
check("知识树可抽点充足（≥3）", knowledgeIds.length >= 3, `选中 ${knowledgeIds.join(",")}`);
const chapterName = chapters[0]?.chapterName ?? "未分章";

// ---- 清理：若已有进行中的轮先收尾 ----------------------------------------------
r = await req("GET", "/api/learning/self-test/current");
if (r.json?.run?.status === "active") {
  await req("POST", `/api/learning/self-test/runs/${r.json.run.runId}/finish`, {});
  console.log(`[0] 已收尾遗留轮 ${r.json.run.runId}`);
}

// ---- 三轮主流程 ---------------------------------------------------------------
let threadId = "";
const roundReports = [];
const roundDiffSeq = [];
const roundNos = [];

for (let round = 1; round <= 3; round += 1) {
  console.log(`\n───────── 第 ${round} 轮 ─────────`);
  const stamp = `v2smoke-${Date.now().toString(36)}-r${round}`;
  const createBody = { thread_id: threadId, goal_score: 85, daily_minutes: 30, idempotency_key: `${stamp}:create` };
  if (round === 1) createBody.knowledge_ids = knowledgeIds, createBody.chapter_name = chapterName;
  r = await req("POST", "/api/learning/self-test/runs", createBody);
  if (r.status >= 300) {
    check(`第 ${round} 轮建轮`, false, `http ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
    break;
  }
  const run = r.json.run;
  threadId = r.json.thread_id ?? threadId;
  roundNos.push(run.roundNo);
  console.log(`  建轮 ${run.runId} roundNo=${run.roundNo} cap=${run.questionCap} thread=${threadId}`);

  // 单例锁：轮进行中再建一轮应 409
  if (round === 1) {
    const dup = await req("POST", "/api/learning/self-test/runs", {
      thread_id: threadId, knowledge_ids: knowledgeIds, idempotency_key: `${stamp}:dup`,
    });
    check("单例锁（进行中建轮被拒 409）", dup.status === 409, `http ${dup.status}`);
  }

  // 逐题作答：混合对错（奇数题取首选项，偶数题故意答错）
  let cur = run;
  const diffs = [];
  let seq = 0;
  while (cur.status === "active" && cur.question && seq < ROUND_SIZE) {
    seq += 1;
    const q = cur.question;
    diffs.push(Math.round(q.difficulty * 5));
    const response = seq % 2 === 1 ? (q.options?.length ? q.options[0].key : "1") : "__PROBE_WRONG__";
    r = await req("POST", `/api/learning/self-test/runs/${cur.runId}/answers`, {
      response, idempotency_key: `${stamp}:ans${seq}`,
    });
    if (r.status >= 300) { console.error(`  作答 #${seq} 失败 http ${r.status}`, JSON.stringify(r.json).slice(0, 300)); break; }
    cur = r.json.run;
  }
  roundDiffSeq.push(diffs);
  check(`第 ${round} 轮答满 ${ROUND_SIZE} 题`, cur.answeredTotal === ROUND_SIZE, `实际 ${cur.answeredTotal}`);
  check(`第 ${round} 轮终态 finished`, cur.status === "finished", `status=${cur.status}`);

  // finish（取报告）
  const fin = await req("POST", `/api/learning/self-test/runs/${cur.runId}/finish`, {});
  const report = fin.json?.report ?? "";
  roundReports.push({ round, report, payload: fin.json?.report_payload ?? null, appended: fin.json?.appended });
  const lines = report.split("\n").filter((l) => l.trim()).length;
  console.log(`  报告 ${report.length} 字 / ${lines} 行，appended=${fin.json?.appended}`);
  console.log(`  ${report.slice(0, 220).replace(/\n/g, " ⏎ ")}`);
}

// ---- 断言汇总 -----------------------------------------------------------------
console.log("\n───────── 断言 ─────────");
check("roundNo 递增 1→2→3", JSON.stringify(roundNos) === "[1,2,3]", `实际 ${JSON.stringify(roundNos)}`);
roundDiffSeq.forEach((seq, i) => {
  check(`第 ${i + 1} 轮难度序列符合 ROUND_PLAN`,
    JSON.stringify(seq) === JSON.stringify(EXPECTED_DIFF), `实际 [${seq.join(",")}]`);
});
const shortRounds = roundReports.filter((x) => x.round < 3);
const finalRound = roundReports.find((x) => x.round === 3);
if (shortRounds.length) {
  check("第 1–2 轮仅出轮小结（非终版）",
    shortRounds.every((x) => !/学习计划|六维|风险/.test(x.report)),
    shortRounds.map((x) => `${x.round}:${x.report.length}字`).join(" "));
}
if (finalRound) {
  check("第 3 轮出终版报告（含整章/风险/学习计划）",
    /学习计划/.test(finalRound.report) && /风险/.test(finalRound.report),
    `${finalRound.report.length} 字`);
  check("终版报告带结构化 payload", finalRound.payload !== null,
    finalRound.payload ? `keys=${Object.keys(finalRound.payload).join(",")}` : "无");
}
// report/latest 入口（≥3 轮后应可重取）
if (threadId) {
  const latest = await req("GET", `/api/learning/self-test/report/latest?thread_id=${encodeURIComponent(threadId)}`);
  check("report/latest 重取整章报告", latest.status === 200,
    `http ${latest.status}${latest.status === 200 ? ` round_no=${latest.json?.round_no}` : ""}`);
  const prog = await req("GET", `/api/learning/self-test/progress?thread_id=${encodeURIComponent(threadId)}`);
  check("progress 返回下一轮序号", prog.status === 200 && prog.json?.next_round_no >= 3,
    `next_round_no=${prog.json?.next_round_no}`);
}

const failed = results.filter((x) => !x.pass);
console.log(`\n${failed.length === 0 ? "✅ 全部通过" : `❌ ${failed.length}/${results.length} 项失败`}（共 ${results.length} 项）`);
if (failed.length) { for (const f of failed) console.log(`   - ${f.name}：${f.detail}`); process.exit(1); }
