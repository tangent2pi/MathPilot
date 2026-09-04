// walk-c-01 — open 5174, login if needed, dump home state
// Reproduce: click "新对话" after being inside a conversation thread.
const EMAIL = 'student@mathpilot.local';
const PASSWORD = 'MathPilotStudent123!';

export async function run(cdp) {
  await cdp.send('Page.navigate', { url: 'http://localhost:5174/' });
  await cdp.sleep(6000);

  const dump = async (label) => {
    const s = await cdp.evaluate(`(() => {
      const body = document.body.innerText;
      const welcome = body.includes('今天想从哪道数学问题开始');
      const btns = [...document.querySelectorAll('button')]
        .filter(e => e.getBoundingClientRect().width > 0)
        .map(e => (e.innerText||'').trim().slice(0,30))
        .filter(Boolean).slice(0, 25);
      const inputs = [...document.querySelectorAll('input')].map(i => ({ph:i.placeholder, aria:i.getAttribute('aria-label')})).slice(0,6);
      const threads = [...document.querySelectorAll('button')].filter(e => (e.innerText||'').trim() && /^\\/c\\//.test('')===false).length;
      return { url: location.href, welcome, bodyHead: body.slice(0, 700), btns, inputs };
    })()`);
    console.log(`--- ${label} ---`);
    console.log('URL:', s.url, '| welcome-page:', s.welcome);
    console.log('buttons:', JSON.stringify(s.btns));
    console.log('inputs:', JSON.stringify(s.inputs));
    console.log('body head:', s.bodyHead.replace(/\n+/g, ' | '));
    return s;
  };

  let st = await dump('after load');

  // If login required (no sidebar buttons / shows 登录), do the form
  const needLogin = st.btns.some(t => t.includes('登录')) || st.bodyHead.includes('登录');
  if (needLogin) {
    await cdp.evaluate(`(() => {
      const el = [...document.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '登录');
      if (el) { el.click(); return true; }
      return false;
    })()`);
    await cdp.sleep(2000);
    const ready = await cdp.evaluate(`(async () => {
      for (let i = 0; i < 30; i++) {
        const e = [...document.querySelectorAll('input')].find(x => (x.placeholder||'').includes('邮箱'));
        if (e) return true;
        await new Promise(r => setTimeout(r, 200));
      }
      return false;
    })()`);
    console.log('login form ready:', ready);
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
      setVal(e, '${EMAIL}');
      setVal(p, '${PASSWORD}');
    })()`);
    await cdp.sleep(600);
    const submitted = await cdp.evaluate(`(() => {
      const dlg = document.querySelector('[role="dialog"]');
      const btn = dlg ? [...dlg.querySelectorAll('button')].filter(b => (b.innerText||'').trim() === '登录').pop() : null;
      if (btn) { btn.click(); return 'dialog'; }
      const forms = [...document.querySelectorAll('form')];
      const fb = forms.length && [...forms[forms.length-1].querySelectorAll('button')].find(b => (b.innerText||'').trim() === '登录');
      if (fb) { fb.click(); return 'form'; }
      return 'none';
    })()`);
    console.log('login submitted via:', submitted);
    await cdp.sleep(7000);
    st = await dump('after login');
  }

  await cdp.screenshot('ui-shots/c-01-home.png');
}
