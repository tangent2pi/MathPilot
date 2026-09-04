// 回归 R2：pick 视图点「开始测评」→ 应成功建新轮（单例锁已被 resetToPick 释放）
// 默认已勾选第一个可抽知识点，难度默认 medium
export async function run(cdp) {
  const st0 = await cdp.evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return { hasDialog: false };
    const t = dlg.innerText;
    return { hasDialog: true, inPick: t.includes('① 选择章节'), head: t.slice(0, 220) };
  })()`);
  console.log('pre-start pick:', st0.inPick, '| hasDialog:', st0.hasDialog);

  const start = await cdp.evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const btn = [...dlg.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '开始测评');
    if (!btn) return 'no-btn';
    if (btn.disabled) return 'disabled';
    btn.click(); return 'clicked';
  })()`);
  console.log('start click:', start);
  await cdp.sleep(5000);

  const st1 = await cdp.evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return { hasDialog: false, url: location.href };
    const t = dlg.innerText;
    const errBox = dlg.querySelector('[role="alert"]');
    return {
      hasDialog: true,
      url: location.href,
      inAnswer: t.includes('提交答案'),
      errText: errBox ? errBox.innerText.slice(0, 200) : null,
      head: t.slice(0, 260),
    };
  })()`);
  console.log('after start:', JSON.stringify(st1));
  await cdp.screenshot('ui-shots/rs-3-new-run-answer.png');
}
