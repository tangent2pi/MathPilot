// walk-login-submit.mjs — fill student creds, submit, verify authenticated state
const EMAIL = 'student@mathpilot.local';
const PASSWORD = 'MathPilotStudent123!';

export async function run(cdp) {
  await cdp.send('Page.navigate', { url: 'http://localhost:8081/' });
  await cdp.sleep(4000);

  // open login dialog
  const opened = await cdp.evaluate(`(() => {
    const els = [...document.querySelectorAll('button')];
    const el = els.find(e => (e.innerText || '').trim() === '登录');
    if (!el) return false;
    el.click();
    return true;
  })()`);
  console.log('open login dialog:', opened);
  await cdp.sleep(1200);

  // fill email + password by placeholder
  const filled = await cdp.evaluate(`(() => {
    const setVal = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const email = [...document.querySelectorAll('input')].find(i => (i.placeholder || '').includes('邮箱'));
    const pass = [...document.querySelectorAll('input')].find(i => (i.placeholder || '').includes('密码'));
    if (!email || !pass) return 'inputs not found';
    setVal(email, ${JSON.stringify(EMAIL)});
    setVal(pass, ${JSON.stringify(PASSWORD)});
    return 'filled:' + email.value.length + '/' + pass.value.length;
  })()`);
  console.log('fill result:', filled);
  await cdp.sleep(500);

  // click the submit 登录 inside dialog (the one inside form / modal, not header)
  const clicked = await cdp.evaluate(`(() => {
    const forms = [...document.querySelectorAll('form')];
    if (forms.length) {
      const btn = [...forms[forms.length - 1].querySelectorAll('button')].find(b => (b.innerText || '').trim() === '登录');
      if (btn) { btn.click(); return 'form-submit'; }
    }
    const btns = [...document.querySelectorAll('button')];
    const el = btns.find(e => (e.innerText || '').trim() === '登录' && e.type !== 'button') || btns.find(e => (e.innerText || '').trim() === '登录');
    if (el) { el.click(); return 'clicked:' + el.type; }
    return 'no submit btn';
  })()`);
  console.log('submit:', clicked);
  await cdp.sleep(6000);

  const state = await cdp.evaluate(`(() => ({
    url: location.href,
    body: document.body.innerText.slice(0, 900),
    hasChat: !!document.querySelector('[data-radix-scroll-area-viewport], main, [class*="thread"]'),
  }))()`);
  console.log('URL:', state.url);
  console.log('--- body ---');
  console.log(state.body);
  await cdp.screenshot('ui-shots/04-after-login.png');
}
