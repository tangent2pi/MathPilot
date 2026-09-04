export async function run(cdp) {
  // continue from previous state: dialog open at answer view, first question fill_blank C=?
  // fill blank answer 80 (A=30,B=70 -> C=80)
  const sub = await cdp.evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const inp = dlg.querySelector('input[aria-label="答案输入"]');
    if (!inp) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, '80');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return 'filled';
  })()`);
  console.log('fill:', sub);
  await cdp.sleep(600);
  const clicked = await cdp.evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const btn = [...dlg.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '提交答案' && !b.disabled);
    if (!btn) return 'no-submit';
    btn.click(); return 'submitted';
  })()`);
  console.log('submit:', clicked);
  await cdp.sleep(4000);
  const after = await cdp.evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const t = dlg ? dlg.innerText : '';
    return { head: t.slice(0, 320), hasRestart: t.includes('重新选题') };
  })()`);
  console.log('after submit:', JSON.stringify(after.head));
  console.log('hasRestart:', after.hasRestart);
  await cdp.screenshot('ui-shots/c-06-answered.png');
}
