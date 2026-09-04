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
    return s;
  };

  // empty thread: must show the distinct hint (fix verified), NOT big welcome
  await cdp.send('Page.navigate', { url: 'http://localhost:5174/c/thr_072aa5d2460a6a5b1e441b41' });
  await cdp.sleep(4500);
  const a = await dump('empty thread');
  await cdp.screenshot('ui-shots/c-05-empty-hint.png');

  // root path: big welcome (unchanged)
  await cdp.send('Page.navigate', { url: 'http://localhost:5174/' });
  await cdp.sleep(4000);
  const b = await dump('root path');
  await cdp.screenshot('ui-shots/c-05-root.png');

  console.log('DIFFERENT_RENDER:', a.bigWelcome !== b.bigWelcome);
}
