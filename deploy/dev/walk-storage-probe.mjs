export async function run(cdp) {
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:8081/' });
  await cdp.sleep(5000);
  const r = await cdp.evaluate(`(async () => {
    const out = { url: location.href };
    try {
      const me = await fetch('/api/me', { credentials: 'include' });
      out.me = me.status;
    } catch (e) { out.me = 'ERR ' + e; }
    try {
      const init = await fetch('/api/storage/objects/init', {
        method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ purpose: 'thread', mime_type: 'image/png', byte_size: 10, original_name: 'p.png' }),
      });
      out.initStatus = init.status;
      out.initBody = (await init.text()).slice(0, 300);
    } catch (e) { out.initError = String(e); }
    return out;
  })()`);
  console.log(JSON.stringify(r, null, 2));
}
