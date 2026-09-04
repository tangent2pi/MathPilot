// walk-verify-after-login.mjs — login first, then fetch messages & check rendering
export async function run(cdp) {
  await cdp.send('Page.navigate', { url: 'http://localhost:8081/' });
  await cdp.sleep(4500);

  // login
  await cdp.evaluate(`(() => {
    const el = [...document.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '登录');
    if (el) el.click();
  })()`);
  await cdp.sleep(2500);
  // wait for inputs to appear (SPA dialog hydration)
  await cdp.evaluate(`(async () => {
    for (let i = 0; i < 30; i++) {
      const e = [...document.querySelectorAll('input')].find(x => (x.placeholder||'').includes('邮箱'));
      if (e) return 'inputs ready';
      await new Promise(r => setTimeout(r, 200));
    }
    return 'inputs timeout';
  })()`);
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
  // submit the login form
  await cdp.evaluate(`(() => {
    const forms = [...document.querySelectorAll('form')];
    const btn = forms.length && [...forms[forms.length-1].querySelectorAll('button')].find(b => (b.innerText||'').trim() === '登录');
    if (btn) { btn.click(); return 'form-submit'; }
    const dlg = document.querySelector('[role="dialog"]');
    const all = dlg ? [...dlg.querySelectorAll('button')].filter(b => (b.innerText||'').trim() === '登录') : [];
    if (all.length) { all[all.length-1].click(); return 'dialog-click'; }
    return 'no submit';
  })()`);
  await cdp.sleep(7000);

  // verify login state
  const authState = await cdp.evaluate(`(() => ({
    body: document.body.innerText.slice(0, 600),
    hasStudent: document.body.innerText.includes('Demo Student') || document.body.innerText.includes('学生'),
  }))()`);
  console.log('login state — hasStudent:', authState.hasStudent);
  console.log('body head:', authState.body);
  await cdp.sleep(500);
  await cdp.evaluate(`(() => {
    const forms = [...document.querySelectorAll('form')];
    const btn = forms.length && [...forms[forms.length-1].querySelectorAll('button')].find(b => (b.innerText||'').trim() === '登录');
    if (btn) btn.click();
  })()`);
  await cdp.sleep(6000);

  // After login, fetch messages
  const probe = await cdp.evaluate(`(async () => {
    const r = await fetch('/api/learning/threads/thr_efb0b1608f85fc87182519c5/messages', { credentials: 'include' });
    const status = r.status;
    const ct = r.headers.get('content-type') || '';
    let body = null;
    if (ct.includes('json')) body = await r.json(); else body = await r.text();
    return { status, ct, body: JSON.stringify(body).slice(0, 2000) };
  })()`);
  console.log('AUTH fetch /messages:');
  console.log('  status:', probe.status, 'ct:', probe.ct);
  console.log('  body:', probe.body);

  // navigate to thread route
  await cdp.send('Page.navigate', { url: 'http://localhost:8081/c/thr_efb0b1608f85fc87182519c5' });
  await cdp.sleep(5500);

  const state = await cdp.evaluate(`(() => {
    const body = document.body.innerText;
    const main = document.querySelector('main, [data-radix-scroll-area-viewport]');
    return {
      url: location.href,
      hasReport: body.includes('自我测评报告'),
      hasAccuracy: body.includes('准确率'),
      mainTail: (main ? main.innerText : body).slice(-1500),
    };
  })()`);
  console.log('--- after auth navigate to /c/thr_efb0 ---');
  console.log('URL:', state.url);
  console.log('has 报告:', state.hasReport, '| has 准确率:', state.hasAccuracy);
  console.log('main tail:', state.mainTail);
  await cdp.screenshot('ui-shots/13-auth-thread.png');
}