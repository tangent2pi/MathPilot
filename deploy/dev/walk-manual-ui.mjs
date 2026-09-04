// walk-manual-ui.mjs — 自选题新建练习包 UI 冒烟
export async function run(cdp) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const results = [];
  const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${extra ? ' | ' + extra : ''}`); };
  await cdp.send('Page.navigate', { url: 'http://localhost:8081/' });
  await cdp.sleep(6000);
  const st = await cdp.evaluate(`(() => ({ btns: [...document.querySelectorAll('button')].map(b => (b.innerText||'').trim()).filter(Boolean).slice(0,8) }))()`);
  if (st.btns.some(t => t.includes('登录'))) {
    await cdp.evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='登录'); if(b)b.click(); })()`);
    await cdp.sleep(2500);
    await cdp.evaluate(`(() => { const setVal=(el,v)=>{ if(!el)return; const p=window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true})); }; setVal([...document.querySelectorAll('input')].find(i=>(i.placeholder||'').includes('邮箱')),'teacher@mathpilot.local'); setVal([...document.querySelectorAll('input')].find(i=>(i.placeholder||'').includes('密码')),'MathPilotTeacher123!'); })()`);
    await cdp.sleep(400);
    await cdp.evaluate(`(() => { const d=document.querySelector('[role="dialog"]'); const b=d?[...d.querySelectorAll('button')].filter(x=>(x.innerText||'').trim()==='登录').pop():null; if(b)b.click(); })()`);
    await cdp.sleep(6000);
  }
  await cdp.send('Page.navigate', { url: 'http://localhost:8081/teacher/library' });
  await cdp.sleep(6000);
  const ui = await cdp.evaluate(`(() => ({
    hasCreateBtn: [...document.querySelectorAll('button')].some(b => (b.innerText||'').includes('自选题新建')),
    bodySample: document.body.innerText.slice(0, 600),
  }))()`);
  check('出现“自选题新建”按钮', ui.hasCreateBtn, '');

  await cdp.evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').includes('自选题新建')); if(b)b.click(); })()`);
  await cdp.sleep(3000);
  const dlg = await cdp.evaluate(`(() => {
    const d = [...document.querySelectorAll('[role="dialog"]')].find(x => x.innerText.includes('自选题新建练习包'));
    if (!d) return { open: false };
    const boxes = d.querySelectorAll('input[type="checkbox"]').length;
    const search = d.querySelector('input[aria-label="搜索题目"]');
    return { open: true, questionRows: boxes, hasSearch: !!search, namePlaceholder: !![...d.querySelectorAll('input')].find(i => (i.placeholder||'').includes('练习包名称')) };
  })()`);
  check('打开组卷弹窗并加载题目', dlg.open && dlg.questionRows > 0, JSON.stringify({ rows: dlg.questionRows, search: dlg.hasSearch }));
  check('弹窗含名称输入与搜索', dlg.hasSearch && dlg.namePlaceholder, '');

  const passed = results.filter(r => r.ok).length + '/' + results.length;
  console.log(`\n== manual ui: ${passed} passed ==`);
  if (results.some(r => !r.ok)) process.exitCode = 1;
}
