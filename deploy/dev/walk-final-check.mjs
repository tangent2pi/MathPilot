export async function run(cdp) {
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:5174/' });
  await cdp.sleep(7000);
  const st = await cdp.evaluate(`(async () => {
    const me = await fetch('/api/me', { credentials: 'include' }).then(r => r.status).catch(e => 'err:' + e.message);
    const body = document.body.innerText;
    return {
      me,
      hasNewChat: body.includes('新对话'),
      hasSidebar: body.includes('数学智元'),
      head: body.slice(0, 150),
      loadingText: body.includes('正在读取账户'),
    };
  })()`);
  console.log('me-status:', st.me, '| hasNewChat:', st.hasNewChat, '| hasSidebar:', st.hasSidebar, '| loading:', st.loadingText);
  console.log('head:', JSON.stringify(st.head));
}
