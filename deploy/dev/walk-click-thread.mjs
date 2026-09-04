// walk-click-thread.mjs — click 自我测评 thread item, dump message area
export async function run(cdp) {
  await cdp.send('Page.navigate', { url: 'http://localhost:8081/' });
  await cdp.sleep(5000);

  const clicked = await cdp.evaluate(`(() => {
    // find sidebar item with text 自我测评
    const candidates = [...document.querySelectorAll('a, button, [role="link"], div, li')];
    const el = candidates.find(e => {
      const t = (e.innerText || '').trim();
      return t === '自我测评' && e.offsetParent;
    });
    if (!el) return 'not found';
    el.click();
    return 'clicked';
  })()`);
  console.log('click thread:', clicked);
  await cdp.sleep(5000);

  const st = await cdp.evaluate(`(() => {
    const main = document.querySelector('main, [data-radix-scroll-area-viewport], [class*="scroll"]');
    return { mainText: main ? main.innerText.slice(0, 3000) : '(no main)', body: document.body.innerText.slice(-2000) };
  })()`);
  console.log('--- main text ---');
  console.log(st.mainText);
  console.log('--- body tail ---');
  console.log(st.body);
  await cdp.screenshot('ui-shots/11-thread-opened.png');
}
