export async function run(cdp) {
  await cdp.send('Page.reload');
  await cdp.sleep(6000);
  const st = await cdp.evaluate(`(() => {
    const body = document.body.innerText;
    return { url: location.href, hasNewChat: body.includes('新对话'), hasSidebar: body.includes('数学智元'), head: body.slice(0,200) };
  })()`);
  console.log('URL:', st.url, '| hasNewChat:', st.hasNewChat, '| hasSidebar:', st.hasSidebar);
}
