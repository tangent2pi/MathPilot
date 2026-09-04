// walk-teacher-chat.mjs — 教师对话网页测试
// 前置：docker compose up 后 http://127.0.0.1:8081 可访问。
// 运行：node cdp-drive.mjs <port> walk-teacher-chat.mjs
// 断言点：教师登录、输入框旁无「自我测评」、新对话发送多轮、刷新后历史保留、
//        侧栏出现教师会话。
import { readFileSync } from 'node:fs';

const ENV = Object.fromEntries(
  readFileSync('.env', 'utf8').split(/\r?\n/)
    .filter((line) => line && !line.trimStart().startsWith('#'))
    .map((line) => {
      const i = line.indexOf('=');
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }),
);

const EMAIL = ENV.BETTER_AUTH_TEACHER_EMAIL;
const PASSWORD = ENV.BETTER_AUTH_TEACHER_PASSWORD;
const BASE = 'http://127.0.0.1:8081';

const checks = [];
const check = (name, ok, extra = '') => {
  checks.push({ name, ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${extra ? ' | ' + extra : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cdp, fn, { timeout = 30_000, step = 500, label = '' } = {}) {
  const start = Date.now();
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() - start > timeout) throw new Error(`waitFor timeout: ${label}`);
    await sleep(step);
  }
}

async function dumpState(cdp, label) {
  const s = await cdp.evaluate(`(() => ({
    url: location.href,
    body: document.body.innerText.slice(0, 900),
    btns: [...document.querySelectorAll('button')].filter(e => e.getBoundingClientRect().width > 0)
      .map(e => (e.innerText || '').trim().slice(0, 24)).filter(Boolean).slice(0, 24),
    inputs: [...document.querySelectorAll('input,textarea')].map(i => i.placeholder || i.getAttribute('aria-label')).slice(0, 6),
  }))()`);
  console.log(`--- ${label} ---\nURL: ${s.url}\nbody: ${s.body.replace(/\n+/g, ' | ')}`);
  return s;
}

export async function run(cdp) {
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.sleep(6000);

  // —— 登录（如需） ——
  let st = await dumpState(cdp, 'initial');
  const needLogin = st.btns.some((t) => t.includes('登录')) || st.body.includes('登录');
  if (needLogin) {
    await cdp.evaluate(`(() => {
      const el = [...document.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '登录');
      if (el) { el.click(); return true; } return false;
    })()`);
    await waitFor(cdp, () => cdp.evaluate(
      `Boolean([...document.querySelectorAll('input')].find(x => (x.placeholder||'').includes('邮箱')))`,
    ), { timeout: 15_000, label: 'login form' });
    await cdp.evaluate(`(() => {
      const setVal = (el, v) => {
        if (!el) return;
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const e = [...document.querySelectorAll('input')].find(i => (i.placeholder||'').includes('邮箱'));
      const p = [...document.querySelectorAll('input')].find(i => (i.placeholder||'').includes('密码'));
      setVal(e, ${JSON.stringify(EMAIL)});
      setVal(p, ${JSON.stringify(PASSWORD)});
    })()`);
    await cdp.sleep(500);
    const submitted = await cdp.evaluate(`(() => {
      const dlg = document.querySelector('[role="dialog"]');
      const btn = dlg ? [...dlg.querySelectorAll('button')].filter(b => (b.innerText||'').trim() === '登录').pop() : null;
      if (btn) { btn.click(); return 'dialog'; }
      const forms = [...document.querySelectorAll('form')];
      const fb = forms.length && [...forms[forms.length-1].querySelectorAll('button')].find(b => (b.innerText||'').trim() === '登录');
      if (fb) { fb.click(); return 'form'; }
      return 'none';
    })()`);
    console.log('login submitted via:', submitted);
    await cdp.sleep(6000);
    st = await dumpState(cdp, 'after login');
  }

  const isTeacher = st.body.includes('教师') || st.body.includes('Demo Teacher');
  check('以教师身份登录', isTeacher, `body=${st.body.slice(0, 60)}`);

  // —— 主页面应为教师对话工作台 ——
  await cdp.evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '新对话');
    if (btn) { btn.click(); return true; } return false;
  })()`);
  await cdp.sleep(2500);

  const hasSelfTest = await cdp.evaluate(
    `Boolean([...document.querySelectorAll('button')].find(e => (e.getAttribute('aria-label')||'') === '自我测评'))`,
  );
  check('教师输入区不出现「自我测评」', !hasSelfTest);

  // —— 发送第一问 ——
  const ask = async (text) => {
    const setResult = await cdp.evaluate(`(() => {
      const el = [...document.querySelectorAll('textarea')].find(i => (i.getAttribute('aria-label')||'') === 'Message input'
        || (i.placeholder||'').includes('输入'));
      if (!el) return 'no-composer';
      const proto = window.HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.focus();
      return 'ok';
    })()`);
    await cdp.sleep(600);
    const clickResult = await cdp.evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label')||'') === '发送消息');
      if (!btn) return 'no-send-btn';
      btn.click();
      return 'clicked';
    })()`);
    console.log(`ask: set=${setResult} click=${clickResult}`);
    return clickResult;
  };

  const assistantTexts = async () => {
    const value = await cdp.evaluate(`(() => [...document.querySelectorAll('[data-role="assistant"]')]
      .map(e => (e.innerText || '').trim()).filter(Boolean))()`);
    return (Array.isArray(value) ? value : []);
  };

  const waitReplyCount = async (minCount, label) => {
    const started = Date.now();
    for (;;) {
      const texts = await assistantTexts();
      const meaningful = texts.filter((t) => t.length > 0 && t !== '●');
      if (meaningful.length >= minCount) {
        return { texts: meaningful, waitedMs: Date.now() - started };
      }
      if (Date.now() - started > 600_000) throw new Error(`timeout waiting reply (${label})`);
      await sleep(2500);
    }
  };

  const firstQ = '请出一道关于解三角形中线的题目，并简要说明思路。';
  await ask(firstQ);
  console.log('first question sent, waiting assistant…');
  const r1 = await waitReplyCount(1, 'first reply');
  console.log(`first reply after ${r1.waitedMs}ms`);
  check('第一轮获得助手回复', r1.texts.length >= 1, r1.texts[0]?.slice(0, 40));

  await cdp.screenshot('ui-shots/teacher-chat-1-first-reply.png');

  // —— 多轮追问 ——
  const secondQ = '再换一道更难的（涉及外接圆）并讲解。';
  await ask(secondQ);
  console.log('second question sent, waiting assistant…');
  const r2 = await waitReplyCount(2, 'second reply');
  console.log(`second reply after ${r2.waitedMs}ms`);
  const msgCount = await cdp.evaluate(`(() => {
    const u = [...document.querySelectorAll('[data-role="user"]')];
    const a = [...document.querySelectorAll('[data-role="assistant"]')];
    return { users: u.length, assistants: a.length };
  })()`);
  check('多轮连续对话（≥2问2答）', msgCount.users >= 2 && msgCount.assistants >= 2,
    JSON.stringify(msgCount));

  const url = await cdp.evaluate('location.href');
  const threadMatch = /\/c\/([^/]+)/.exec(url);
  check('已跳转到教师会话 /c/:threadId', Boolean(threadMatch), url);
  const threadId = threadMatch ? decodeURIComponent(threadMatch[1]) : '';

  await cdp.screenshot('ui-shots/teacher-chat-2-multiturn.png');

  // —— 刷新后历史保留（服务端持久化） ——
  await cdp.send('Page.reload');
  await cdp.sleep(7000);
  const afterReload = await waitFor(cdp, async () => {
    const t = await assistantTexts();
    return t.length >= 2 ? t : null;
  }, { timeout: 30_000, label: 'reload persisted' });
  check('刷新后历史保留（多轮仍在）', afterReload.length >= 2, `${afterReload.length} 条助手消息`);

  // —— 侧栏教师会话列表 ——
  const sidebarThread = await waitFor(cdp, () => cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('button')]
      .map(b => (b.innerText || '').trim())
      .filter(t => t.startsWith('对话 · '));
    return rows.length ? rows : null;
  })()`), { timeout: 20_000, label: 'sidebar teacher thread' });
  check('侧栏列出教师会话', Boolean(sidebarThread), JSON.stringify(sidebarThread));

  await cdp.screenshot('ui-shots/teacher-chat-3-persisted.png');

  // —— 回到根路径，确认仍是干净的新对话工作台 ——
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.sleep(3000);
  const welcome = await cdp.evaluate(`document.body.innerText.includes('今天想从哪道数学问题开始')`);
  check('回到根路径显示新对话欢迎语', welcome);

  const summary = checks.filter((c) => c.ok).length + '/' + checks.length;
  console.log(`\n== teacher-chat web walk result: ${summary} passed ==`);
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}
