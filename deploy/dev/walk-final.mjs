// walk-final.mjs — login, navigate to /c/thr_efb0b1608, verify report renders as assistant message
export async function run(cdp) {
  await cdp.send('Page.navigate', { url: 'http://localhost:8081/' });
  await cdp.sleep(4000);
  await cdp.evaluate(`(() => {
    const el = [...document.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '登录');
    if (el) el.click();
  })()`);
  await cdp.sleep(2500);
  await cdp.evaluate(`(() => {
    const setVal = (el, v) => {
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const e = [...document.querySelectorAll('input')].find(i => (i.placeholder||'').includes('邮箱'));
    const p = [...document.querySelectorAll('input')].find(i => (i.placeholder||'').includes('密码'));
    setVal(e, 'student@mathpilot.local');
    setVal(p, 'MathPilotStudent123!');
  })()`);
  await cdp.sleep(500);
  await cdp.evaluate(`(() => {
    const forms = [...document.querySelectorAll('form')];
    const btn = forms.length && [...forms[forms.length-1].querySelectorAll('button')].find(b => (b.innerText||'').trim() === '登录');
    if (btn) btn.click();
  })()`);
  await cdp.sleep(7000);

  // navigate to the thread that contains the report
  await cdp.send('Page.navigate', { url: 'http://localhost:8081/c/thr_efb0b1608f85fc87182519c5' });
  await cdp.sleep(6000);

  const state = await cdp.evaluate(`(() => {
    const main = document.querySelector('main, [data-radix-scroll-area-viewport]');
    const body = document.body.innerText;
    return {
      url: location.href,
      hasReport: body.includes('自我测评报告'),
      hasAccuracy: body.includes('准确率'),
      hasChapter: body.includes('解三角形'),
      mainTail: (main ? main.innerText : body).slice(-2500),
    };
  })()`);
  console.log('URL:', state.url);
  console.log('has 报告:', state.hasReport, '| has 准确率:', state.hasAccuracy, '| has 解三角形:', state.hasChapter);
  console.log('main tail:', state.mainTail);
  await cdp.screenshot('ui-shots/15-final-rendered.png');
}