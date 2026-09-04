// walk-finish.mjs — click 提前结束并出报告, verify report appears in thread messages
export async function run(cdp) {
  await cdp.send('Page.navigate', { url: 'http://localhost:8081/' });
  await cdp.sleep(4000);
  await cdp.evaluate(`(() => {
    const btns = [...document.querySelectorAll('button')].filter(b => b.getAttribute('aria-label') === '自我测评' || (b.innerText||'').trim() === '自我测评');
    if (btns.length) btns[btns.length - 1].click();
  })()`);
  await cdp.sleep(1500);

  const finish = await cdp.evaluate(`(() => {
    const els = [...document.querySelectorAll('button')];
    const el = els.find(e => (e.innerText||'').trim().includes('提前结束并出报告'));
    if (!el) return 'finish btn not found';
    el.click();
    return 'clicked finish';
  })()`);
  console.log('finish:', finish);
  await cdp.sleep(7000);

  const st = await cdp.evaluate(`(() => {
    const body = document.body.innerText;
    // find region after the dialog closes — look for 报告 markers
    return {
      hasReportWord: body.includes('报告'),
      hasFinished: body.includes('已结束') || body.includes('测评完成'),
      bodyTail: body.slice(-3000),
      dialogsOpen: [...document.querySelectorAll('[role="dialog"]')].filter(d => d.offsetParent !== null).length,
    };
  })()`);
  console.log('has 报告:', st.hasReportWord, '| finished flag:', st.hasFinished, '| open dialogs:', st.dialogsOpen);
  console.log('--- body tail ---');
  console.log(st.bodyTail);
  await cdp.screenshot('ui-shots/09-after-finish.png');
}
