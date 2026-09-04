// 嗅探前端 better-auth session 实际走的 endpoint
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[sniff]", ...a);

export async function run(cdp) {
  await cdp.send("Network.enable", {});
  await cdp.send("Page.navigate", { url: "http://localhost:8081/" });
  await sleep(6000);

  // 1. 直接调 better-auth 标准 get-session endpoint
  const ga = await cdp.evaluate(`(async () => {
    const out = {};
    for (const path of ['/api/auth/get-session', '/api/auth/session', '/api/auth/me', '/api/me']) {
      try {
        const r = await fetch(path, { credentials: 'include' });
        out[path] = { status: r.status, body: (await r.text()).slice(0, 200) };
      } catch (e) { out[path] = 'err:' + e.message; }
    }
    return out;
  })()`);
  log("auth endpoints:", JSON.stringify(ga, null, 1));

  // 2. 列出 document.cookie 全部（fetch 看不到 HttpOnly 但 document.cookie 可见的）
  const cookies = await cdp.evaluate(`(() => document.cookie)()`);
  log("document.cookie:", cookies.slice(0, 300));

  // 3. dump 全局 React Query cache（如果用了 @tanstack/react-query 暴露的话）
  const reactState = await cdp.evaluate(`(() => {
    const win = window;
    const rqKey = win.__REACT_QUERY_DEVTOOLS_GLOBAL_HOOK__ ? 'devtools' : null;
    return {
      hasDevtools: !!rqKey,
      keys: Object.keys(win).filter(k => k.toLowerCase().includes('react') || k.toLowerCase().includes('query')).slice(0, 10),
    };
  })()`);
  log("react state:", JSON.stringify(reactState));
}
