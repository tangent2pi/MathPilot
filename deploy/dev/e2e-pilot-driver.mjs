#!/usr/bin/env node
// 正弦定理试点（K_TRI_002 → Q_TRI_201-216）全链路驱动（science_v3 / api-next 3102）
// 步骤：登录 → 建会话 → 选题意图 → 轮询抽题(question session) → 取题 → 作答 → 收尾 → 判答/BKT
import { createHash } from "node:crypto";

const API = process.env.API || "http://localhost:3102";
const EMAIL = "student@mathpilot.local";
const PASSWORD = "MathPilotStudent123!";
const TENANT = "tnt_dev00001";

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 24);
const nowIso = () => new Date().toISOString();
const key = (tag) => `e2e_pilot_${tag}_${sha(`${Date.now()}-${Math.random()}`)}`;

let cookies = {};
function cookieHeader() { return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; "); }
async function req(method, path, body, { raw } = {}) {
  const headers = { origin: "http://localhost:8081" };
  const ch = cookieHeader();
  if (ch) headers.cookie = ch;
  let payload;
  if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(`${API}${path}`, { method, headers, body: payload, redirect: "manual" });
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of setCookies) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  if (!res.headers.getSetCookie) {
    const setc = res.headers.get("set-cookie");
    if (setc) for (const c of setc.split(/,(?=\s*[a-zA-Z0-9_.-]+=)/)) {
      const [pair] = c.trim().split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  }
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, raw: text };
}
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) 登录
log("登录 Demo Student ...");
let r = await req("POST", "/api/auth/sign-in/email", { email: EMAIL, password: PASSWORD, rememberMe: false });
if (r.status !== 200) { console.error("登录失败", r.status, r.raw?.slice(0, 400)); process.exit(1); }
log(`登录成功 cookies=${Object.keys(cookies).join(",")}`);

// 2) 建会话
const createKey = key("thread");
r = await req("POST", "/api/learning/threads", { title: "正弦定理试点E2E", idempotency_key: createKey });
if (r.status !== 201 && r.status !== 200) { console.error("建会话失败", r.status, JSON.stringify(r.json)); process.exit(1); }
const threadId = r.json.thread.thread_id;
let threadVersion = Number(r.json.thread.version);
log(`会话已建 ${threadId} v${threadVersion}`);

// 3) 选题意图（正弦定理）
const intentKey = key("intent");
const intentBody = {
  schema_version: 3, command_type: "revise_selection_intent",
  idempotency_key: intentKey, expected_version: threadVersion,
  requested_at: nowIso(), conversation_thread_id: threadId,
  natural_language_request: "我想练习正弦定理（解三角形），请抽一道可直接作答的选择题。",
};
r = await req("POST", `/api/learning/threads/${threadId}/intent-revisions`, intentBody);
console.log("选题意图响应:", JSON.stringify(r.json ?? r.raw?.slice(0, 500), null, 1));
if (r.status !== 200 && r.status !== 202) { console.error("选题意图失败", r.status); process.exit(1); }
const intentId = r.json.selection_intent?.selection_intent_id;
const opId = r.json.operation?.operation_id;
log(`intent=${intentId} op=${opId} status=${r.json.operation?.status}`);

// 4) 轮询：操作状态 + 消息/上下文（最长 180s），直到选题落成 question_session
const deadline = Date.now() + 180_000;
let lastSeq = 0;
let questionSessionId = null;
while (Date.now() < deadline) {
  await sleep(4000);
  const ctx = await req("GET", `/api/learning/threads/${threadId}/context`);
  const j = ctx.json;
  const data = j?.data ?? j;
  const curIntent = data?.current_intent ?? null;
  const ops = data?.operations ?? [];
  const opStatus = ops.find?.((o) => o.operation_id === opId)?.status ?? (curIntent ? `intent_rev=${curIntent.revision}` : "?");
  const curQ = data?.current_question ?? null;
  if (opStatus && opStatus !== "running") log(`选题操作状态 → ${opStatus}`);
  const curSessionId = curQ ? (curQ.question_session_id ?? curQ.id) : null;
  if (curQ && curSessionId) {
    questionSessionId = curSessionId;
    log(`current_question.session=${curSessionId} rev=${curQ.question_revision_id ?? curQ.revision_id ?? ""} status=${curQ.status ?? ""}`);
  }
  const msgs = await req("GET", `/api/learning/threads/${threadId}/messages?after=${lastSeq}`);
  if (Array.isArray(msgs.json?.messages)) {
    for (const m of msgs.json.messages) {
      if (Number(m.sequence) <= lastSeq) continue;
      lastSeq = Number(m.sequence);
      const partTypes = (m.parts ?? []).map((p) => p.type).join(",");
      const head = (m.parts ?? []).map((p) => (typeof p.text === "string" ? p.text.slice(0, 200) : "")).join(" | ");
      log(`  msg#${m.sequence} author=${m.author_kind} parts=[${partTypes}] ${head.slice(0, 220)}`);
    }
  }
  if (opStatus && !["running", "scheduled", "accepted", "queued", "pending"].includes(opStatus) && !curQ) break;
  if (questionSessionId) break;
}
if (!questionSessionId) {
  console.log("未在时限内拿到 question_session。context data:", JSON.stringify((await req("GET", `/api/learning/threads/${threadId}/context`)).json?.data ?? {}, null, 1).slice(0, 2600));
  process.exit(2);
}
// 等待 question_session 在交互视图可读（active + version）
const viewDeadline = Date.now() + 30_000;
let vd = null;
while (Date.now() < viewDeadline) {
  const view = await req("GET", `/api/learning/question-sessions/${questionSessionId}`);
  vd = view.json?.data ?? view.json ?? {};
  if ((vd.question_session?.status ?? "") === "active") break;
  await sleep(3000);
}

