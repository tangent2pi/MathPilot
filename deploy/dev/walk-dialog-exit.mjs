export async function run(cdp) {
  await cdp.send('Page.navigate', { url: 'http://localhost:5174/' });
  await cdp.sleep(5000);
  // open self-test dialog
  await cdp.evaluate(`(() => {
    const el = document.querySelector('button[aria-label="自我测评"]');
    if (!el) return false;
    el.click(); return true;
  })()`);
  await cdp.sleep(2500);
  const pick = await cdp.evaluate(`(() => {
    const body = document.body.innerText;
    const dlg = document.querySelector('[role="dialog"]');
    return {
      hasPick: (dlg ? dlg.innerText : '').includes('选择章节'),
      hasStart: (dlg ? dlg.innerText : '').includes('开始测评'),
      dlgHead: dlg ? dlg.innerText.slice(0, 300) : null,
    };
  })()`);
  console.log('dialog pick:', JSON.stringify(pick));
  await cdp.screenshot('ui-shots/c-06-pick.png');

  // start the run (default selection)
  const started = await cdp.evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const btn = [...dlg.querySelectorAll('button')].find(b => (b.innerText||'').includes('开始测评'));
    if (!btn) return 'no-start-btn';
    if (btn.disabled) return 'start-disabled';
    btn.click(); return 'clicked';
  })()`);
  console.log('start:', started);
  await cdp.sleep(4000);
  const ans = await cdp.evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const t = dlg ? dlg.innerText : '';
    return {
      url: location.href,
      hasRestart: t.includes('重新选题'),
      hasFinish: t.includes('提前结束'),
      hasQuestion: t.includes('第') && t.includes('题'),
      qHead: t.slice(0, 260),
    };
  })()`);
  console.log('answer view:', JSON.stringify(ans));
  await cdp.screenshot('ui-shots/c-06-answer-restart.png');
}
