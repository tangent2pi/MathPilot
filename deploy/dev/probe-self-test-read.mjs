// 一次性验证：迁移后 self-test 读侧（knowledge-tree 可抽知识点 + 题量）是否读到 kb 数据
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

let r = await req("POST", "/api/auth/sign-in/email", { email: EMAIL, password: PASSWORD, rememberMe: false });
console.log("登录:", r.status);
if (r.status !== 200) { console.error(JSON.stringify(r.json).slice(0, 500)); process.exit(1); }

const st = await req("GET", `/api/learning/self-test/knowledge-tree`);
console.log(`\n===== knowledge-tree (http ${st.status}) =====`);
const tree = st.json;
const chapters = tree?.chapters ?? [];
console.log(`章节数: ${chapters.length}`);
let kpTotal = 0, drawableTotal = 0;
const diff = new Map();
const idSet = new Set();
const moduleSet = new Set();
for (const ch of chapters) {
  for (const m of ch.modules ?? []) {
    moduleSet.add(m.moduleName);
    for (const kp of m.knowledgePoints ?? []) {
      kpTotal++;
      drawableTotal += kp.drawable ?? 0;
      idSet.add(kp.knowledgeId);
      const d = kp.difficulty ?? "?";
      diff.set(d, (diff.get(d) ?? 0) + 1);
    }
  }
}
console.log(`模块数: ${moduleSet.size} →`, [...moduleSet].sort().join(" | "));
console.log(`知识点总数(可抽): ${kpTotal}`);
console.log(`总可抽题量(累加): ${drawableTotal}`);
console.log(`难度分布:`, [...diff.entries()].sort((a, b) => (a[0] - b[0])).map(([k, v]) => `${k}=${v}`).join(" "));
// 知识点 ID 范围
const ids = [...idSet].sort();
console.log(`知识点 ID 范围: ${ids[0]} ~ ${ids[ids.length - 1]} (共 ${ids.length} 个)`);
// 找缺口
const nums = ids.map((s) => parseInt(s.replace("K_TRI_", ""), 10)).filter((n) => !isNaN(n)).sort((a, b) => a - b);
const gaps = [];
for (let i = 0; i < nums.length - 1; i++) { if (nums[i + 1] - nums[i] > 1) gaps.push(`${nums[i]}→${nums[i + 1]}`); }
console.log(`K_TRI 编号缺口(仅可抽视角): ${gaps.length ? gaps.join(", ") : "无"}`);
