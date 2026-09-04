// walk-paper-export.mjs — 试卷 PDF 导出全链路冒烟（教师）
// 登录 → 选题建卷(manual) → 定稿 → 导出 PDF → 下载并校验 PDF 头/大小
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
async function req(method, path, body) {
  const headers = { origin: BASE };
  const ch = cookieHeader();
  if (ch) headers.cookie = ch;
  let payload;
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload, redirect: 'manual' });
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of setCookies) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, raw: text };
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

// 3) 按题型分组，尽量覆盖 选择/填空/解答（stem_format 才是题型字段）
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
const title = `PDF导出冒烟卷-${Date.now().toString(36)}`;
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

// 6) 导出 PDF（首次：渲染+落盘）
const exportStart = Date.now();
const exp = await req('POST', `/api/content/papers/${paperId}/export`);
const expMs = Date.now() - exportStart;
const expBody = exp.json || {};
check('导出 200', exp.status === 200, `status=${exp.status} ms=${expMs} ${JSON.stringify(expBody).slice(0, 300)}`);
if (exp.status !== 200) { console.log('导出失败详情:', exp.raw?.slice(0, 800)); process.exit(1); }

// 7) 下载 PDF 并校验
const downloadUrl = expBody.download_url || expBody.url || '';
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
      pdfPath = `paper-export-smoke-${Date.now().toString(36)}.pdf`;
      await import('node:fs/promises').then((fs) => fs.writeFile(pdfPath, buf));
    }
  } catch (e) { console.log('下载失败:', e.message); }
}
check('PDF 可下载且头合法', pdfOk, `size=${pdfSize} head=${JSON.stringify(pdfHead)}`);
if (pdfPath) console.log('PDF 已保存:', pdfPath);

// 8) 再次导出应复用对象（reused=true）
const exp2 = await req('POST', `/api/content/papers/${paperId}/export`);
const exp2Body = exp2.json || {};
check('二次导出复用对象', exp2.status === 200 && exp2Body.reused === true, `reused=${exp2Body.reused} object=${exp2Body.object_id}`);

// 9) 详情应带 pdf_sha256
const detail = await req('GET', `/api/content/papers/${paperId}`);
const detailBody = detail.json || {};
check('详情含 pdf_sha256', detail.status === 200 && typeof detailBody.pdf_sha256 === 'string' && detailBody.pdf_sha256.length > 0, detailBody.pdf_sha256?.slice(0, 16));

// 10) 清理：定稿后的试卷按设计不可删除（404 为预期语义）
const del = await req('DELETE', `/api/content/papers/${paperId}`);
check('定稿卷删除按语义 404', del.status === 404, String(del.status));

const passed = results.filter((r) => r.ok).length + '/' + results.length;
console.log(`\n== paper export smoke: ${passed} passed ==`);
if (results.some((r) => !r.ok)) process.exitCode = 1;
