// rerender-answer-check.mjs — 对已定稿"解三角形"卷重新出答案解析并校验无 [object Object] 乱码
import { readFileSync, writeFileSync } from 'node:fs';

const ENV = Object.fromEntries(
  readFileSync('.env', 'utf8').split(/\r?\n/)
    .filter((line) => line && !line.trimStart().startsWith('#'))
    .map((line) => { const i = line.indexOf('='); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; }),
);

const BASE = 'http://localhost:8081';
const PAPER_ID = 'paper_1142da87bc644f628b0a';
let cookies = {};
function cookieHeader() { return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '); }
async function req(method, path, body, timeoutMs = 300_000) {
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

const login = await req('POST', '/api/auth/sign-in/email', { email: ENV.BETTER_AUTH_TEACHER_EMAIL, password: ENV.BETTER_AUTH_TEACHER_PASSWORD, rememberMe: false });
console.log('登录:', login.status);
if (login.status !== 200) { console.log(login.raw?.slice(0, 400)); process.exit(1); }

const render = await req('POST', `/api/content/papers/${PAPER_ID}/answer/render`);
console.log('render status:', render.status, JSON.stringify(render.json ?? {}).slice(0, 300));
if (render.status !== 200) { console.log('render 失败:', render.raw?.slice(0, 1200)); process.exit(1); }

const body = render.json || {};
const url = body.download_url || body.url || '';
if (!url) { console.log('无下载链接'); process.exit(1); }
const dl = await fetch(url, { redirect: 'follow' });
const buf = Buffer.from(await dl.arrayBuffer());
const p = `rerender-answer-${Date.now().toString(36)}.pdf`;
writeFileSync(p, buf);
console.log('PDF 大小:', buf.length, '头:', buf.slice(0, 8).toString('latin1'), '→', p);