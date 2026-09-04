export async function run(cdp) {
  const clicked = await cdp.evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const btn = [...dlg.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '重新选题');
    if (!btn) return 'no-btn';
    btn.click(); return 'clicked';
  })()`);
  console.log('restart click:', clicked);
  await cdp.sleep(2000);
  const st = await cdp.evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const t = dlg ? dlg.innerText : '';
    return { backToPick: t.includes('① 选择章节'), hasStart: t.includes('开始测评') };
  })()`);
  console.log('back to pick:', st.backToPick, '| start btn:', st.hasStart);
  await cdp.screenshot('ui-shots/c-06-back-to-pick.png');
}
