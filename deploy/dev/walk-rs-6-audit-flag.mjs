// 回归 R6：错答案手动上报 → science_v3_self_test_audit 落库
// 1) Dialog 关闭，回到根路径后再次打开 → 开始测评
// 2) 故意填 "80"（不带 °）→ 判错
// 3) 点「我认为题库答案有误，提交勘误」→ 期望 info 提示 + DB 落 1 行 audit_queue
export async function run(cdp) {
  // 刷新到根路径
  const goRoot = await cdp.evaluate(`(() => { history.pushState({}, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')); return location.href; })()`);
  console.log('go root:', goRoot);
  await cdp.sleep(2000);

  // 打开 dialog
  const open = await cdp.evaluate(`(() => { const b = document.querySelector('[aria-label="自我测评"]'); if (!b) return 'no-entry'; b.click(); return 'opened'; })()`);
  console.log('open:', open);
  await cdp.sleep(4000);

  // pick → 开始测评
  const start = await cdp.evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return 'no-dlg';
    const btn = [...dlg.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '开始测评' && !b.disabled);
    if (!btn) return 'no-start';
    btn.click(); return 'clicked';
  })()`);
  console.log('start:', start);
  await cdp.sleep(5000);

  // 故意填"80"判错
  const fill = await cdp.evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const inp = dlg.querySelector('input[aria-label="答案输入"]');
    if (!inp) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, '80');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return 'filled-80';
  })()`);
  console.log('fill:', fill);
  await cdp.sleep(400);
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
    return { incorrect: t.includes('回答错误'), hasFlag: t.includes('题库答案有误'), head: t.slice(0, 240) };
  })()`);
  console.log('after wrong submit:', JSON.stringify(st1));
  await cdp.screenshot('ui-shots/rs-9-wrong.png');

  // 点「提交勘误」
  const flag = await cdp.evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const btn = [...dlg.querySelectorAll('button')].find(b => (b.innerText||'').includes('题库答案有误'));
    if (!btn) return 'no-flag-btn';
    btn.click(); return 'clicked';
  })()`);
  console.log('flag click:', flag);
  await cdp.sleep(3000);
  const st2 = await cdp.evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const t = dlg ? dlg.innerText : '';
    return { reported: t.includes('已上报') || t.includes('题库勘误队列'), head: t.slice(0, 360) };
  })()`);
  console.log('after flag:', JSON.stringify(st2));
  await cdp.screenshot('ui-shots/rs-10-flagged.png');
}
