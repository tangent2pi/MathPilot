// walk-login.mjs — click 登录, dump form, fill student creds, submit, verify chat page
const EMAIL = 'student@mathpilot.local';
const PASSWORD = 'MathPilotStudent123!';

async function clickByText(cdp, text, tag = 'button') {
  const ok = await cdp.evaluate(`(() => {
    const els = [...document.querySelectorAll('${tag}')];
    const el = els.find(e => (e.innerText || '').trim().includes(${JSON.stringify(text)}));
    if (!el) return false;
    el.click();
    return true;
  })()`);
  return ok;
}

export async function run(cdp) {
  // already on home page from probe? navigate fresh anyway
  await cdp.send('Page.navigate', { url: 'http://localhost:8081/' });
  await cdp.sleep(5000);

  console.log('== step: click 登录 ==');
  console.log('clicked 登录:', await clickByText(cdp, '登录'));

  await cdp.sleep(1500);
  const form = await cdp.evaluate(`(() => {
    const out = { inputs: [], buttons: [], body: document.body.innerText.slice(0, 800) };
    document.querySelectorAll('input').forEach(el => {
      out.inputs.push({ type: el.type, name: el.name, placeholder: el.placeholder, aria: el.getAttribute('aria-label') });
    });
    document.querySelectorAll('button').forEach(el => {
      out.buttons.push({ text: (el.innerText || '').trim().slice(0, 40), aria: el.getAttribute('aria-label') });
    });
    return out;
  })()`);
  console.log('--- dialog body ---');
  console.log(form.body);
  console.log('--- inputs ---');
  form.inputs.forEach(i => console.log(JSON.stringify(i)));
  console.log('--- buttons ---');
  form.buttons.forEach(b => console.log(JSON.stringify(b)));
  await cdp.screenshot('ui-shots/03-login-dialog.png');
}
