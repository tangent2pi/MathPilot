// walk-verify-report.mjs — verify messages API in authenticated browser context
export async function run(cdp) {
  await cdp.send('Page.navigate', { url: 'http://localhost:8081/' });
  await cdp.sleep(4500);

  // In-context fetch using page's cookies
  const probe = await cdp.evaluate(`(async () => {
    const r = await fetch('/api/learning/threads/thr_efb0b1608f85fc87182519c5/messages', { credentials: 'include' });
    const status = r.status;
    const ct = r.headers.get('content-type') || '';
    let preview = '';
    let json = null;
    if (ct.includes('json')) { json = await r.json(); preview = JSON.stringify(json).slice(0, 1500); }
    else { preview = (await r.text()).slice(0, 500); }
    return { status, ct, preview };
  })()`);
  console.log('fetch /messages:');
  console.log('  status:', probe.status);
  console.log('  ct:', probe.ct);
  console.log('  preview:', probe.preview);

  // navigate to that thread route, see if messages render
  await cdp.send('Page.navigate', { url: 'http://localhost:8081/c/thr_efb0b1608f85fc87182519c5' });
  await cdp.sleep(5500);

  const state = await cdp.evaluate(`(() => {
    const main = document.querySelector('main, [data-radix-scroll-area-viewport]');
    const body = document.body.innerText;
    return {
      url: location.href,
      hasReport: body.includes('自我测评报告'),
      hasAccuracy: body.includes('准确率'),
      mainTail: (main ? main.innerText : body).slice(-1200),
    };
  })()`);
  console.log('--- after navigate to /c/thr_efb0 ---');
  console.log('URL:', state.url);
  console.log('has 报告:', state.hasReport, '| has 准确率:', state.hasAccuracy);
  console.log('main tail:', state.mainTail);
  await cdp.screenshot('ui-shots/12-direct-thread.png');
}