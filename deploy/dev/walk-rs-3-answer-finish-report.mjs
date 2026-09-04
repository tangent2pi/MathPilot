// 回归 R3：正常答题(填 80°) → 判对 → 提前结束 → report 视图含「再来一轮/完成」
export async function run(cdp) {
  const fill = await cdp.evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const inp = dlg.querySelector('input[aria-label="答案输入"]');
    if (!inp) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, '80°');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return 'filled';
  })()`);
  console.log('fill:', fill);
  await cdp.sleep(500);
  const sub = await cdp.evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const btn = [...dlg.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '提交答案' && !b.disabled);
    if (!btn) return 'no-submit';
    btn.click(); return 'submitted';
  })()`);
  console.log('submit:', sub);
  await cdp.sleep(4000);
  const st1 = await cdp.evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const t = dlg ? dlg.innerText : '';
    return {
      judgedCorrect: t.includes('回答正确'),
      inAnswer: t.includes('提交答案'),
      head: t.slice(0, 340),
    };
  })()`);
  console.log('after submit:', JSON.stringify(st1));
  await cdp.screenshot('ui-shots/rs-4-correct.png');

  // 提前结束并出报告
  const fin = await cdp.evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const btn = [...dlg.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '提前结束并出报告');
    if (!btn) return 'no-finish-btn';
    btn.click(); return 'clicked';
  })()`);
  console.log('finish early click:', fin);
  await cdp.sleep(4500);
  const st2 = await cdp.evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const t = dlg ? dlg.innerText : '';
    return {
      hasReport: t.includes('自我测评报告') || t.includes('复习建议'),
      hasAgain: t.includes('再来一轮'),
      hasDone: t.includes('完成'),
      head: t.slice(0, 400),
    };
  })()`);
  console.log('report view:', JSON.stringify(st2));
  await cdp.screenshot('ui-shots/rs-5-report.png');
}
