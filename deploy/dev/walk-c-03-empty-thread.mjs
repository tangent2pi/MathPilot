// walk-c-03 — create an EMPTY thread via in-page fetch, visit /c/:id, dump what renders,
// then click 新对话 and compare. Goal: prove empty-thread page === root page visually.
export async function run(cdp) {
  const created = await cdp.evaluate(`(async () => {
    const key = 'probe-c-03-' + Date.now();
    const res = await fetch('/api/learning/threads', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ expected_version: 0, requested_at: new Date().toISOString(), title: 'empty-thread-probe', idempotency_key: key }),
    });
    const j = await res.json().catch(() => null);
    return { status: res.status, body: j };
  })()`);
  console.log('created:', created.status, JSON.stringify(created.body).slice(0, 300));
  const tid = created.body?.thread?.thread_id;
  if (!tid) { console.log('no thread_id, abort'); return; }

  const dump = async (label) => {
    const s = await cdp.evaluate(`(() => {
      const body = document.body.innerText;
      const welcome = body.includes('今天想从哪道数学问题开始');
      const skeleton = body.includes('正在读取对话');
      const mainEls = [...document.querySelectorAll('[data-slot^="aui_thread"]')]
        .map(e => ({ slot: e.getAttribute('data-slot'), t: (e.innerText||'').trim().slice(0,60) }));
      return { url: location.href, welcome, skeleton, aui: mainEls.slice(0, 10) };
    })()`);
    console.log(`--- ${label} ---`);
    console.log('URL:', s.url, '| welcome:', s.welcome, '| skeleton:', s.skeleton);
    console.log('aui slots:', JSON.stringify(s.aui));
  };

  // visit the empty thread
  await cdp.send('Page.navigate', { url: 'http://localhost:5174/c/' + tid });
  await cdp.sleep(5000);
  await dump('empty thread ' + tid);

  // click 新对话 (sidebar)
  await cdp.evaluate(`(() => {
    const el = [...document.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '新对话');
    if (el) { el.click(); return true; }
    return false;
  })()`);
  await cdp.sleep(2500);
  await dump('after 新对话');
  await cdp.screenshot('ui-shots/c-03-compare.png');
}
