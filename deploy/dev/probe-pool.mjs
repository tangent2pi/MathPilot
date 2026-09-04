// probe-pool.mjs — 查看教师题库实际题型分布
import { readFileSync } from 'node:fs';
const ENV = Object.fromEntries(
  readFileSync('.env', 'utf8').split(/\r?\n/)
    .filter((line) => line && !line.trimStart().startsWith('#'))
    .map((line) => { const i = line.indexOf('='); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; }),
);
const BASE = 'http://localhost:8081';
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
  for (const c of setCookies) { const [pair] = c.split(';'); const eq = pair.indexOf('='); if (eq > 0) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim(); }
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, raw: text };
}
const login = await req('POST', '/api/auth/sign-in/email', { email: ENV.BETTER_AUTH_TEACHER_EMAIL, password: ENV.BETTER_AUTH_TEACHER_PASSWORD, rememberMe: false });
console.log('login', login.status);
const q = await req('GET', '/api/content/teacher/library/questions');
const list = (q.json || {}).questions || [];
console.log('status', q.status, 'count', list.length);
const byType = {};
for (const item of list) { const t = item.stem_format || 'unknown'; (byType[t] = byType[t] || []).push(item); }
console.log('题型分布:', JSON.stringify(byType));
