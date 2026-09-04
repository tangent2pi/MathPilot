// walk-create-run.mjs — pick 正弦定理 (20题) knowledge point, 基础 difficulty, click 开始测评
export async function run(cdp) {
  await cdp.send('Page.navigate', { url: 'http://localhost:8081/' });
  await cdp.sleep(4000);

  // open self-test dialog
  await cdp.evaluate(`(() => {
    const btns = [...document.querySelectorAll('button')].filter(b => b.getAttribute('aria-label') === '自我测评' || (b.innerText||'').trim() === '自我测评');
    if (btns.length) btns[btns.length - 1].click();
  })()`);
  await cdp.sleep(1800);

  // click 正弦定理 (not the 变形应用 one) — exact match on text that starts with 正弦定理
  const picked = await cdp.evaluate(`(() => {
    const els = [...document.querySelectorAll('button, [role="button"], label, div')];
    const el = els.find(e => {
      const t = (e.innerText || '').trim();
      return t.startsWith('正弦定理') && !t.startsWith('正弦定理与余弦定理') && t.includes('题');
    });
    if (!el) return 'kp not found';
    el.click();
    return 'picked: ' + (el.innerText || '').trim().slice(0, 30);
  })()`);
  console.log('pick kp:', picked);
  await cdp.sleep(800);

  // click 基础 difficulty
  const diff = await cdp.evaluate(`(() => {
    const els = [...document.querySelectorAll('button, [role="button"]')];
    const el = els.find(e => (e.innerText || '').trim() === '基础');
    if (!el) return '基础 not found';
    el.click();
    return 'picked 基础';
  })()`);
  console.log('pick diff:', diff);
  await cdp.sleep(800);

  // click 开始测评
  const started = await cdp.evaluate(`(() => {
    const els = [...document.querySelectorAll('button')];
    const el = els.find(e => (e.innerText || '').trim().includes('开始测评'));
    if (!el) return 'start btn not found';
    el.click();
    return 'clicked 开始测评';
  })()`);
  console.log('start:', started);
  await cdp.sleep(6000);

  const state = await cdp.evaluate(`(() => ({
    body: document.body.innerText.slice(0, 2500),
  }))()`);
  console.log('--- body ---');
  console.log(state.body);
  await cdp.screenshot('ui-shots/06-run-question.png');
}
