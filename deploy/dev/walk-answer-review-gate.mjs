// walk-answer-review-gate.mjs — 复核门禁：存在未决【复核】项时 render 必须拒绝出 PDF
import { readFileSync } from 'node:fs';

const ENV = Object.fromEntries(
  readFileSync('.env', 'utf8').split(/\r?\n/)
    .filter((line) => line && !line.trimStart().startsWith('#'))
    .map((line) => {
      const i = line.indexOf('=');
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }),
);

const BASE = 'http://localhost:8081';
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${extra ? ' | ' + extra : ''}`); };

let cookies = {};
function cookieHeader() { return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '); }
async function req(method, path, body, timeoutMs = 600_000) {
  const headers = { origin: BASE };
  const ch = cookieHeader();
  if (ch) headers.cookie = ch;
  let payload;
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, { method, headers, body: payload, redirect: 'manual', signal: controller.signal });
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of setCookies) {
      const [pair] = c.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, json, raw: text };
  } finally { clearTimeout(timer); }
}

const login = await req('POST', '/api/auth/sign-in/email', { email: ENV.BETTER_AUTH_TEACHER_EMAIL, password: ENV.BETTER_AUTH_TEACHER_PASSWORD, rememberMe: false });
check('教师登录 200', login.status === 200, String(login.status));
if (login.status !== 200) process.exit(1);

const q = await req('GET', '/api/content/teacher/library/questions');
const list = (q.json || {}).questions || [];
check('可选题目清单可读', q.status === 200 && list.length >= 3, `count=${list.length}`);
if (list.length < 3) process.exit(1);

const byType = {};
for (const item of list) {
  const t = item.stem_format || 'unknown';
  (byType[t] = byType[t] || []).push(item);
}
function pickType(keywords) {
  for (const [t, arr] of Object.entries(byType)) {
    if (keywords.some((k) => t.includes(k)) && arr.length) return arr[0];
  }
  return null;
}
const picked = [pickType(['single_choice']), pickType(['fill_blank']), pickType(['open_solution'])].filter(Boolean).slice(0, 3);
const revisions = picked.map((x) => ({ entity_id: x.entity_id, revision_id: x.revision_id }));
const created = await req('POST', '/api/content/papers', {
  title: `复核门禁卷-${Date.now().toString(36)}`,
  config: { counts: { single_choice: 1, fill_blank: 1, open_solution: 1 }, difficulty_ratio: { easy: 0.4, medium: 0.4, hard: 0.2 } },
  revisions,
});
check('手动建卷 201', created.status === 201 && created.json?.paper_id, created.status === 201 ? JSON.stringify(created.json).slice(0, 160) : created.raw?.slice(0, 200));
if (created.status !== 201 || !created.json?.paper_id) process.exit(1);
const paperId = created.json.paper_id;

const fin = await req('POST', `/api/content/papers/${paperId}/finalize`);
check('定稿 200', fin.status === 200, String(fin.status));
if (fin.status !== 200) process.exit(1);

const prep = await req('POST', `/api/content/papers/${paperId}/answer/prepare`);
const prepItems = (prep.json || {}).items || [];
check('prepare 200', prep.status === 200 && prepItems.length === 3, `status=${prep.status} items=${prepItems.length}`);
if (prep.status !== 200) { console.log(prep.raw?.slice(0, 600)); process.exit(1); }

// 把全部条目标记为待复核，render 必须拒绝
const flagged = prepItems.map((i) => ({ item_order: i.item_order, answer_text: i.answer_text, analysis_text: i.analysis_text, need_review: true, review_note: '门禁测试：全部待复核' }));
const save = await req('PUT', `/api/content/papers/${paperId}/answer/items`, { items: flagged });
check('标记全部待复核 200', save.status === 200 && save.json?.saved === true, `status=${save.status}`);

const blocked = await req('POST', `/api/content/papers/${paperId}/answer/render`);
const blockedBody = blocked.json || {};
check('存在未决复核时 render 拒绝', blocked.status === 422 && blockedBody.error === 'unresolved_review_items', `status=${blocked.status} error=${blockedBody.error}`);
console.log('  拒绝详情:', String(blockedBody.detail || '').slice(0, 120));

// 清掉复核标记后 render 应放行
const cleared = flagged.map((i) => ({ ...i, need_review: false, review_note: null }));
const save2 = await req('PUT', `/api/content/papers/${paperId}/answer/items`, { items: cleared });
check('清除复核标记 200', save2.status === 200, `status=${save2.status}`);
const ok = await req('POST', `/api/content/papers/${paperId}/answer/render`);
const okBody = ok.json || {};
check('复核解决后 render 放行', ok.status === 200 && typeof okBody.object_id === 'string', `status=${ok.status} object=${okBody.object_id}`);

const passed = results.filter((r) => r.ok).length + '/' + results.length;
console.log(`\n== answer review gate: ${passed} passed ==`);
if (results.some((r) => !r.ok)) process.exitCode = 1;
