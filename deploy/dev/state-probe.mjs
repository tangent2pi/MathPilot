// 一次性验证：8081 登录后，/api/learning/me/state 是否能读到 stu_student01 的 A 层 BKT 投影
const API = "http://localhost:8081";
const EMAIL = "student@mathpilot.local";
const PASSWORD = "MathPilotStudent123!";

let cookies = {};
function cookieHeader() { return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; "); }
async function req(method, path, body) {
  const headers = { origin: API };
  const ch = cookieHeader();
  if (ch) headers.cookie = ch;
  let payload;
  if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(`${API}${path}`, { method, headers, body: payload, redirect: "manual" });
  const setc = res.headers.get("set-cookie");
  if (setc) for (const c of setc.split(/,(?=\s*[a-zA-Z0-9_.-]+=)/)) {
    const [pair] = c.trim().split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}
const dump = (label, d) => {
  const lines = Array.isArray(d) ? d : d?.data ?? d?.items ?? d;
  console.log(`\n===== ${label} (status=${arguments[1]?.status ?? "-"}) =====`);
  const arr = Array.isArray(lines) ? lines : [lines];
  console.log(JSON.stringify(arr, null, 1).slice(0, 4000));
};

let r = await req("POST", "/api/auth/sign-in/email", { email: EMAIL, password: PASSWORD, rememberMe: false });
console.log("登录:", r.status);
if (r.status !== 200) { console.error(r.raw ?? JSON.stringify(r.json).slice(0, 500)); process.exit(1); }

for (const kind of ["knowledge", "question_type", "all"]) {
  const st = await req("GET", `/api/learning/me/state?kind=${kind}`);
  console.log(`\n===== me/state kind=${kind} (http ${st.status}) =====`);
  const d = st.json?.data;
  if (Array.isArray(d)) {
    if (d.length === 0) console.log("(空数组)");
    for (const row of d) {
      const m = row.mastery;
      console.log(`- ${row.dimension_id} | label=${row.label ?? "?"} | state=${m?.state} | p=${m?.p_mastery} | indep=${m?.independent_count} | transfer=${m?.transfer_evidence} | ${row.evidence_href ?? ""}`);
    }
  } else {
    console.log(JSON.stringify(st.json, null, 1).slice(0, 3000));
  }
}

const ov = await req("GET", "/api/learning/me/overview");
console.log(`\n===== me/overview (http ${ov.status}) =====`);
const dd = ov.json?.data;
if (dd) {
  console.log("actor:", JSON.stringify(dd.actor));
  console.log("facts:", JSON.stringify(dd.facts ?? {}).slice(0, 1200));
  console.log("cards:", JSON.stringify(dd.cards ?? []).slice(0, 1500));
} else console.log(JSON.stringify(ov.json, null, 1).slice(0, 2000));
