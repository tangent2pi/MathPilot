// 诊断: better-auth cookie 存储 + 页面登录入口结构
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[probe-auth-diag]", ...a);

export async function run(cdp) {
  await cdp.send("Page.navigate", { url: "http://localhost:8081/" });
  await sleep(3000);

  // 1. 看登录响应头（Set-Cookie 名）
  const respInfo = await cdp.evaluate(`(async () => {
    const res = await fetch('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'student@mathpilot.local', password: 'MathPilotStudent123!' }),
    });
    const setCookie = res.headers.get('set-cookie') || '';
    const cookieNow = document.cookie;
    const lsKeys = Object.keys(localStorage).filter(k => /auth|session|better|token/i.test(k));
    const ls = {};
    for (const k of lsKeys) ls[k] = (localStorage.getItem(k)||'').slice(0, 80);
    return { setCookie: setCookie.slice(0, 300), cookieNow, lsKeys, ls };
  })()`);
  log("auth resp:", JSON.stringify(respInfo, null, 1));

  // 2. dump 所有可点元素（header/右上角/avatar）
  const clickables = await cdp.evaluate(`(() => {
    const out = [];
    for (const b of document.querySelectorAll('button, a, [role="button"], [tabindex]')) {
      const t = (b.innerText || b.getAttribute('aria-label') || b.getAttribute('title') || '').trim().replace(/\\s+/g, ' ');
      const cls = (b.className || '').toString().slice(0, 40);
      if (t.length < 30) out.push({ tag: b.tagName, text: t.slice(0, 25), cls });
    }
    return out.slice(0, 25);
  })()`);
  log("clickables:", JSON.stringify(clickables, null, 1));

  // 3. 截图空态
  await cdp.screenshot("ui-shots/18-empty-home.png");
  log("shot saved");
}
