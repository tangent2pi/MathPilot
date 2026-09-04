// walk-manual-smoke.mjs — 手动选题组卷链路冒烟
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
const CLASS_ID = 'cls_dc0906cf03ae4828bcdbb799a0e452f8';

export async function run(cdp) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: 'http://localhost:8081/' });
  await cdp.sleep(6000);
  const st = await cdp.evaluate(`(() => ({ body: document.body.innerText.slice(0, 300), btns: [...document.querySelectorAll('button')].map(b => (b.innerText || '').trim()).filter(Boolean).slice(0, 8) }))()`);
  if (st.btns.some((t) => t.includes('登录')) || st.body.includes('登录')) {
    await cdp.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.innerText||'').trim()==='登录'); if (b) b.click(); })()`);
    await cdp.sleep(2500);
    await cdp.evaluate(`(() => {
      const setVal = (el, v) => { if (!el) return; const p = el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); };
      setVal([...document.querySelectorAll('input')].find(i => (i.placeholder||'').includes('邮箱')), ${JSON.stringify(ENV.BETTER_AUTH_TEACHER_EMAIL)});
      setVal([...document.querySelectorAll('input')].find(i => (i.placeholder||'').includes('密码')), ${JSON.stringify(ENV.BETTER_AUTH_TEACHER_PASSWORD)});
    })()`);
    await cdp.sleep(400);
    await cdp.evaluate(`(() => { const d = document.querySelector('[role="dialog"]'); const b = d ? [...d.querySelectorAll('button')].filter(x => (x.innerText||'').trim()==='登录').pop() : null; if (b) b.click(); })()`);
    await cdp.sleep(6000);
  }
  const me = await cdp.evaluate(`fetch('/api/me',{credentials:'include'}).then(r=>r.status)`);
  check('教师登录', me === 200, String(me));

  const manual = await cdp.evaluate(`(async () => {
    const q = await fetch('/api/content/teacher/library/questions', { credentials: 'include' });
    const qBody = q.ok ? await q.json() : null;
    const list = (qBody && qBody.questions) || [];
    const firstTwo = list.slice(0, 2).map(x => x.revision_id);
    let created = null;
    if (firstTwo.length === 2) {
      const c = await fetch('/api/content/teacher/library/packages/manual', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '冒烟自选练习包-请删除', revision_ids: firstTwo }) });
      created = c.ok ? await c.json() : { status: c.status, text: (await c.text()).slice(0, 200) };
    }
    const lib = await fetch('/api/content/teacher/library', { credentials: 'include' });
    const libBody = lib.ok ? await lib.json() : null;
    const pkg = created && created.package_id ? (libBody.packages || []).find(p => p.package_id === created.package_id) : null;
    return { qStatus: q.status, qCount: list.length, created, pkg: pkg ? { id: pkg.package_id, title: pkg.title, status: pkg.status, items: pkg.item_count } : null };
  })()`);
  check('可选题目清单可读', manual.qStatus === 200 && manual.qCount >= 2, `count=${manual.qCount}`);
  check('手动建包 201', manual.created && manual.created.package_id, manual.created && manual.created.status ? JSON.stringify({ s: manual.created.status, detail: manual.created.text }) : String(JSON.stringify(manual.created).slice(0, 160)));
  check('新包出现在资料库（ready）', manual.pkg && manual.pkg.status === 'ready' && manual.pkg.items === 2, JSON.stringify(manual.pkg));

  let packageId = manual.created && manual.created.package_id;
  if (!packageId && manual.pkg) packageId = manual.pkg.id;

  // 发布到班级
  const pub = packageId ? await cdp.evaluate(`(async (id) => {
    const r = await fetch('/api/content/packages/' + encodeURIComponent(id) + '/releases', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ class_id: '${CLASS_ID}' }) });
    return r.status;
  })(${JSON.stringify(packageId)})`) : null;
  check('发布到班级 201', pub === 201, String(pub));

  // 撤回发布（包状态保持 published，属于不可删除语义）
  const withdraw = packageId ? await cdp.evaluate(`(async (id) => {
    const r = await fetch('/api/content/packages/' + encodeURIComponent(id) + '/releases/${CLASS_ID}', { method: 'DELETE', credentials: 'include' });
    return r.status;
  })(${JSON.stringify(packageId)})`) : null;
  check('撤回发布 200', withdraw === 200, String(withdraw));

  // 另一个未发布的 manual 包验证删除（guard 修正后允许删除 ready 教师包）
  const delResult = await cdp.evaluate(`(async () => {
    const q = await fetch('/api/content/teacher/library/questions', { credentials: 'include' });
    const list = (q.ok ? (await q.json()).questions : []) || [];
    if (list.length < 2) return { status: 'noop' };
    const c = await fetch('/api/content/teacher/library/packages/manual', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '冒烟待删除包', revision_ids: [list[0].revision_id, list[1].revision_id] }) });
    if (!c.ok) return { status: 'create_failed' };
    const created = await c.json();
    const d = await fetch('/api/content/packages/' + encodeURIComponent(created.package_id), { method: 'DELETE', credentials: 'include' });
    return { status: d.status };
  })()`);
  check('删除未发布 manual 包 200', delResult.status === 200, String(delResult.status));

  // 清理：删除冒烟自选包（已撤回但状态 published，需直接清理数据库层测试数据）
  const cleanup = packageId ? await cdp.evaluate(`(async (id) => {
    const r = await fetch('/api/content/packages/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'include' });
    return r.status;
  })(${JSON.stringify(packageId)})`) : null;
  check('（已发布包删除按语义 404 预期）', cleanup === 404, String(cleanup));

  const passed = results.filter((r) => r.ok).length + '/' + results.length;
  console.log(`\n== manual smoke: ${passed} passed ==`);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}
