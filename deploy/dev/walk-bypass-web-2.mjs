// walk-bypass-web-2.mjs — login then test new thread + try direct api
export async function run(cdp) {
  await cdp.send('Page.navigate', { url: 'http://localhost:8081/' });
  await cdp.sleep(4000);
  await cdp.evaluate(`(() => {
    const el = [...document.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '登录');
    if (el) el.click();
  })()`);
  await cdp.sleep(2500);
  await cdp.evaluate(`(() => {
    const setVal = (el, v) => {
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const e = [...document.querySelectorAll('input')].find(i => (i.placeholder||'').includes('邮箱'));
    const p = [...document.querySelectorAll('input')].find(i => (i.placeholder||'').includes('密码'));
    setVal(e, 'student@mathpilot.local');
    setVal(p, 'MathPilotStudent123!');
  })()`);
  await cdp.sleep(500);
  await cdp.evaluate(`(() => {
    const forms = [...document.querySelectorAll('form')];
    const btn = forms.length && [...forms[forms.length-1].querySelectorAll('button')].find(b => (b.innerText||'').trim() === '登录');
    if (btn) btn.click();
  })()`);
  await cdp.sleep(7000);

  // test the actual latest thread
  const r1 = await cdp.evaluate(`(async () => {
    const r = await fetch('/api/learning/threads/thr_6f33dee967873a08ad7451b1/messages', { credentials: 'include' });
    return { status: r.status, body: (await r.text()).slice(0, 1500) };
  })()`);
  console.log('messages for thr_6f33dee...:', r1);

  // Also try the historical one
  const r2 = await cdp.evaluate(`(async () => {
    const r = await fetch('/api/learning/threads/thr_efb0b1608f85fc87182519c5/messages', { credentials: 'include' });
    return { status: r.status, body: (await r.text()).slice(0, 800) };
  })()`);
  console.log('messages for thr_efb0b1608...:', r2);

  // navigate to /c/thr_6f33dee... and check rendering
  await cdp.send('Page.navigate', { url: 'http://localhost:8081/c/thr_6f33dee967873a08ad7451b1' });
  await cdp.sleep(5500);

  const state = await cdp.evaluate(`(() => {
    const body = document.body.innerText;
    const main = document.querySelector('main, [data-radix-scroll-area-viewport]');
    return {
      url: location.href,
      hasReport: body.includes('自我测评报告'),
      mainTail: (main ? main.innerText : body).slice(-1500),
    };
  })()`);
  console.log('--- after navigate to /c/thr_6f33dee... ---');
  console.log('URL:', state.url, '| has 报告:', state.hasReport);
  console.log('main tail:', state.mainTail);
  await cdp.screenshot('ui-shots/14-new-thread.png');
}