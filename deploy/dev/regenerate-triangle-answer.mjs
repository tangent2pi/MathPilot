// regenerate-triangle-answer.mjs — 删除"三角形"卷答案项 → AI 重新生成 → 出 PDF
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const requirePkg = createRequire(import.meta.resolve('../../src/services/content-next/package.json'));
const pgMod = requirePkg('pg');
const pg = pgMod?.default ?? pgMod;

const ENV = Object.fromEntries(
  readFileSync(new URL('./.env', import.meta.url), 'utf8').split(/\r?\n/)
    .filter((line) => line && !line.trimStart().startsWith('#'))
    .map((line) => { const i = line.indexOf('='); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; }),
);

const BASE = 'http://localhost:8081';
const PAPER_ID = 'paper_1142da87bc644f628b0a';
const APPLY_DELETE = String(process.env.APPLY_DELETE || '0') === '1';

const pool = new pg.Pool({
  host: '127.0.0.1', port: 5433,
  user: 'mathpilot', password: 'mathpilot-dev-only',
  database: 'mathpilot', max: 2,
});

let cookies = {};
function cookieHeader() { return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '); }
async function req(method, path, body, timeoutMs = 600_000) {
  const headers = { origin: BASE };
  const ch = cookieHeader(); if (ch) headers.cookie = ch;
  let payload;
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, { method, headers, body: payload, redirect: 'manual', signal: controller.signal });
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of setCookies) { const [pair] = c.split(';'); const eq = pair.indexOf('='); if (eq > 0) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim(); }
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, json, raw: text };
  } finally { clearTimeout(timer); }
}

// 1. 登录
const login = await req('POST', '/api/auth/sign-in/email', { email: ENV.BETTER_AUTH_TEACHER_EMAIL, password: ENV.BETTER_AUTH_TEACHER_PASSWORD, rememberMe: false });
console.log('登录:', login.status);
if (login.status !== 200) { console.log(login.raw?.slice(0, 400)); process.exit(1); }

// 2. 删除现有答案项（可选，仅当 APPLY_DELETE=1）
const before = await pool.query('select count(*)::int as n from content_paper_answer_item where paper_id=$1', [PAPER_ID]);
console.log('现有答案项:', before.rows[0].n);
if (APPLY_DELETE) {
  const del = await pool.query('delete from content_paper_answer_item where paper_id=$1', [PAPER_ID]);
  console.log('已删除答案项:', del.rowCount);

  // 3. prepare 重新生成
  console.log('\n--- prepare (AI 补全) ---');
  const prep = await req('POST', `/api/content/papers/${PAPER_ID}/answer/prepare`);
  console.log('prepare status:', prep.status);
  if (prep.status !== 200) { console.log(prep.raw?.slice(0, 1200)); process.exit(1); }
  const items = prep.json?.items ?? [];
  console.log('生成条目数:', items.length);
  for (const it of items) {
    const ans = String(it.answer_text ?? '').slice(0, 40);
    const ana = String(it.analysis_text ?? '').slice(0, 60);
    console.log(`  #${it.item_order} [${it.stem_format}] need_review=${it.need_review} ans="${ans}" ana="${ana}"`);
  }
}

// 4. render 出 PDF
console.log('\n--- render ---');
const render = await req('POST', `/api/content/papers/${PAPER_ID}/answer/render`);
console.log('render status:', render.status, JSON.stringify(render.json ?? {}).slice(0, 200));
if (render.status !== 200) { console.log('render 失败:', render.raw?.slice(0, 1200)); process.exit(1); }
const body = render.json || {};
const url = body.download_url || body.url || '';
if (!url) { console.log('无下载链接'); process.exit(1); }
const dl = await fetch(url, { redirect: 'follow' });
const buf = Buffer.from(await dl.arrayBuffer());
const p = `regenerated-triangle-answer-${Date.now().toString(36)}.pdf`;
writeFileSync(p, buf);
console.log('PDF 大小:', buf.length, '→', p);

await pool.end();
