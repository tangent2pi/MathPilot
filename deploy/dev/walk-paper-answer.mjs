// walk-paper-answer.mjs — 组卷答案解析全链路冒烟（教师）
// 登录 → 选题建卷(manual) → 定稿 → prepare(题库答案+AI补全) → 复核保存 → render(出答案PDF) → 下载校验
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

// 1) 教师登录
const login = await req('POST', '/api/auth/sign-in/email', { email: ENV.BETTER_AUTH_TEACHER_EMAIL, password: ENV.BETTER_AUTH_TEACHER_PASSWORD, rememberMe: false });
check('教师登录 200', login.status === 200, String(login.status));
if (login.status !== 200) { console.log(login.raw?.slice(0, 400)); process.exit(1); }

// 2) 读取可选题目清单
const q = await req('GET', '/api/content/teacher/library/questions');
const qBody = q.json || {};
const list = qBody.questions || [];
check('可选题目清单可读', q.status === 200 && list.length >= 3, `count=${list.length}`);
if (list.length < 3) { console.log(JSON.stringify(qBody).slice(0, 500)); process.exit(1); }

// 3) 按题型分组，覆盖 选择/填空/解答
const byType = {};
for (const item of list) {
  const t = item.stem_format || 'unknown';
  (byType[t] = byType[t] || []).push(item);
}
console.log('题型分布:', JSON.stringify(Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, v.length]))));

function pickType(keywords) {
  for (const [t, arr] of Object.entries(byType)) {
    if (keywords.some((k) => t.includes(k)) && arr.length) return arr[0];
  }
  return null;
}
const choice = pickType(['single_choice']) || list[0];
const fill = pickType(['fill_blank']) || list[1];
const solution = pickType(['open_solution']) || list[2];
const picked = [choice, fill, solution].filter(Boolean).slice(0, 3);
const revisions = picked.map((x) => ({ entity_id: x.entity_id, revision_id: x.revision_id }));
const counts = { single_choice: 0, fill_blank: 0, open_solution: 0 };
picked.forEach((x) => {
  const t = x.stem_format || '';
  if (t.includes('single_choice')) counts.single_choice += 1;
  else if (t.includes('fill_blank')) counts.fill_blank += 1;
  else counts.open_solution += 1;
});
if (counts.single_choice + counts.fill_blank + counts.open_solution === 0) counts.open_solution = picked.length;
console.log('选题:', JSON.stringify(picked.map((x) => ({ t: x.stem_format, id: x.entity_id }))));
console.log('counts:', JSON.stringify(counts));

// 4) 手动建卷
const title = `答案解析冒烟卷-${Date.now().toString(36)}`;
const created = await req('POST', '/api/content/papers', {
  title,
  config: { counts, difficulty_ratio: { easy: 0.4, medium: 0.4, hard: 0.2 } },
  revisions,
});
check('手动建卷 201', created.status === 201 && created.json && created.json.paper_id, created.status === 201 ? JSON.stringify(created.json).slice(0, 200) : created.raw?.slice(0, 200));
if (created.status !== 201 || !created.json?.paper_id) process.exit(1);
const paperId = created.json.paper_id;

// 5) 定稿
const fin = await req('POST', `/api/content/papers/${paperId}/finalize`);
check('定稿 200', fin.status === 200, String(fin.status));
if (fin.status !== 200) process.exit(1);

// 6) 生成答案解析草稿（题库答案 + AI 补全）
const prepStart = Date.now();
const prep = await req('POST', `/api/content/papers/${paperId}/answer/prepare`);
const prepMs = Date.now() - prepStart;
const prepBody = prep.json || {};
const prepItems = prepBody.items || [];
check('prepare 200', prep.status === 200, `status=${prep.status} ms=${prepMs}`);
check('prepare 返回逐题条目', prepItems.length === picked.length, `items=${prepItems.length}`);
check('prepare 条目含答案', prepItems.every((i) => typeof i.answer_text === 'string' && i.answer_text.length > 0), `filled=${prepItems.filter((i) => i.answer_text).length}/${prepItems.length}`);
check('prepare 条目含解析', prepItems.every((i) => typeof i.analysis_text === 'string' && i.analysis_text.length > 0), `filled=${prepItems.filter((i) => i.analysis_text).length}/${prepItems.length}`);
if (prep.status !== 200) { console.log('prepare 失败详情:', prep.raw?.slice(0, 800)); process.exit(1); }
console.log('答案样例:', JSON.stringify(prepItems.map((i) => ({ n: i.item_order + 1, src: i.source, ans: (i.answer_text || '').slice(0, 30), review: i.need_review }))));

