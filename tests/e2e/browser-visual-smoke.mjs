#!/usr/bin/env node
/**
 * 在带 Chromium 的 agent-runtime 容器中运行的无成本视觉回归。
 * 只读取现有页面与 Session，不创建内容，不调用模型或 OCR。
 */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

const origin = process.env.VISUAL_ORIGIN ?? "http://localhost:8080";
const email = process.env.VISUAL_EMAIL;
const password = process.env.VISUAL_PASSWORD;
const studentEmail = process.env.VISUAL_STUDENT_EMAIL;
const studentPassword = process.env.VISUAL_STUDENT_PASSWORD;
if (!email || !password || !studentEmail || !studentPassword) {
  throw new Error("teacher and student visual credentials are required");
}

const port = 9222;
const chrome = spawn("chromium", [
  "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
  // 容器内仍以产品配置的 localhost Origin 访问，由 Chromium 解析到宿主网关。
  "--host-resolver-rules=MAP localhost host.docker.internal",
  `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1",
  `--user-data-dir=/tmp/agmath-chromium-${process.pid}`,
  `${origin}/login.html`,
], { stdio: ["ignore", "ignore", "pipe"] });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browserStderr = "";
chrome.stderr.on("data", (chunk) => { browserStderr += chunk.toString(); });

async function target() {
  for (let i = 0; i < 50; i++) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const page = targets.find((item) => item.type === "page");
      if (page?.webSocketDebuggerUrl) return page;
    } catch { /* Chromium is still starting. */ }
    await delay(100);
  }
  throw new Error(`Chromium did not expose CDP: ${browserStderr.slice(-1000)}`);
}

class Client {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.sequence = 0;
    this.pending = new Map();
    this.waiters = new Map();
    this.events = [];
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
        return;
      }
      this.events.push(message);
      const listeners = this.waiters.get(message.method) ?? [];
      this.waiters.delete(message.method);
      for (const resolve of listeners) resolve(message.params);
    });
  }
  async open() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }
  send(method, params = {}) {
    const id = ++this.sequence;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  event(method, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timeout waiting for ${method}`)), timeoutMs);
      const listeners = this.waiters.get(method) ?? [];
      listeners.push((params) => { clearTimeout(timeout); resolve(params); });
      this.waiters.set(method, listeners);
    });
  }
  close() { this.ws.close(); }
}

