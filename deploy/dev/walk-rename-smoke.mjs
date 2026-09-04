// walk-rename-smoke.mjs — 重命名链路冒烟：批次(候选集) display_name + 练习包 title
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

const KTQ_ID = 'cset_64082b65e8e84a2895ff';
const PKG_ID = 'pkg_74ae361f188240d4967e';

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
  if (me !== 200) {
    const dbg = await cdp.evaluate(`(() => ({ body: document.body.innerText.slice(0, 400), dialogs: [...document.querySelectorAll('[role="dialog"]')].map(d => d.innerText.slice(0, 200)) }))()`);
    check('登录诊断', false, JSON.stringify(dbg).slice(0, 300));
  }

  const api = await cdp.evaluate(`(async () => {
    const patch = (url, body) => fetch(url, { method: 'PATCH', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const ktqRename = await patch('/api/content/candidates/${KTQ_ID}/display-name', { display_name: '《解三角形》第一轮抽取' });
    const libAfterKtq = await fetch('/api/content/teacher/library', { credentials: 'include' });
    const libBodyAfterKtq = libAfterKtq.ok ? await libAfterKtq.json() : null;
    const ktqRow = libBodyAfterKtq && libBodyAfterKtq.candidates.find(c => c.candidate_set_id === '${KTQ_ID}');
    const pkgRename = await patch('/api/content/packages/${PKG_ID}', { title: '解三角形·随堂练习 A 卷' });
    const libAfterPkg = await fetch('/api/content/teacher/library', { credentials: 'include' });
    const libBodyAfterPkg = libAfterPkg.ok ? await libAfterPkg.json() : null;
    const pkgRow = libBodyAfterPkg && libBodyAfterPkg.packages.find(p => p.package_id === '${PKG_ID}');
    const ktqReset = await patch('/api/content/candidates/${KTQ_ID}/display-name', { display_name: '' });
    const pkgEmpty = await patch('/api/content/packages/${PKG_ID}', { title: '' });
    const noKtq = await patch('/api/content/candidates/cset_nope/display-name', { display_name: 'x' });
    const libAfterReset = await fetch('/api/content/teacher/library', { credentials: 'include' });
    const libBodyAfterReset = libAfterReset.ok ? await libAfterReset.json() : null;
    const ktqCleared = libBodyAfterReset && libBodyAfterReset.candidates.find(c => c.candidate_set_id === '${KTQ_ID}');
    return {
      ktqStatus: ktqRename.status, ktqName: ktqRow && ktqRow.display_name,
      pkgStatus: pkgRename.status, pkgTitle: pkgRow && pkgRow.title,
      clearKtqStatus: ktqReset.status, ktqCleared: ktqCleared && ktqCleared.display_name,
      emptyPkgStatus: pkgEmpty.status, noKtqStatus: noKtq.status,
    };
  })()`);
  check('批次改名 200', api.ktqStatus === 200, String(api.ktqStatus));
  check('批次名已写入并回读', api.ktqName === '《解三角形》第一轮抽取', String(api.ktqName));
  check('练习包改名 200', api.pkgStatus === 200, String(api.pkgStatus));
  check('包标题已写入并回读', api.pkgTitle === '解三角形·随堂练习 A 卷', String(api.pkgTitle));
  check('空批次名=恢复默认 200', api.clearKtqStatus === 200 && api.ktqCleared == null, `${api.clearKtqStatus}/${String(api.ktqCleared)}`);
  check('空包标题被拒 422', api.emptyPkgStatus === 422, String(api.emptyPkgStatus));
  check('不存在批次改名 404', api.noKtqStatus === 404, String(api.noKtqStatus));

  // 改回原名，避免污染库内数据
  const restore = await cdp.evaluate(`(async () => {
    const r1 = await fetch('/api/content/candidates/${KTQ_ID}/display-name', { method: 'PATCH', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ display_name: null }) });
    const r2 = await fetch('/api/content/packages/${PKG_ID}', { method: 'PATCH', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'MathPilot 内容包 3' }) });
    return r1.status + '/' + r2.status;
  })()`);
  check('数据还原', restore === '200/200', restore);

  const passed = results.filter((r) => r.ok).length + '/' + results.length;
  console.log(`\n== rename smoke: ${passed} passed ==`);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}
