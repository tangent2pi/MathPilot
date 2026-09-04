// walk-manual-shot.mjs — 资料库页截图
export async function run(cdp) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
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
  await cdp.screenshot('ui-shots/teacher-library-rename-create.png');
  await cdp.evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').includes('自选题新建')); if(b)b.click(); })()`);
  await cdp.sleep(4000);
  await cdp.screenshot('ui-shots/teacher-library-manual-dialog.png');
}
