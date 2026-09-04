// probe-login.mjs — navigate to 8081 and dump interactive elements text
export async function run(cdp) {
  await cdp.send('Page.navigate', { url: 'http://localhost:8081/' });
  await cdp.sleep(8000);

  const info = await cdp.evaluate(`(() => {
    const out = { url: location.href, title: document.title, body: document.body ? document.body.innerText.slice(0, 1500) : '' };
    const els = [];
    document.querySelectorAll('input, button, textarea, select, [role="button"], a').forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      els.push({
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        name: el.name || '',
        placeholder: el.placeholder || '',
        aria: el.getAttribute('aria-label') || '',
        text: (el.innerText || el.value || '').trim().slice(0, 60),
        id: el.id || '',
      });
    });
    out.elements = els.slice(0, 80);
    return out;
  })()`);

  console.log('URL:', info.url);
  console.log('TITLE:', info.title);
  console.log('--- body text (first 1500) ---');
  console.log(info.body);
  console.log('--- interactive elements ---');
  for (const e of info.elements) {
    console.log(`[${e.tag}${e.type ? ':' + e.type : ''}] id=${e.id || '-'} name=${e.name || '-'} ph="${e.placeholder || '-'}" aria="${e.aria || '-'}" text="${e.text || '-'}"`);
  }
  await cdp.screenshot('ui-shots/02-login-page.png');
}
