// 探测首页登录入口元素（无登录态场景）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[probe-login-entry]", ...a);

export async function run(cdp) {
  await cdp.send("Page.navigate", { url: "http://localhost:8081/" });
  await sleep(3500);
  log("title:", await cdp.evaluate("document.title"));
  const btns = await cdp.evaluate(`(() => {
    const out = [];
    for (const b of document.querySelectorAll('button, a, [role="button"]')) {
      const t = (b.innerText || b.getAttribute('aria-label') || '').trim();
      if (t && t.length < 20) out.push(t);
    }
    return [...new Set(out)].slice(0, 30);
  })()`);
  log("buttons:", JSON.stringify(btns));
  const hasSidebar = await cdp.evaluate(`(() => {
    const nav = document.querySelector('nav[aria-label="对话"], section[aria-label="对话"]');
    return !!nav;
  })()`);
  log("has sidebar:", hasSidebar);
}
