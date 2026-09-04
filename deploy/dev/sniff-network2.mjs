// 嗅探 better-auth 实际调用（navigate 后注入 fetch wrap）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[sniff-net]", ...a);

export async function run(cdp) {
  // 1. 加载页面
  await cdp.send("Page.navigate", { url: "http://localhost:8081/" });
  await sleep(3500);

  // 2. navigate 后注入 fetch wrap（必须在 React 加载前尽早注入，且 React fetch 调用通过我们 wrap）
  await cdp.evaluate(`(() => {
    window.__authFetches = [];
    const origFetch = window.fetch;
    window.fetch = async function(...args) {
      const url = typeof args[0] === 'string' ? args[0] : args[0].url;
      const init = args[1] || {};
      const rec = { url, method: (init.method || 'GET'), time: Date.now(), credentials: init.credentials || 'omit' };
      window.__authFetches.push(rec);
      try {
        const r = await origFetch.apply(this, args);
        rec.status = r.status;
        return r;
      } catch (e) {
        rec.error = e.message;
        throw e;
      }
    };
    // 同时 hook XHR（better-auth 可能用 XHR）
    const OrigXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = class extends OrigXHR {
      open(method, url, ...rest) {
        this.__rec = { method, url: (typeof url === 'string' ? url : url.toString()), time: Date.now() };
        return super.open(method, url, ...rest);
      }
      send(...args) {
        if (this.__rec) (window.__authFetches ||= []).push(this.__rec);
        return super.send(...args);
      }
    };
  })()`);
  await sleep(100);

  // 3. 触发 React Query 重新 fetch（手动 reload）
  await cdp.send("Page.reload", {});
  await sleep(7000);

  const fetches = await cdp.evaluate(`(() => window.__authFetches || [])()`);
  log("fetches after reload:", JSON.stringify(fetches.slice(0, 25), null, 1));
  const principal = await cdp.evaluate(`(() => ({
    hasLearningNav: !!document.querySelector('nav[aria-label="学习记录"]'),
    hasThreadSection: !!document.querySelector('section[aria-label="对话"]'),
    bodyHead: document.body.innerText.slice(0, 200).replace(/\\s+/g, ' '),
  }))()`);
  log("ui state:", JSON.stringify(principal));
}
