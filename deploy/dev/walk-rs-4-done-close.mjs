// 回归 R4：report → 「完成」→ Dialog 关闭；thread 消息流应含报告
export async function run(cdp) {
  const done = await cdp.evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return 'no-dialog';
    const btn = [...dlg.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '完成');
    if (!btn) return 'no-done-btn';
    btn.click(); return 'clicked';
  })()`);
  console.log('done click:', done);
  await cdp.sleep(2500);
  const closed = await cdp.evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const body = document.body.innerText;
    return {
      dialogClosed: !dlg,
      url: location.href,
      msgHasReport: body.includes('自我测评报告') || body.includes('BKT'),
      bodyHead: body.slice(0, 300),
    };
  })()`);
  console.log('after done:', JSON.stringify(closed));
  await cdp.screenshot('ui-shots/rs-6-done-closed.png');
}
