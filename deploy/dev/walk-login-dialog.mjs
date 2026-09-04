export async function run(cdp) {
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:5174/' });
  await cdp.sleep(5000);
  const ta = await cdp.evaluate(`(() => {
    const t = document.querySelector('textarea');
    return t ? { count: document.querySelectorAll('textarea').length, aria: t.getAttribute('aria-label'), ph: t.placeholder } : null;
  })()`);
  console.log('textarea:', JSON.stringify(ta));
  if (!ta) return;
  await cdp.evaluate(`(() => {
    const ta2 = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta2, '你好，请帮我讲题');
    ta2.dispatchEvent(new Event('input', { bubbles: true }));
    return ta2.value;
  })()`);
  await cdp.sleep(800);
  const btns = await cdp.evaluate(`(() => {
    return [...document.querySelectorAll('button')]
      .filter(b => b.getBoundingClientRect().width > 0)
      .map(b => ({ aria: b.getAttribute('aria-label'), disabled: b.disabled, cls: (b.className||'').slice(0,40) }))
      .filter(b => b.aria && (b.aria.includes('发送') || b.aria.includes('send')));
  })()`);
  console.log('send buttons:', JSON.stringify(btns));
  const clicked = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => {
      const a = x.getAttribute('aria-label') || '';
      return (a.includes('发送消息') || a.toLowerCase().includes('send')) && !x.disabled;
    });
    if (!b) return 'not found/enabled';
    b.click();
    return 'clicked';
  })()`);
  console.log('send click:', clicked);
  await cdp.sleep(2000);
  const dlg = await cdp.evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return null;
    return { title: (d.querySelector('h2')||{}).innerText||'', email: !!d.querySelector('input[type="email"]'), pass: !!d.querySelector('input[type="password"]') };
  })()`);
  console.log('dialog:', JSON.stringify(dlg));
}