// 4.5) 展示题目交互视图（题干/选项/作答指令）
const q = vd.question ?? {};
log(`题目视图：response_kind=${q.response_kind} 选项=${(q.options ?? []).map((o) => o.id).join(",")} 状态=${vd.question_session?.status}`);
console.log("题目题干:", JSON.stringify(q.prompt_parts ?? [], null, 1).slice(0, 900));
console.log("选项:", JSON.stringify(q.options ?? [], null, 1));
console.log("指令:", JSON.stringify(vd.commands ?? [], null, 1));

// 5) 作答（answer attempt）。ANS 环境变量覆盖作答文本，缺省提交 "C"（Q_TRI_215 正确项）。
const ANSWER = process.env.ANS ?? "C";
const attemptKey = key("attempt");
r = await req("POST", `/api/learning/question-sessions/${questionSessionId}/attempts`, {
  schema_version: 3, idempotency_key: attemptKey, expected_version: Number(vd.question_session?.version ?? 1),
  requested_at: nowIso(), attempt_kind: "answer",
  response_parts: [{ type: "text", text: ANSWER }],
});
console.log("作答响应:", JSON.stringify(r.json ?? r.raw?.slice(0, 500), null, 1));
if (r.status !== 200 && r.status !== 201) { console.error("作答失败", r.status, r.raw?.slice(0, 600)); process.exit(3); }
const sessionVersionAfterAttempt = Number(r.json?.question_session_version ?? vd.question_session?.version);
log(`作答已提交 answer="${ANSWER}" session_version=${sessionVersionAfterAttempt}`);

// 6) 切题收尾（completed）→ 触发 finalizeQuestionWorkflow → grade(child) → judgment → BKT replay
const cutKey = key("cut");
r = await req("POST", `/api/learning/question-sessions/${questionSessionId}/cut-requests`, {
  schema_version: 3, idempotency_key: cutKey, expected_version: sessionVersionAfterAttempt,
  requested_at: nowIso(), reason: "completed",
});
console.log("切题响应:", JSON.stringify(r.json ?? r.raw?.slice(0, 500), null, 1));
if (r.status !== 202 && r.status !== 200) { console.error("切题失败", r.status, r.raw?.slice(0, 600)); process.exit(4); }
log(`切题请求已受理 reason=completed`);

// 7) 轮询收尾：session 关闭 + judgment 卡片（最长 240s）
const finalDeadline = Date.now() + 240_000;
let printedJudgment = false;
while (Date.now() < finalDeadline) {
  await sleep(5000);
  const qi = await req("GET", `/api/learning/question-sessions/${questionSessionId}`);
  const qiData = qi.json?.data ?? qi.json ?? {};
  const st = qiData.question_session?.status ?? "?";
  const msgs = await req("GET", `/api/learning/threads/${threadId}/messages?after=${lastSeq}`);
  if (Array.isArray(msgs.json?.messages)) {
    for (const m of msgs.json.messages) {
      if (Number(m.sequence) <= lastSeq) continue;
      lastSeq = Number(m.sequence);
      const partTypes = (m.parts ?? []).map((p) => p.type).join(",");
      for (const p of m.parts ?? []) {
        if (p.type === "domain_ui" && p.part?.view_kind === "judgment") {
          console.log(`判定卡片 msg#${m.sequence}:`, JSON.stringify(p.part.snapshot?.data ?? p.part, null, 1).slice(0, 1800));
          printedJudgment = true;
        }
        if (p.type === "text" && typeof p.text === "string") log(`  msg#${m.sequence} text: ${p.text.slice(0, 300)}`);
      }
      if (!printedJudgment) {
        const head = (m.parts ?? []).map((p) => (typeof p.text === "string" ? p.text.slice(0, 200) : "")).join(" | ");
        log(`  msg#${m.sequence} author=${m.author_kind} parts=[${partTypes}] ${head.slice(0, 220)}`);
      }
    }
  }
  log(`session 状态=${st}${printedJudgment ? "（已见判定卡片）" : ""}`);
  if ((st === "closed" || st === "finalizing") && printedJudgment) break;
  if (st === "closed") break;
}
console.log("收尾后 question_interaction:", JSON.stringify((await req("GET", `/api/learning/question-sessions/${questionSessionId}`)).json?.data ?? {}, null, 1).slice(0, 2200));

// 8) 画像摘要（me/overview + me/state）
const ov = await req("GET", "/api/learning/me/overview");
console.log("me/overview:", JSON.stringify(ov.json?.data ?? ov.json ?? {}, null, 1).slice(0, 1800));
for (const kind of ["mastery", "all"]) {
  const st = await req("GET", `/api/learning/me/state${kind !== "all" ? `?kind=${kind}` : ""}`);
  if (st.status === 200 && st.json?.data) {
    console.log(`me/state${kind !== "all" ? `?kind=${kind}` : ""} 摘要:`, JSON.stringify(st.json.data).slice(0, 1200));
    break;
  }
}
log("E2E 闭环驱动结束");
console.log(`THREAD=${threadId}\nQUESTION_SESSION=${questionSessionId}`);
