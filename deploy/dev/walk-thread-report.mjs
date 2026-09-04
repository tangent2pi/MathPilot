// walk-thread-report.mjs — close dialog, verify report rendered as assistant message in thread
export async function run(cdp) {
  await cdp.send('Page.navigate', { url: 'http://localhost:8081/' });
  await cdp.sleep(5000);

  // dialog may auto-reopen on navigate if run persisted? just close any dialog first
  await cdp.evaluate(`(() => {
    const els = [...document.querySelectorAll('button')];
    const el = els.find(e => (e.innerText||'').trim() === 'Close' || e.getAttribute('aria-label') === 'Close');
    if (el) el.click();
  })()`);
  await cdp.sleep(800);

  const st = await cdp.evaluate(`(() => {
    const body = document.body.innerText;
    const hasReport = body.includes('自我测评报告');
    // locate report snippet position in chat area: search main message container text
    const main = document.querySelector('main, [class*="scroll"], [data-radix-scroll-area-viewport]');
    const mainText = main ? main.innerText.slice(0, 3000) : '(no main)';
    return { hasReportInBody: hasReport, mainText };
  })()`);
  console.log('report in body:', st.hasReportInBody);
  console.log('--- main area text ---');
  console.log(st.mainText);
  await cdp.screenshot('ui-shots/10-thread-report.png');
}
