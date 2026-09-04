// walk-c-02 — enter a conversation thread, then click 新对话, observe whether it resets to welcome
export async function run(cdp) {
  const dumpMain = async (label) => {
    const s = await cdp.evaluate(`(() => {
      const body = document.body.innerText;
      const welcome = body.includes('今天想从哪道数学问题开始');
      // message bubbles live in main area; sidebar thread list also shows titles. Pick thread titles area by class hint:
      const msgs = [...document.querySelectorAll('[data-slot^="aui_"]')].map(e => (e.innerText||'').trim()).filter(t => t && t.length < 120);
      return {
        url: location.href,
        welcome,
        hasOldContent: body.includes('一元二次方程'),
        bubbleSample: msgs.slice(-12),
      };
    })()`);
    console.log(`--- ${label} ---`);
    console.log('URL:', s.url, '| welcome:', s.welcome, '| hasOldContent:', s.hasOldContent);
    console.log('bubbles:', JSON.stringify(s.bubbleSample));
  };

  // Step 1: click the first history thread in sidebar
  const clicked = await cdp.evaluate(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const el = btns.find(b => (b.innerText||'').trim() === '你好，请帮我讲解一下一元二次方程的解法');
    if (!el) return false;
    el.click();
    return true;
  })()`);
  console.log('clicked thread:', clicked);
  await cdp.sleep(4000);
  await dumpMain('inside thread');

  // Step 2: click 新对话
  const clickedNew = await cdp.evaluate(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const el = btns.find(b => (b.innerText||'').trim() === '新对话');
    if (!el) return false;
    el.click();
    return true;
  })()`);
  console.log('clicked 新对话:', clickedNew);
  await cdp.sleep(3000);
  await dumpMain('after 新对话 click');
  await cdp.screenshot('ui-shots/c-02-after-new-chat.png');
}
