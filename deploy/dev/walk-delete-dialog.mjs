// 验证 LearningSidebar window.confirm → Dialog 修复（cdp-drive 契约：导出 run(cdp)）
// 用法: node cdp-drive.mjs 9444 walk-delete-dialog.mjs
// 1) 登录 student
// 2) 打开第一个 active 线程的 DropdownMenu → 点「删除对话」菜单项
// 3) 若修复生效：出现 React Dialog（含取消/删除按钮），线程未被删
//    若仍有 window.confirm：headless CDP auto-accept 直接删除线程（无 Dialog）
// 4) 点「取消」→ Dialog 关闭
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[walk-delete-dialog]", ...a);

export async function run(cdp) {
  // 1. 首页
  await cdp.send("Page.navigate", { url: "http://localhost:8081/" });
  await sleep(3500);
  log("title:", await cdp.evaluate("document.title"));

  // 2. 检查登录态（better-auth cookie）+ reload 触发前端 useAuth 同步
  const me = await cdp.evaluate(`(async () => {
    try { const r = await fetch('/api/me', { credentials: 'include' }); return { status: r.status, body: (await r.text()).slice(0, 200) }; }
    catch (e) { return 'err:' + e.message; }
  })()`);
  log("/api/me:", JSON.stringify(me));
  if (me?.status !== 200) {
    log("not logged in (api/me not 200). aborting.");
    return;
  }
  // 触发前端 useAuth 同步（reload 重新触发 session fetch + thread list query）
  await cdp.send("Page.reload", {});
  await sleep(5000);
  const meProbe = await cdp.evaluate(`(() => ({
    bodyHead: document.body.innerText.slice(0, 150).replace(/\\s+/g, ' '),
    hasThreadSection: !!document.querySelector('section[aria-label="对话"]'),
    hasLearningNav: !!document.querySelector('nav[aria-label="学习记录"]'),
    threadRowCount: document.querySelectorAll('[class*="group/thread"]').length,
  }))()`);
  log("post-reload state:", JSON.stringify(meProbe));

  // 3. 找侧栏线程列表第一个 active（非 archived）线程
  const threadInfo = await cdp.evaluate(`(() => {
    const nav = document.querySelector('section[aria-label="对话"]') || document;
    const groups = [...nav.querySelectorAll('[class*="group/thread"]')];
    return groups.slice(0, 5).map(g => ({
      cls: (g.className||'').slice(0, 70),
      title: ((g.querySelector('button[class*="truncate"]')||{}).innerText||'').trim().slice(0, 40),
      hasMore: !!([...g.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '对话操作' || !!b.querySelector('.lucide-more-horizontal'))),
    }));
  })()`);
  log("threads:", JSON.stringify(threadInfo, null, 1));
  if (!threadInfo.length) throw new Error("no thread row found");

  // 4. 打开第一个 active 线程的 More 菜单 → 点「删除对话」
  const clicked = await cdp.evaluate(`(() => {
    const nav = document.querySelector('section[aria-label="对话"]') || document;
    const groups = [...nav.querySelectorAll('[class*="group/thread"]')];
    const target = groups.find(g => !((g.className||'').includes('opacity-55'))) || groups[0];
    const moreBtn = [...target.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '') === '对话操作' || !!b.querySelector('.lucide-more-horizontal'));
    if (!moreBtn) return 'no-more-btn';
    moreBtn.click();
    return 'clicked-more: ' + ((target.querySelector('button[class*="truncate"]')||{}).innerText||'').trim().slice(0, 30);
  })()`);
  log("open menu:", clicked);
  await sleep(900);

  const delItem = await cdp.evaluate(`(() => {
    const items = [...document.querySelectorAll('[role="menuitem"], [class*="menu-item"]')].filter(i => (i.innerText||'').includes('删除对话'));
    if (!items.length) return 'no-delete-item';
    items[0].click();
    return 'clicked-delete';
  })()`);
  log("click delete item:", delItem);
  await sleep(1400);

  // 5. 检查 Dialog 是否出现（修复标志：出现 Dialog 而不是原生 confirm 被 auto-accept）
  const dialogState = await cdp.evaluate(`(() => {
    const dlg = document.querySelector('[data-slot="dialog-content"]') || document.querySelector('[role="dialog"]');
    if (!dlg) return { shown: false };
    const txt = (dlg.innerText || '').trim();
    return {
      shown: true,
      title: (dlg.querySelector('[data-slot="dialog-title"]') || {innerText:''}).innerText?.trim(),
      desc: (dlg.querySelector('[data-slot="dialog-description"]') || {innerText:''}).innerText?.trim().slice(0, 60),
      buttons: [...dlg.querySelectorAll('button')].map(b => (b.innerText||'').trim()).filter(Boolean),
    };
  })()`);
  log("dialog after delete click:", JSON.stringify(dialogState, null, 1));

  // 截图：Dialog 打开状态
  await cdp.screenshot("ui-shots/16-delete-dialog.png");
  log("saved ui-shots/16-delete-dialog.png");

  // 6. 点「取消」→ Dialog 关闭（线程不删，DB 侧另行核验）
  const cancelRes = await cdp.evaluate(`(() => {
    const dlg = document.querySelector('[data-slot="dialog-content"]') || document.querySelector('[role="dialog"]');
    if (!dlg) return 'no-dialog';
    const btns = [...dlg.querySelectorAll('button')];
    const cancel = btns.find(b => (b.innerText||'').trim() === '取消');
    if (!cancel) return 'no-cancel-btn';
    cancel.click();
    return 'clicked-cancel';
  })()`);
  log("click cancel:", cancelRes);
  await sleep(900);
  const stillOpen = await cdp.evaluate(`(() => !!document.querySelector('[data-slot="dialog-content"]'))()`);
  log("dialog closed after cancel:", !stillOpen);

  // 7. 截图收尾
  await cdp.screenshot("ui-shots/17-after-cancel.png");
  log("saved ui-shots/17-after-cancel.png");
  log("DONE");
}
