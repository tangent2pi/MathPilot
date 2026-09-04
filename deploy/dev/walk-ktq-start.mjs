// walk-ktq-start.mjs — P0-2 E2E：建教师会话 → 创建 KTQ-start 命令 → 轮询器派发 → 指令进入 Pi 会话
import { readFileSync } from 'node:fs';

const ENV = Object.fromEntries(
  readFileSync('.env', 'utf8').split(/\r?\n/)
    .filter((line) => line && !line.trimStart().startsWith('#'))
    .map((line) => {
      const i = line.indexOf('=');
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }),
);

export async function run(cdp) {
  await cdp.send('Page.navigate', { url: 'http://localhost:8081/' });
  await cdp.sleep(6000);
  const st = await cdp.evaluate(`(() => ({ body: document.body.innerText.slice(0, 300), btns: [...document.querySelectorAll('button')].map(b => (b.innerText || '').trim()).filter(Boolean).slice(0, 8) }))()`);
  if (st.btns.some((t) => t.includes('登录')) || st.body.includes('登录')) {
    await cdp.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.innerText||'').trim()==='登录'); if (b) b.click(); })()`);
    await cdp.sleep(2500);
    await cdp.evaluate(`(() => {
      const setVal = (el, v) => { const p = el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); };
      setVal([...document.querySelectorAll('input')].find(i => (i.placeholder||'').includes('邮箱')), ${JSON.stringify(ENV.BETTER_AUTH_TEACHER_EMAIL)});
      setVal([...document.querySelectorAll('input')].find(i => (i.placeholder||'').includes('密码')), ${JSON.stringify(ENV.BETTER_AUTH_TEACHER_PASSWORD)});
    })()`);
    await cdp.sleep(400);
    await cdp.evaluate(`(() => { const d = document.querySelector('[role="dialog"]'); const b = d ? [...d.querySelectorAll('button')].filter(x => (x.innerText||'').trim()==='登录').pop() : null; if (b) b.click(); })()`);
    await cdp.sleep(6000);
  }
  const me = await cdp.evaluate(`fetch('/api/me',{credentials:'include'}).then(r=>r.status)`);
  console.log('logged in:', me);
  if (me !== 200) { process.exitCode = 1; return; }

  const out = await cdp.evaluate(`(async () => {
    const create = await fetch('/api/content/teacher-chat/threads', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include', body: '{}' });
    const thread = await create.json();
    const threadId = thread.thread_id;

    const start = await fetch('/api/content/teacher-chat/threads/' + encodeURIComponent(threadId) + '/ktq-start', {
      method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ chapter_id: 'chap_sanjiaoxing' }),
    });
    const startBody = await start.json();
    if (start.status !== 201) return { ok: false, stage: 'ktq-start-command', status: start.status, body: startBody };

    const deadline = Date.now() + 180000;
    let transcript = [];
    while (Date.now() < deadline) {
      const res = await fetch('/api/content/teacher-chat/threads/' + encodeURIComponent(threadId), { credentials: 'include' });
      const view = await res.json();
      transcript = view.messages || [];
      const joined = transcript.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join(String.fromCharCode(10));
      if (joined.includes('MathPilot KTQ start')) {
        const lastAssistant = [...transcript].reverse().find(m => m.role === 'assistant');
        const tail = lastAssistant && Array.isArray(lastAssistant.content) ? lastAssistant.content.map(p => p.type === 'text' ? p.text : '').join('').slice(0, 200) : '';
        return { ok: true, thread_id: threadId, command: startBody, messages: transcript.length, assistant_tail: tail };
      }
      await new Promise(r => setTimeout(r, 4000));
    }
    return { ok: false, stage: 'timeout', thread_id: threadId, command: startBody, messages: transcript.length };
  })()`);

  console.log('KTQ-start E2E:', JSON.stringify(out, null, 2));
  if (!out.ok) process.exitCode = 1;
}
