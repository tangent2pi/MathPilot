// 回归 R5（C1 复测）：根路径新对话 vs 空命名线程 视觉必须可区分
// 1) 点侧边栏「新对话」→ 根路径 / → 应显示大欢迎页 ThreadWelcome
// 2) 从根路径再点侧边栏「empty-thread-probe」→ 空线程 → 应显示 EmptyThreadHint（不是欢迎大标题）
export async function run(cdp) {
  // step1: 点「新对话」
  const nc = await cdp.evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '新对话');
    if (!btn) return 'no-btn';
    btn.click(); return 'clicked';
  })()`);
  console.log('new-chat click:', nc);
  await cdp.sleep(2500);
  const s1 = await cdp.evaluate(`(() => {
    const body = document.body.innerText;
    return {
      url: location.href,
      isRoot: location.pathname === '/',
      welcome: body.includes('今天想从哪道数学问题开始'),
      emptyHint: body.includes('空对话 · 尚无消息'),
    };
  })()`);
  console.log('root state:', JSON.stringify(s1));
  await cdp.screenshot('ui-shots/rs-7-root-welcome.png');

  // step2: 点击空线程 empty-thread-probe（需先确认它在侧栏；不在则建一个）
  const th = await cdp.evaluate(`(() => {
    const items = [...document.querySelectorAll('button, a')];
    const el = items.find(b => (b.innerText||'').trim() === 'empty-thread-probe');
    if (!el) return 'no-thread';
    el.click(); return 'clicked';
  })()`);
  console.log('empty-thread click:', th);
  await cdp.sleep(2500);
  const s2 = await cdp.evaluate(`(() => {
    const body = document.body.innerText;
    return {
      url: location.href,
      welcome: body.includes('今天想从哪道数学问题开始'),
      emptyHint: body.includes('空对话 · 尚无消息'),
      bodyHead: body.slice(0, 260),
    };
  })()`);
  console.log('empty-thread state:', JSON.stringify(s2));
  await cdp.screenshot('ui-shots/rs-8-empty-thread-hint.png');
}
