// 诊断当前 chrome 登录态 + chat 输入触发登录 dialog 的方式
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[diag]", ...a);

export async function run(cdp) {
  await cdp.send("Page.navigate", { url: "http://localhost:8081/" });
  await sleep(3500);

  // 1. /api/me 状态
  const me = await cdp.evaluate(`(async () => {
    try { return await (await fetch('/api/me')).text(); }
    catch (e) { return 'err:' + e.message; }
  })()`);
  log("/api/me:", me.slice(0, 200));

  // 2. localStorage 状态
  const ls = await cdp.evaluate(`(() => {
    const out = {};
    for (const k of Object.keys(localStorage)) out[k] = (localStorage.getItem(k)||'').slice(0, 60);
    return out;
  })()`);
  log("localStorage:", JSON.stringify(ls));

  // 3. sessionStorage 状态
  const ss = await cdp.evaluate(`(() => {
    const out = {};
    for (const k of Object.keys(sessionStorage)) out[k] = (sessionStorage.getItem(k)||'').slice(0, 60);
    return out;
  })()`);
  log("sessionStorage:", JSON.stringify(ss));

  // 4. textarea + 发送按钮探测
  const probes = await cdp.evaluate(`(() => {
    const ta = document.querySelector('textarea');
    const send = [...document.querySelectorAll('button')].find(b => (b.innerText || '').trim() === '发送消息');
    return { hasTextarea: !!ta, taPlaceholder: ta?.placeholder, sendDisabled: send?.disabled, sendExists: !!send };
  })()`);
  log("input area:", JSON.stringify(probes));

  // 5. 试着打字+发送并细致观察
  await cdp.evaluate(`(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, 'test login trigger');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(500);
  // 看发送按钮是否变 enabled
  const afterType = await cdp.evaluate(`(() => {
    const send = [...document.querySelectorAll('button')].find(b => (b.innerText || '').trim() === '发送消息');
    return { disabled: send?.disabled, taValue: document.querySelector('textarea')?.value };
  })()`);
  log("after type:", JSON.stringify(afterType));

  // 强制点发送
  const clicked = await cdp.evaluate(`(() => {
    const send = [...document.querySelectorAll('button')].find(b => (b.innerText || '').trim() === '发送消息');
    if (!send) return 'no-send';
    if (send.disabled) return 'send-disabled';
    send.click();
    return 'clicked';
  })()`);
  log("send click:", clicked);

  // 6. 轮询 dialog 出现 (最多 5s)
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    const dlg = await cdp.evaluate(`(() => {
      const d = document.querySelector('[role="dialog"]');
      if (!d) return null;
      return {
        has: true,
        title: (d.querySelector('[data-slot="dialog-title"]') || {innerText:''}).innerText?.trim(),
        email: !!d.querySelector('input[placeholder*="邮箱"]'),
        pass: !!d.querySelector('input[placeholder*="密码"]'),
      };
    })()`);
    if (dlg) { log(`dialog at +${(i+1)*500}ms:`, JSON.stringify(dlg)); break; }
  }
}
