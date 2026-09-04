// walk-answer-1.mjs — dump answer input controls inside self-test dialog, answer Q1 (C=80)
export async function run(cdp) {
  await cdp.send('Page.navigate', { url: 'http://localhost:8081/' });
  await cdp.sleep(4000);

  // open self-test dialog (should show in-progress run 第1/10)
  await cdp.evaluate(`(() => {
    const btns = [...document.querySelectorAll('button')].filter(b => b.getAttribute('aria-label') === '自我测评' || (b.innerText||'').trim() === '自我测评');
    if (btns.length) btns[btns.length - 1].click();
  })()`);
  await cdp.sleep(1500);

  const ctl = await cdp.evaluate(`(() => {
    const out = { body: document.body.innerText.slice(0, 2000) };
    out.inputs = [...document.querySelectorAll('input, textarea')].map(i => ({
      tag: i.tagName, type: i.type, placeholder: i.placeholder, aria: i.getAttribute('aria-label'),
      visible: !!(i.offsetWidth || i.offsetHeight),
    }));
    out.radios = [...document.querySelectorAll('input[type="radio"], [role="radio"]')].length;
    return out;
  })()`);
  console.log('--- dialog body ---');
  console.log(ctl.body);
  console.log('--- inputs ---');
  ctl.inputs.forEach(i => console.log(JSON.stringify(i)));
  await cdp.screenshot('ui-shots/07-q1-controls.png');
}