async function main() {
  const page = await target();
  const client = new Client(page.webSocketDebuggerUrl);
  await client.open();
  await Promise.all([client.send("Page.enable"), client.send("Runtime.enable"), client.send("Log.enable")]);

  async function evaluate(expression) {
    const result = await client.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }

  async function navigate(path, width, height, name) {
    await client.send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: 1, mobile: width < 600,
    });
    const loaded = client.event("Page.loadEventFired");
    await client.send("Page.navigate", { url: `${origin}${path}` });
    await loaded;
    await delay(500);
    const metrics = await evaluate(`(() => ({
      title: document.title,
      path: location.pathname + location.search,
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
      main: Boolean(document.querySelector('main')),
      nav: Boolean(document.querySelector('nav')),
      h1: [...document.querySelectorAll('h1')].find((heading) => !heading.closest('[hidden]'))?.textContent?.trim() || '',
      mainGutters: (() => {
        const main=document.querySelector('main');
        if (!main) return null;
        const rect=main.getBoundingClientRect();
        const rail=document.querySelector('.side-nav');
        const railRight=rail && getComputedStyle(rail).display !== 'none' ? rail.getBoundingClientRect().right : 0;
        return {left:rect.left-railRight,right:innerWidth-rect.right,rail:railRight};
      })(),
      accountWithinHeader: (() => {
        const header=document.querySelector('.app-header');
        const account=document.querySelector('.app-account');
        if (!header || !account) return null;
        const headerRect=header.getBoundingClientRect();
        const accountRect=account.getBoundingClientRect();
        return accountRect.top >= headerRect.top - 1 && accountRect.bottom <= headerRect.bottom + 1;
      })()
    }))()`);
    if (!metrics.main) throw new Error(`${name}: missing main landmark`);
    if (metrics.scrollWidth > metrics.width + 1) {
      throw new Error(`${name}: horizontal overflow ${metrics.scrollWidth} > ${metrics.width}`);
    }
    if (width <= 720 && metrics.accountWithinHeader === false) {
      throw new Error(`${name}: account control escaped the mobile header`);
    }
    if (metrics.mainGutters && Math.abs(metrics.mainGutters.left - metrics.mainGutters.right) > 1) {
      throw new Error(`${name}: main is off-center within its workspace ${JSON.stringify(metrics.mainGutters)}`);
    }
    const shot = await client.send("Page.captureScreenshot", {
      format: "png", captureBeyondViewport: true, fromSurface: true,
    });
    await writeFile(`/tmp/agmath-${name}.png`, Buffer.from(shot.data, "base64"));
    console.log(JSON.stringify({ name, ...metrics }));
  }

  await navigate("/login.html", 1440, 900, "login-desktop");
  await navigate("/login.html", 390, 844, "login-mobile");
  async function signIn(accountEmail, accountPassword) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const login = await evaluate(`fetch('/api/auth/sign-in/email', {
        method: 'POST', headers: {'content-type':'application/json'},
        body: JSON.stringify({email:${JSON.stringify(accountEmail)},password:${JSON.stringify(accountPassword)},rememberMe:false})
      }).then(async r => ({ok:r.ok,status:r.status,retryAfter:r.headers.get('retry-after'),body:await r.text()}))`);
      if (login.ok) return;
      if (login.status !== 429 || attempt === 3) throw new Error(`login failed: ${login.status} ${login.body}`);
      const retryMs = Math.min(15_000, Math.max(1_000, Number(login.retryAfter || 5) * 1_000));
      console.log(`login rate limited; retrying in ${retryMs}ms`);
      await delay(retryMs);
    }
  }
  await signIn(email, password);

  const runs = await evaluate(`fetch('/api/content/pipelines').then(r => r.json())`);
  const sessionRef = runs?.runs?.[0]?.ktq_session_ref;
  const pipelineRef = runs?.runs?.[0]?.run_id;
  if (!sessionRef || !pipelineRef) throw new Error("no persisted content session found");

  await navigate("/teacher.html", 1440, 900, "teacher-desktop");
  await navigate("/teacher.html", 834, 1112, "teacher-tablet");
  await navigate("/teacher.html", 390, 844, "teacher-mobile");
  await evaluate(`(() => { const input=document.querySelector('#reviewSearch'); input.value='Q_SIN_011'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await delay(800);
  await evaluate(`document.querySelector('.review-list-item')?.click()`);
  await delay(600);
  const reviewDialog = await evaluate(`(() => ({
    open: document.querySelector('#reviewDialog')?.open === true,
    images: [...document.querySelectorAll('#taskAssets img')].map(img => ({complete:img.complete,width:img.naturalWidth})),
    math: document.querySelectorAll('#taskSummary .katex').length,
    sourceCards: document.querySelectorAll('#taskEvidence article').length,
    sourceMeta: document.querySelector('#taskEvidence article small')?.textContent || '',
    sessionLink: document.querySelector('#taskSummary .review-session-link')?.getAttribute('href') || '',
    continueLabel: document.querySelector('#saveAndContinue')?.textContent?.trim() || '',
    actionsVisible: (() => {
      const rect=document.querySelector('#saveAndContinue')?.getBoundingClientRect();
      return Boolean(rect && rect.top >= 0 && rect.bottom <= innerHeight);
    })()
  }))()`);
  if (!reviewDialog.open || reviewDialog.images.length !== 2 || reviewDialog.images.some((item) => !item.complete || item.width < 1) || reviewDialog.math < 1 || reviewDialog.sourceCards < 1 || !reviewDialog.sourceMeta.includes('页') || !reviewDialog.sessionLink.includes('run_ktq_') || reviewDialog.continueLabel !== '保存并继续' || !reviewDialog.actionsVisible) {
    throw new Error(`review content did not render: ${JSON.stringify(reviewDialog)}`);
  }
  const reviewShot = await client.send("Page.captureScreenshot", { format:"png", captureBeyondViewport:true, fromSurface:true });
  await writeFile("/tmp/agmath-review-dialog-desktop.png", Buffer.from(reviewShot.data,"base64"));
  console.log(JSON.stringify({name:"review-dialog-desktop",images:reviewDialog.images.length,math:reviewDialog.math}));
  await evaluate(`document.querySelector('#reviewDialog')?.close()`);
  await navigate("/content.html", 1440, 900, "content-desktop");
  const contentReview = await evaluate(`(() => ({
    scopedLink: document.querySelector(${JSON.stringify(`a[href*="pipeline=${pipelineRef}"]`)})?.textContent?.trim() || "",
    publishForms: document.querySelectorAll('.publish-form').length,
    progress: document.querySelector('.publish-panel .status-note')?.textContent?.trim() || ""
  }))()`);
  if (!contentReview.scopedLink.includes("114") || contentReview.publishForms !== 0 || !contentReview.progress.includes("0 / 114")) {
    throw new Error(`content review progress is inconsistent: ${JSON.stringify(contentReview)}`);
  }
  const uploadUx = await evaluate(`(() => {
    const input=document.querySelector('#materials'),zone=document.querySelector('#dropzone');
    const choose=(name) => { const transfer=new DataTransfer();transfer.items.add(new File([name],name,{type:'text/plain'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true})); };
    choose('first.txt');choose('second.txt');
    const dropped=new DataTransfer();dropped.items.add(new File(['third'],'third.txt',{type:'text/plain'}));zone.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dropped}));
    let keyboardClicks=0;input.click=()=>{keyboardClicks++};zone.focus();zone.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    return {files:document.querySelectorAll('#fileList .file-item').length,summary:document.querySelector('#selectionSummary')?.textContent,keyboardClicks,focused:document.activeElement===zone};
  })()`);
  if (uploadUx.files !== 3 || !uploadUx.summary.includes("3") || uploadUx.keyboardClicks !== 1 || !uploadUx.focused) {
    throw new Error(`upload interactions regressed: ${JSON.stringify(uploadUx)}`);
  }
  await navigate("/content.html", 834, 1112, "content-tablet");
  await navigate("/content.html", 390, 844, "content-mobile");
  await navigate(`/teacher.html?view=review&queue=content&pipeline=${encodeURIComponent(pipelineRef)}`, 1440, 900, "review-scoped-desktop");
  const scopedReview = await evaluate(`(() => ({scopeVisible:!document.querySelector('#reviewScope')?.hidden,count:document.querySelector('#reviewCount')?.textContent||''}))()`);
  if (!scopedReview.scopeVisible || !scopedReview.count.includes("114")) throw new Error(`scoped review did not persist: ${JSON.stringify(scopedReview)}`);
  await navigate(`/agent-session.html?ref=${encodeURIComponent(sessionRef)}`, 1440, 900, "session-desktop");
  const sessionUsage = await evaluate(`(() => ({tokens:document.querySelector('#factTokens')?.textContent||'',cache:document.querySelector('#factCache')?.textContent||'',title:document.querySelector('#factCache')?.title||''}))()`);
  if (!/[0-9]/.test(sessionUsage.tokens) || !/^\d+%$/.test(sessionUsage.cache) || !sessionUsage.title.includes("已复用")) {
    throw new Error(`session usage summary is incomplete: ${JSON.stringify(sessionUsage)}`);
  }
  await navigate(`/agent-session.html?ref=${encodeURIComponent(sessionRef)}`, 834, 1112, "session-tablet");
  await navigate(`/agent-session.html?ref=${encodeURIComponent(sessionRef)}`, 390, 844, "session-mobile");
  const mobileSessionFlow = await evaluate(`(() => {
    const stream=document.querySelector('.chat-stream');
    const composer=document.querySelector('.chat-composer')?.getBoundingClientRect();
    const nav=document.querySelector('.mobile-nav')?.getBoundingClientRect();
    return {
      clientHeight:stream?.clientHeight||0,
      scrollHeight:stream?.scrollHeight||0,
      pageHeight:document.documentElement.scrollHeight,
      composerClear: Boolean(composer && nav && composer.bottom <= nav.top)
    };
  })()`);
  if (mobileSessionFlow.clientHeight < 300 || mobileSessionFlow.scrollHeight <= mobileSessionFlow.clientHeight || mobileSessionFlow.pageHeight > 2600 || !mobileSessionFlow.composerClear) {
    throw new Error(`mobile session is not contained as a chatbox: ${JSON.stringify(mobileSessionFlow)}`);
  }
  await navigate("/admin.html?view=students", 1440, 900, "teacher-students-desktop");
  await navigate("/admin.html?view=students", 390, 844, "teacher-students-mobile");
  await navigate("/admin.html?view=settings", 834, 1112, "teacher-settings-tablet");

  const neutralLoaded = client.event("Page.loadEventFired");
  await client.send("Page.navigate", { url: `${origin}/favicon.svg` });
  await neutralLoaded;
  const signOut = await evaluate(`fetch('/api/auth/sign-out', {method:'POST'}).then(r => ({ok:r.ok,status:r.status}))`);
  if (!signOut.ok) throw new Error(`sign out failed: ${signOut.status}`);
  await signIn(studentEmail, studentPassword);
  await navigate("/index.html", 1440, 900, "student-home-desktop");
  await navigate("/index.html", 834, 1112, "student-home-tablet");
  await navigate("/index.html", 390, 844, "student-home-mobile");
  await navigate("/solve.html", 1440, 900, "student-ask-desktop");
  await navigate("/solve.html", 390, 844, "student-ask-mobile");
  const mobileSolveFlow = await evaluate(`(() => {
    const spine=document.querySelector('#stateSpine');
    return {visible:Boolean(spine),clientWidth:spine?.clientWidth||0,scrollWidth:spine?.scrollWidth||0};
  })()`);
  if (!mobileSolveFlow.visible || mobileSolveFlow.scrollWidth > mobileSolveFlow.clientWidth + 1) {
    throw new Error(`mobile solve progress is clipped: ${JSON.stringify(mobileSolveFlow)}`);
  }
  await navigate("/profile.html", 1440, 900, "student-profile-desktop");
  await navigate("/profile.html", 390, 844, "student-profile-mobile");
  await navigate("/report.html", 1440, 900, "student-report-desktop");
  await navigate("/report.html", 834, 1112, "student-report-tablet");
  await navigate("/report.html", 390, 844, "student-report-mobile");

  const expectedEmptyResource = (event) => event.method === "Log.entryAdded"
    && event.params?.entry?.level === "error"
    && event.params?.entry?.text?.includes("404")
    && /\/api\/students\/[^/]+\/(profile|plans)$/.test(event.params?.entry?.url ?? "");
  const expectedRateLimit = (event) => event.method === "Log.entryAdded"
    && event.params?.entry?.level === "error"
    && event.params?.entry?.text?.includes("429")
    && event.params?.entry?.url?.endsWith("/api/auth/sign-in/email");
  // 角色切换时临时导航到 SVG 以销毁旧页轮询；Chromium 会为该图片文档额外探测传统 favicon.ico。
  const expectedNeutralFavicon = (event) => event.method === "Log.entryAdded"
    && event.params?.entry?.text?.includes("404")
    && event.params?.entry?.url?.endsWith("/favicon.ico");
  const failures = client.events.filter((event) => !expectedEmptyResource(event) && !expectedRateLimit(event) && !expectedNeutralFavicon(event) && (
    event.method === "Runtime.exceptionThrown"
    || (event.method === "Log.entryAdded" && ["error", "warning"].includes(event.params?.entry?.level))
  ));
  if (failures.length) throw new Error(`browser errors: ${JSON.stringify(failures.slice(0, 5))}`);
  client.close();
}

try {
  await main();
  console.log("BROWSER VISUAL SMOKE PASS");
} finally {
  chrome.kill("SIGTERM");
}
