// walk-library-smoke.mjs — P0 收尾冒烟：资料库接口 + 解析状态 + 页面渲染
import { readFileSync } from 'node:fs';

const ENV = Object.fromEntries(
  readFileSync('.env', 'utf8').split(/\r?\n/)
    .filter((line) => line && !line.trimStart().startsWith('#'))
    .map((line) => {
      const i = line.indexOf('=');
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }),
);

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${extra ? ' | ' + extra : ''}`); };

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
  check('教师登录', me === 200, String(me));

  const api = await cdp.evaluate(`(async () => {
    const lib = await fetch('/api/content/teacher/library', { credentials: 'include' });
    const libBody = lib.ok ? await lib.json() : null;
    const parse = await fetch('/api/content/teacher-chat/threads/thr_409b3f88d0df4a3ca16c12ac37044034/parse', { credentials: 'include' });
    const parseBody = parse.ok ? await parse.json() : null;
    const del = await fetch('/api/content/packages/pkg_not_exists', { method: 'DELETE', credentials: 'include' });
    return {
      libStatus: lib.status, hasArrays: !!(libBody && Array.isArray(libBody.candidates) && Array.isArray(libBody.packages)),
      parseStatus: parse.status, parseStage: parseBody && parseBody.stage,
      deleteStatus: del.status,
    };
  })()`);
  check('资料库聚合接口 200 且含批次/包数组', api.libStatus === 200 && api.hasArrays, JSON.stringify({ s: api.libStatus, candidates: 'array' }));
  check('解析状态接口返回 stage', api.parseStatus === 200 && Boolean(api.parseStage), String(api.parseStage));
  check('删除不存在包返回 404', api.deleteStatus === 404, String(api.deleteStatus));

  await cdp.send('Page.navigate', { url: 'http://localhost:8081/teacher/library' });
  await cdp.sleep(5000);
  const ui = await cdp.evaluate(`(() => ({
    hasTitle: document.body.innerText.includes('我的资料库'),
    hasHint: document.body.innerText.includes('上传资料后自动解析'),
    bodyTail: document.body.innerText.slice(0, 500),
  }))()`);
  check('资料库页面渲染', ui.hasTitle && ui.hasHint, ui.hasTitle && ui.hasHint ? '' : ui.bodyTail.slice(0, 160));

  const passed = results.filter((r) => r.ok).length + '/' + results.length;
  console.log(`\n== library smoke: ${passed} passed ==`);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}
