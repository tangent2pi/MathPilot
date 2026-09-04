// walk-teacher-attach.mjs — P0-1 E2E：教师上传图片附件并随消息发送，验证绑定进工作区且模型可回复
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
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

export async function run(cdp) {
  await cdp.send('Page.navigate', { url: 'http://localhost:8081/' });
  await cdp.sleep(6000);

  const st = await cdp.evaluate(`(() => ({
    body: document.body.innerText.slice(0, 400),
    btns: [...document.querySelectorAll('button')].filter(e => e.getBoundingClientRect().width > 0).map(b => (b.innerText || '').trim()).filter(Boolean).slice(0, 10),
  }))()`);
  const needLogin = st.btns.some((t) => t.includes('登录')) || st.body.includes('登录');
  if (needLogin) {
    await cdp.evaluate(`(() => {
      const el = [...document.querySelectorAll('button')].find(b => (b.innerText || '').trim() === '登录');
      if (el) { el.click(); return true; } return false;
    })()`);
    await cdp.sleep(2500);
    await cdp.evaluate(`(() => {
      const setVal = (el, v) => {
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const e = [...document.querySelectorAll('input')].find(i => (i.placeholder || '').includes('邮箱'));
      const p = [...document.querySelectorAll('input')].find(i => (i.placeholder || '').includes('密码'));
      setVal(e, ${JSON.stringify(EMAIL)});
      setVal(p, ${JSON.stringify(PASSWORD)});
    })()`);
    await cdp.sleep(400);
    await cdp.evaluate(`(() => {
      const dlg = document.querySelector('[role="dialog"]');
      const btn = dlg ? [...dlg.querySelectorAll('button')].filter(b => (b.innerText || '').trim() === '登录').pop() : null;
      if (btn) btn.click();
    })()`);
    await cdp.sleep(6000);
  }
  const logged = await cdp.evaluate(`fetch('/api/me', { credentials: 'include' }).then(r => r.status)`);
  console.log('logged in (me status):', logged);
  if (logged !== 200) { process.exitCode = 1; return; }

  const result = await cdp.evaluate(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(PNG_1PX)}), c => c.charCodeAt(0));
    const name = 'e2e-triangle-notes.png';
    const mime = 'image/png';
    const shaHex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    const digest = shaHex(await crypto.subtle.digest('SHA-256', bytes));

    const init = await fetch('/api/storage/objects/init', {
      method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ purpose: 'thread', mime_type: mime, byte_size: bytes.byteLength, original_name: name }),
    });
    if (!init.ok) return { ok: false, stage: 'init', error: init.status };
    const meta = await init.json();
    const put = await fetch(meta.upload_url, { method: 'PUT', headers: { 'content-type': mime }, body: bytes });
    if (!put.ok) return { ok: false, stage: 'put', error: put.status };
    const complete = await fetch('/api/storage/objects/' + encodeURIComponent(meta.object_id) + '/complete', {
      method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ sha256: digest }),
    });
    if (!complete.ok) return { ok: false, stage: 'complete', error: complete.status };
    await complete.json();

    const create = await fetch('/api/content/teacher-chat/threads', {
      method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include', body: '{}',
    });
    if (!create.ok) return { ok: false, stage: 'create-thread', error: create.status };
    const thread = await create.json();

    const content = '请先读取随消息附带的图片文件，然后用一两句话告诉我它是什么、能确认已读到即可。';
    const sendRes = await fetch('/api/content/teacher-chat/threads/' + encodeURIComponent(thread.thread_id) + '/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ content, attachments: [{ attachment_ref: 'storage-object:' + meta.object_id, name, mime_type: mime }] }),
    });
    const sendText = await sendRes.text();
    if (!sendRes.ok) return { ok: false, stage: 'send-message', error: sendRes.status, text: sendText.slice(0, 400) };
    const body = JSON.parse(sendText);
    const last = (body.messages || []).filter(m => m.role === 'assistant').pop();
    const tail = last && Array.isArray(last.content)
      ? last.content.map(p => p.type === 'text' ? p.text : '').join('').slice(0, 240)
      : String((body.messages || []).length);
    return { ok: true, object_id: meta.object_id, thread_id: thread.thread_id, message_count: (body.messages || []).length, tail };
  })()`);

  console.log('E2E result:', JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
