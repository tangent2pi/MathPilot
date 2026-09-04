// walk-paper-5types.mjs — 验证后端接受 5 种题型配置（多选/判断/单选/填空/解答）
// 期望结果：配置被接受 → 题池足够则创建成功(201)，题池不足则报“题目池不足”(422)；
// 非法配置（负数题量）必须被拒绝。
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
const detailOf = (body) => (body && typeof body.detail === 'string' ? body.detail : '');

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

const login = await req('POST', '/api/auth/sign-in/email', { email: ENV.BETTER_AUTH_TEACHER_EMAIL, password: ENV.BETTER_AUTH_TEACHER_PASSWORD, rememberMe: false });
check('教师登录 200', login.status === 200, String(login.status));
if (login.status !== 200) { console.log(login.raw?.slice(0, 400)); process.exit(1); }

// 1) 5 题型配置的 auto 组卷：应通过配置解析（题池不足时报“题目池不足”，而非配置解析错误）
const config5 = {
  counts: { single_choice: 1, multiple_choice: 1, fill_blank: 1, true_false: 1, open_solution: 1 },
  difficulty_ratio: { easy: 3, medium: 5, hard: 2 },
};
const auto = await req('POST', '/api/content/papers/auto', { title: '五题型配置验证', config: config5 });
const autoBody = auto.json || {};
const poolError = detailOf(autoBody).includes('题目池不足');
check('5 题型配置被接受（非配置解析错误）', (auto.status === 201 || (auto.status === 422 && poolError)), `status=${auto.status} detail=${JSON.stringify(detailOf(autoBody)).slice(0, 120)}`);
if (auto.status !== 201 && !poolError) console.log('auto 原始响应:', auto.raw?.slice(0, 400));

// 2) 非法配置仍被拒绝（回归：负数题量）
const bad = await req('POST', '/api/content/papers/auto', {
  title: '非法配置',
  config: { counts: { single_choice: -1, multiple_choice: 0, fill_blank: 0, true_false: 0, open_solution: 0 }, difficulty_ratio: { easy: 1, medium: 1, hard: 1 } },
});
const badBody = bad.json || {};
check('负数题量仍被拒绝', bad.status === 422 && typeof badBody.detail === 'string', `status=${bad.status} detail=${JSON.stringify(detailOf(badBody)).slice(0, 120)}`);

// 3) 仅补充题型（多选）也可组卷配置：创建成功(201)或题池不足(422)均视为被接受
const configMulti = {
  counts: { single_choice: 0, multiple_choice: 2, fill_blank: 0, true_false: 0, open_solution: 0 },
  difficulty_ratio: { easy: 1, medium: 1, hard: 1 },
};
const auto2 = await req('POST', '/api/content/papers/auto', { title: '仅多选题配置', config: configMulti });
const auto2Body = auto2.json || {};
const poolError2 = detailOf(auto2Body).includes('题目池不足');
check('仅多选题配置被接受', auto2.status === 201 || (auto2.status === 422 && poolError2), `status=${auto2.status} detail=${JSON.stringify(detailOf(auto2Body)).slice(0, 120)}`);

const passed = results.filter((r) => r.ok).length + '/' + results.length;
console.log(`\n== paper 5-types smoke: ${passed} passed ==`);
if (results.some((r) => !r.ok)) process.exitCode = 1;
