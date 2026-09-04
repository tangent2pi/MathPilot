// walk-bypass-web.mjs — login then fetch messages via api:3101 absolute URL (skip web nginx)
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

  // try via web 8081 (relative)
  const r1 = await cdp.evaluate(`(async () => {
    const r = await fetch('/api/learning/threads/thr_efb0b1608f85fc87182519c5/messages', { credentials: 'include' });
    return { url: '/api/...', status: r.status, body: (await r.text()).slice(0, 400) };
  })()`);
  console.log('via web8081 /api:', r1);

  // try direct api:3101 — needs withCredentials cross-origin, may be blocked by CORS
  const r2 = await cdp.evaluate(`(async () => {
    try {
      const r = await fetch('http://localhost:3101/api/learning/threads/thr_efb0b1608f85fc87182519c5/messages', { credentials: 'include' });
      return { url: 'api:3101', status: r.status, body: (await r.text()).slice(0, 400) };
    } catch (e) { return { url: 'api:3101', error: String(e) }; }
  })()`);
  console.log('via api:3101:', r2);

  // try web→api proxy with explicit credentials
  const r3 = await cdp.evaluate(`(async () => {
    const r = await fetch('http://localhost:8081/api/learning/threads', { credentials: 'include' });
    return { url: 'list via 8081', status: r.status, body: (await r.text()).slice(0, 600) };
  })()`);
  console.log('via 8081 /threads:', r3);
}