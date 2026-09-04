// walk-answer-1-submit.mjs — answer Q1: 80°, submit, observe feedback
export async function run(cdp) {
  await cdp.send('Page.navigate', { url: 'http://localhost:8081/' });
  await cdp.sleep(4000);
  await cdp.evaluate(`(() => {
    const btns = [...document.querySelectorAll('button')].filter(b => b.getAttribute('aria-label') === '自我测评' || (b.innerText||'').trim() === '自我测评');
    if (btns.length) btns[btns.length - 1].click();
  })()`);
  await cdp.sleep(1500);

  // fill answer input
  const filled = await cdp.evaluate(`(() => {
    const inp = document.querySelector('input[aria-label="答案输入"]') || [...document.querySelectorAll('input')].find(i => (i.placeholder||'').includes('输入答案'));
    if (!inp) return 'answer input not found';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, '80°');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return 'filled: ' + inp.value;
  })()`);
  console.log('fill answer:', filled);
  await cdp.sleep(300);

  // click 提交答案
  const sub = await cdp.evaluate(`(() => {
    const els = [...document.querySelectorAll('button')];
    const el = els.find(e => (e.innerText||'').trim().includes('提交答案'));
    if (!el) return 'submit btn not found';
    el.click();
    return 'clicked submit';
  })()`);
  console.log('submit:', sub);
  await cdp.sleep(5000);

  const st = await cdp.evaluate(`(() => ({ body: document.body.innerText.slice(0, 2200) }))()`);
  console.log('--- body after submit ---');
  console.log(st.body);
  await cdp.screenshot('ui-shots/08-after-q1-submit.png');
}
