export async function run(cdp) {
  await cdp.send('Page.navigate', { url: 'http://localhost:5174/' });
  await cdp.sleep(3500);
  const info = await cdp.evaluate(`(() => {
    const btns = [...document.querySelectorAll('button')].filter(e => e.getBoundingClientRect().width > 0)
      .map(e => ({ t: (e.innerText||'').trim().slice(0,40), aria: e.getAttribute('aria-label') || '' }));
    const body = document.body.innerText.slice(0, 1200);
    return { btns, body };
  })()`);
  console.log('buttons:', JSON.stringify(info.btns));
  console.log('BODY:', info.body.replace(/\n+/g, ' | '));
}
