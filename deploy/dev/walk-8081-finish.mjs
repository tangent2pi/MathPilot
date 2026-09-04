// 8081: 收尾当前续测轮（点「提前结束并出报告」→ 报告视图 → 完成）
export async function run(cdp) {
  const st0 = await cdp.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return { hasDialog: false };
    const t = d.innerText;
    return { hasDialog: true, inAnswer: t.includes('提交答案'), hasFinishBtn: t.includes('提前结束并出报告') };
  })()`);
  console.log('dialog state:', JSON.stringify(st0));
  if (!st0.hasDialog) return;

  const fin = await cdp.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const btn = [...d.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '提前结束并出报告' && !b.disabled);
    if (!btn) return 'no-finish';
    btn.click(); return 'clicked';
  })()`);
  console.log('finish click:', fin);
  await cdp.sleep(4500);
  const st1 = await cdp.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const t = d ? d.innerText : '';
    return { inReport: t.includes('自我测评报告'), hasDone: t.includes('完成'), head: t.slice(0, 260) };
  })()`);
  console.log('report:', JSON.stringify(st1));
  await cdp.screenshot('ui-shots/8081-3-report.png');

  if (st1.inReport && st1.hasDone) {
    const done = await cdp.evaluate(`(() => {
      const d = document.querySelector('[role="dialog"]');
      const btn = [...d.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '完成');
      if (!btn) return 'no';
      btn.click(); return 'ok';
    })()`);
    console.log('done click:', done);
    await cdp.sleep(2000);
    const st2 = await cdp.evaluate(`(() => {
      const d = document.querySelector('[role="dialog"]');
      return { dialogClosed: !d, msgHasReport: document.body.innerText.includes('自我测评报告') };
    })()`);
    console.log('after done:', JSON.stringify(st2));
    await cdp.screenshot('ui-shots/8081-4-closed.png');
  }
}