// 7) 读取草稿
const get = await req('GET', `/api/content/papers/${paperId}/answer`);
const getBody = get.json || {};
check('GET answer 200', get.status === 200 && (getBody.items || []).length === picked.length, `items=${(getBody.items || []).length}`);

// 8) 复核保存：清掉 need_review，标记 source=teacher
const savedItems = prepItems.map((i) => ({ item_order: i.item_order, answer_text: i.answer_text, analysis_text: i.analysis_text, need_review: false, review_note: null }));
const save = await req('PUT', `/api/content/papers/${paperId}/answer/items`, { items: savedItems });
check('复核保存 200', save.status === 200 && save.json?.saved === true, `status=${save.status} count=${save.json?.count}`);
if (save.status !== 200) console.log('复核保存失败详情:', save.raw?.slice(0, 800));

// 9) 生成答案解析 PDF
const renderStart = Date.now();
const render = await req('POST', `/api/content/papers/${paperId}/answer/render`);
const renderMs = Date.now() - renderStart;
const renderBody = render.json || {};
check('render 200', render.status === 200, `status=${render.status} ms=${renderMs} ${JSON.stringify(renderBody).slice(0, 300)}`);
if (render.status !== 200) { console.log('render 失败详情:', render.raw?.slice(0, 1200)); process.exit(1); }

// 10) 下载答案 PDF 并校验
const downloadUrl = renderBody.download_url || renderBody.url || '';
check('返回下载链接', typeof downloadUrl === 'string' && downloadUrl.length > 0, downloadUrl.slice(0, 120));
let pdfOk = false, pdfSize = 0, pdfHead = '', pdfPath = '';
if (downloadUrl) {
  try {
    const dl = await fetch(downloadUrl, { redirect: 'follow' });
    const buf = Buffer.from(await dl.arrayBuffer());
    pdfSize = buf.length;
    pdfHead = buf.slice(0, 8).toString('latin1');
    pdfOk = dl.status === 200 && buf.length > 40 && pdfHead.startsWith('%PDF');
    if (pdfOk) {
      pdfPath = `paper-answer-smoke-${Date.now().toString(36)}.pdf`;
      await import('node:fs/promises').then((fs) => fs.writeFile(pdfPath, buf));
    }
  } catch (e) { console.log('下载失败:', e.message); }
}
check('答案 PDF 可下载且头合法', pdfOk, `size=${pdfSize} head=${JSON.stringify(pdfHead)}`);
if (pdfPath) console.log('答案 PDF 已保存:', pdfPath);

// 11) 详情应带 answer_pdf_sha256
const detail = await req('GET', `/api/content/papers/${paperId}`);
const detailBody = detail.json || {};
check('详情含 answer_pdf_sha256', detail.status === 200 && typeof detailBody.answer_pdf_sha256 === 'string' && detailBody.answer_pdf_sha256.length > 0, detailBody.answer_pdf_sha256?.slice(0, 16));

// 12) 二次 render 应复用对象（reused=true）
const render2 = await req('POST', `/api/content/papers/${paperId}/answer/render`);
const render2Body = render2.json || {};
check('二次 render 复用对象', render2.status === 200 && render2Body.reused === true, `reused=${render2Body.reused} object=${render2Body.object_id}`);

const passed = results.filter((r) => r.ok).length + '/' + results.length;
console.log(`\n== paper answer smoke: ${passed} passed ==`);
if (results.some((r) => !r.ok)) process.exitCode = 1;
