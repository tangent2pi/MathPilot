// walk-dialog.mjs — click 自我测评 near input, dump dialog structure
export async function run(cdp) {
  await cdp.send('Page.navigate', { url: 'http://localhost:8081/' });
  await cdp.sleep(4500);

  // The input-area 自我测评 button (last one in body text flow / near send). Click the one with aria-label 自我测评 that is nearest the textarea (bottom). Try last matching button.
  const clicked = await cdp.evaluate(`(() => {
    const btns = [...document.querySelectorAll('button[aria-label="自我测评"], button')].filter(b => (b.getAttribute('aria-label') === '自我测评' || (b.innerText||'').trim() === '自我测评'));
    if (!btns.length) return 'no self-test button';
    const el = btns[btns.length - 1];
    el.click();
    return 'clicked #' + (btns.length - 1);
  })()`);
  console.log('click self-test:', clicked);
  await cdp.sleep(2000);

  const state = await cdp.evaluate(`(() => {
    const out = { body: document.body.innerText.slice(0, 2500) };
    out.dialogs = [...document.querySelectorAll('[role="dialog"], [data-state="open"], [class*="Dialog"], [class*="dialog"]')].length;
    return out;
  })()`);
  console.log('dialog count:', state.dialogs);
  console.log('--- body ---');
  console.log(state.body);
  await cdp.screenshot('ui-shots/05-self-test-dialog.png');
}
