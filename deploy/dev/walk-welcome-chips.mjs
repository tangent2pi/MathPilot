export async function run(cdp) {
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:8081/' });
  await cdp.sleep(6000);
  const found = await cdp.evaluate(`(() => {
    const btns = [...document.querySelectorAll('button')].map(b => (b.innerText || '').trim()).filter(Boolean);
    const chips = ['贴题讲解','快速出一题','讲一个考点'].filter(t => btns.some(x => x.startsWith(t)));
    const teacherWelcome = document.body.innerText.includes('今天想讲哪道题，还是快速出一题？');
    return { chips, teacherWelcome };
  })()`);
  console.log('welcome chips:', JSON.stringify(found));

  const clicked = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.innerText || '').trim().startsWith('贴题讲解'));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await cdp.sleep(600);
  const state = await cdp.evaluate(`(() => {
    const ta = [...document.querySelectorAll('textarea')].find(i => (i.getAttribute('aria-label') || '') === 'Message input');
    const chipsVisible = [...document.querySelectorAll('button')].some(x => (x.innerText || '').trim().startsWith('贴题讲解'));
    return { composerValue: ta ? ta.value.slice(0, 60) : null, chipsVisible };
  })()`);
  console.log('clicked:', clicked, JSON.stringify(state, null, 2));
  await cdp.screenshot('ui-shots/teacher-chat-welcome-quickprompts.png');
}
