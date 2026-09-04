// walk-rename-ui.mjs — 资料库页面重命名按钮 UI 冒烟
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
    hasRenameBtns: [...document.querySelectorAll('button')].filter(b => (b.innerText||'').includes('重命名')).length,
    hasSection: document.body.innerText.includes('解析批次') && document.body.innerText.includes('练习包'),
    sample: document.body.innerText.slice(0, 500),
  }))()`);
  check('页面含解析批次/练习包区块', ui.hasSection);
  check('出现重命名按钮', ui.hasRenameBtns >= 2, `count=${ui.hasRenameBtns}`);

  // 点击第一个“重命名”，断言弹窗出现并可输入
  const dialog = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.innerText||'').trim()==='重命名');
    if (!b) return { clicked: false };
    b.click(); return { clicked: true };
  })()`);
  await cdp.sleep(1500);
  const dlg = await cdp.evaluate(`(() => {
    const d = [...document.querySelectorAll('[role="dialog"]')].find(x => x.innerText.includes('重命名'));
    if (!d) return { hasDialog: false };
    const inp = d.querySelector('input');
    return { hasDialog: true, hasInput: !!inp, placeholder: inp && inp.placeholder, title: (d.querySelector('h2')||{}).innerText || '' };
  })()`);
  check('点击后弹出重命名对话框', dialog.clicked && dlg.hasDialog && dlg.hasInput, JSON.stringify(dlg));
  await cdp.evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='取消'); if(b)b.click(); })()`);

  const passed = results.filter(r => r.ok).length + '/' + results.length;
  console.log(`\n== rename ui: ${passed} passed ==`);
  if (results.some(r => !r.ok)) process.exitCode = 1;
}
