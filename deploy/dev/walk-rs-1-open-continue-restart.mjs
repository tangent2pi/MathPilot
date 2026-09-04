// 回归 R1：DB 存在 active run(str_15103bb1cc85) 时
// 1) 打开「自我测评」应探测到进行中轮 → 进 answer（续测）
// 2) answer 点「重新选题」→ resetToPick 异步：先静默 finishRun 旧轮 → 回 pick
export async function run(cdp) {
  // 打开入口
  const opened = await cdp.evaluate(`(() => {
    const btn = document.querySelector('[aria-label="自我测评"]');
    if (!btn) return 'no-entry';
    btn.click();
    return 'opened';
  })()`);
  console.log('entry click:', opened);
  await cdp.sleep(4000);

  const st1 = await cdp.evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return { hasDialog: false };
    const t = dlg.innerText;
    return {
      hasDialog: true,
      head: t.slice(0, 260),
      inAnswer: t.includes('第 ') && t.includes('题'),
      hasRestart: t.includes('重新选题'),
      inPick: t.includes('① 选择章节'),
    };
  })()`);
  console.log('dialog#1:', JSON.stringify(st1));
  await cdp.screenshot('ui-shots/rs-1-continue-answer.png');

  if (!st1.hasDialog) return;

  // 若在 answer，点「重新选题」；若已在 pick，说明没续测上（DB 状态不同步?），同样点开始测评前先记录
  if (st1.inAnswer) {
    const rc = await cdp.evaluate(`(() => {
      const dlg = document.querySelector('[role="dialog"]');
      const btn = [...dlg.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '重新选题');
      if (!btn) return 'no-btn';
      btn.click(); return 'clicked';
    })()`);
    console.log('restart click:', rc);
    await cdp.sleep(3500);
    const st2 = await cdp.evaluate(`(() => {
      const dlg = document.querySelector('[role="dialog"]');
      const t = dlg ? dlg.innerText : '';
      return { backToPick: t.includes('① 选择章节'), hasStart: t.includes('开始测评'), msg: (t.match(/本轮测评已结束|重新选题|error/i) || [])[0] || null };
    })()`);
    console.log('after restart:', JSON.stringify(st2));
    await cdp.screenshot('ui-shots/rs-2-back-to-pick.png');
  } else {
    console.log('NOT in answer view — DB active run 未被识别为续测；view head:', st1.head);
  }
}
