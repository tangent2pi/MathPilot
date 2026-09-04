// 嗅探 better-auth client 实际请求 + 响应
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[sniff-net]", ...a);

export async function run(cdp) {
  const events = [];
  await cdp.send("Network.enable", {});
  // 改方案：fetch + Promise.all 跟踪页面里所有 fetch 调用
  await cdp.evaluate(`(() => {
    window.__authFetches = [];
    const origFetch = window.fetch;
    window.fetch = async function(...args) {
      const url = typeof args[0] === 'string' ? args[0] : args[0].url;
      const init = args[1] || {};
      window.__authFetches.push({ url, method: (init.method || 'GET'), time: Date.now(), credentials: init.credentials || 'omit' });
      try {
        const r = await origFetch.apply(this, args);
        window.__authFetches[window.__authFetches.length - 1].status = r.status;
        return r;
      } catch (e) {
        window.__authFetches[window.__authFetches.length - 1].error = e.message;
        throw e;
      }
    };
  })()`);
  await cdp.send("Page.navigate", { url: "http://localhost:8081/" });
  await sleep(6000);
  const fetches = await cdp.evaluate(`(() => window.__authFetches || [])()`);
  log("all fetches:", JSON.stringify(fetches, null, 1));

  // 再看 useAuth 暴露的 window.__authClient？或 React state
  const principalNow = await cdp.evaluate(`(() => {
    const navLearning = document.querySelector('nav[aria-label="学习记录"]');
    const sidebarSection = document.querySelector('section[aria-label="对话"]');
    return {
      hasLearningNav: !!navLearning,
      hasThreadSection: !!sidebarSection,
      bodyHead: document.body.innerText.slice(0, 200).replace(/\\s+/g, ' '),
    };
  })()`);
  log("ui state:", JSON.stringify(principalNow));
}
