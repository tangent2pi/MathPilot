// walk-c-04 — after fix: empty thread shows distinct hint (not big welcome);
// clicking 新对话 from it now yields a visible change.
export async function run(cdp) {
  const dump = async (label) => {
    const s = await cdp.evaluate(`(() => {
      const body = document.body.innerText;
      return {
        url: location.href,
        bigWelcome: body.includes('今天想从哪道数学问题开始'),
        emptyHint: body.includes('空对话') && body.includes('尚无消息'),
      };
    })()`);
    console.log(`--- ${label} ---`);
    console.log('URL:', s.url, '| bigWelcome:', s.bigWelcome, '| emptyHint:', s.emptyHint);
  };

  // 1. existing empty thread thr_072aa5a2460a6a5b1e441b41 (created earlier this session)
  await cdp.send('Page.navigate', { url: 'http://localhost:5174/c/thr_072aa5d2460a6a5b1e441b41' });
  await cdp.sleep(4500);
  await dump('empty thread (expect hint, NOT big welcome)');
  await cdp.screenshot('ui-shots/c-04-empty-thread-hint.png');

  // 2. click 新对话 -> must now be visually distinguishable
  await cdp.evaluate(`(() => {
    const el = [...document.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '新对话');
    if (el) { el.click(); return true; }
    return false;
  })()`);
  await cdp.sleep(2500);
  await dump('root after 新对话 (expect big welcome back)');
  await cdp.screenshot('ui-shots/c-04-root-welcome.png');
}
