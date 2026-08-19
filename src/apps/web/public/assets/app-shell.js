import { authClient } from "/assets/auth-client.js";

export const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g,
  (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

const STUDENT_NAV = [
  { href: "/", label: "学习", short: "学习", icon: "home", hint: "今天从这里开始" },
  { href: "/solve.html", label: "练习", short: "练习", icon: "pencil", hint: "完成一道题" },
  { href: "/report.html", label: "报告", short: "报告", icon: "report", hint: "查看学习变化" },
  { href: "/profile.html", label: "我的", short: "我的", icon: "profile", hint: "学习设置" },
];

const TEACHER_NAV = [
  { href: "/teacher.html", label: "工作台", short: "工作台", icon: "home", hint: "查看待处理事项" },
  { href: "/content.html", label: "内容", short: "内容", icon: "content", hint: "整理教学资料" },
  { href: "/admin.html?view=students", label: "学生", short: "学生", icon: "students", hint: "跟进学习进度" },
  { href: "/admin.html?view=settings", label: "设置", short: "设置", icon: "settings", hint: "工作区设置" },
];

const NAV_ICONS = {
  home: '<svg viewBox="0 0 24 24" focusable="false"><path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10M9 20v-6h6v6"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" focusable="false"><path d="m4 20 4.2-1 10.9-10.9a2.1 2.1 0 0 0-3-3L5.2 16Z"/><path d="m14.5 6.5 3 3M4 20h5"/></svg>',
  report: '<svg viewBox="0 0 24 24" focusable="false"><path d="M12 3a9 9 0 1 0 9 9h-9Z"/><path d="M15 3.5A8.5 8.5 0 0 1 20.5 9H15Z"/></svg>',
  profile: '<svg viewBox="0 0 24 24" focusable="false"><circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/></svg>',
  content: '<svg viewBox="0 0 24 24" focusable="false"><path d="M5 4h14v16H5Z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
  students: '<svg viewBox="0 0 24 24" focusable="false"><circle cx="9" cy="8" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 5.5a3 3 0 0 1 0 5.8M16.5 14a5 5 0 0 1 4 5"/></svg>',
  settings: '<svg viewBox="0 0 24 24" focusable="false"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.8 1.8 0 0 0 .4 2l.1.1-2.8 2.8-.1-.1a1.8 1.8 0 0 0-2-.4 1.8 1.8 0 0 0-1.1 1.6v.2H10V21a1.8 1.8 0 0 0-1.1-1.6 1.8 1.8 0 0 0-2 .4l-.1.1L4 17.1l.1-.1a1.8 1.8 0 0 0 .4-2A1.8 1.8 0 0 0 3 14H2.8v-4H3a1.8 1.8 0 0 0 1.6-1.1 1.8 1.8 0 0 0-.4-2L4 6.8 6.8 4l.1.1a1.8 1.8 0 0 0 2 .4A1.8 1.8 0 0 0 10 3V2.8h4V3a1.8 1.8 0 0 0 1.1 1.6 1.8 1.8 0 0 0 2-.4l.1-.1L20 6.9l-.1.1a1.8 1.8 0 0 0-.4 2A1.8 1.8 0 0 0 21 10h.2v4H21a1.8 1.8 0 0 0-1.6 1Z"/></svg>',
};

function currentPath() {
  return location.pathname === "/index.html" ? "/" : location.pathname;
}

function isTeacher(principal) {
  return principal?.roles?.some((role) => ["teacher", "content_reviewer", "tenant_admin"].includes(role));
}

function navIsCurrent(item) {
  if (currentPath() === "/agent-session.html" && item.href === "/content.html") return true;
  if (item.href.includes("?")) {
    const [path, query] = item.href.split("?");
    if (currentPath() !== path) return false;
    const expected = new URLSearchParams(query).get("view");
    return new URLSearchParams(location.search).get("view") === expected;
  }
  return currentPath() === item.href && !(item.href === "/admin.html" && location.search);
}

function navLink(item, compact = false) {
  const current = navIsCurrent(item);
  return `<a class="${compact ? "mobile-nav-link" : "side-nav-link"}" href="${item.href}"${current ? ' aria-current="page"' : ""}>
    <span class="nav-glyph" aria-hidden="true">${NAV_ICONS[item.icon] ?? ""}</span>
    <span class="nav-link-copy"><strong>${item.label}</strong><small>${item.hint}</small></span>
  </a>`;
}

function pageName() {
  const explicit = document.body.dataset.pageTitle;
  if (explicit) return explicit;
  return [...STUDENT_NAV, ...TEACHER_NAV].find((item) => navIsCurrent(item))?.label ?? "学习空间";
}

function renderShell(user, principal) {
  const host = document.querySelector("[data-app-shell]");
  if (!host) return;
  document.querySelector("main")?.setAttribute("id", "main-content");
  const teacher = isTeacher(principal);
  const items = teacher ? TEACHER_NAV : STUDENT_NAV;
  const name = user?.name || user?.email || "账户";
  const initial = name.trim().slice(0, 1).toUpperCase() || "A";
  const role = teacher ? "教师空间" : "学生空间";
  host.className = "app-header";
  host.innerHTML = `
    <a class="skip-link" href="#main-content">跳到主要内容</a>
    <div class="app-header-inner">
      <a class="app-brand" href="${teacher ? "/teacher.html" : "/"}" aria-label="AGMATH ${role}">
        <span class="app-brand-mark" aria-hidden="true">∴</span>
        <span class="app-brand-word">AGMATH</span>
      </a>
      <div class="topbar-context"><span class="topbar-kicker">${role}</span><strong>${escapeHtml(pageName())}</strong></div>
      <div class="topbar-spacer"></div>
      <div class="app-account" id="authIdentity">
        <button class="account-trigger" id="accountTrigger" type="button" aria-expanded="false" aria-controls="accountMenu">
          <span class="account-avatar" aria-hidden="true">${escapeHtml(initial)}</span>
          <span class="account-copy"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(teacher ? "教师" : "学生")}</small></span>
          <span class="account-chevron" aria-hidden="true">⌄</span>
        </button>
        <div class="account-menu" id="accountMenu" hidden>
          <div class="account-menu-heading">${escapeHtml(name)}<small>${escapeHtml(principal?.email || "")}</small></div>
          <a href="${teacher ? "/admin.html?view=settings" : "/profile.html"}">账户设置</a>
          <button type="button" id="authSignOut">退出登录</button>
        </div>
      </div>
    </div>`;

  document.querySelector("[data-side-nav]")?.remove();
  const side = document.createElement("aside");
  side.className = "side-nav";
  side.dataset.sideNav = "";
  side.setAttribute("aria-label", "主导航");
  side.innerHTML = `<div class="side-nav-inner"><p class="side-nav-label">${role}</p><nav>${items.map((item) => navLink(item)).join("")}</nav><div class="side-nav-footer"><span class="status-pip"></span><span>学习空间已连接</span></div></div>`;
  document.body.insertBefore(side, document.querySelector("main"));

  document.querySelector("[data-mobile-nav]")?.remove();
  const mobile = document.createElement("nav");
  mobile.className = "mobile-nav";
  mobile.dataset.mobileNav = "";
  mobile.setAttribute("aria-label", "移动端主导航");
  mobile.innerHTML = items.map((item) => navLink(item, true)).join("");
  document.body.append(mobile);

  const trigger = document.getElementById("accountTrigger");
  const menu = document.getElementById("accountMenu");
  let menuTimer = 0;
  const setMenuOpen = (open) => {
    if (!trigger || !menu) return;
    clearTimeout(menuTimer);
    trigger.setAttribute("aria-expanded", String(open));
    if (open) {
      menu.hidden = false;
      menu.dataset.state = "opening";
      requestAnimationFrame(() => { menu.dataset.state = "open"; });
      return;
    }
    if (menu.hidden) return;
    menu.dataset.state = "closing";
    menuTimer = window.setTimeout(() => {
      menu.hidden = true;
      menu.dataset.state = "closed";
    }, 120);
  };
  trigger?.addEventListener("click", () => {
    setMenuOpen(menu.hidden || menu.dataset.state === "closing");
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".app-account") && menu && !menu.hidden) {
      setMenuOpen(false);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menu && !menu.hidden) {
      setMenuOpen(false);
      trigger?.focus();
    }
  });
  document.getElementById("authSignOut")?.addEventListener("click", async () => {
    await authClient.signOut();
    location.href = "/login.html";
  });
}

export async function requirePrincipal(requiredRoles = []) {
  const sessionResult = await authClient.getSession();
  if (!sessionResult.data?.user) {
    location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new Error("authentication required");
  }
  const response = await fetch("/api/me", { credentials: "include", cache: "no-store" });
  if (!response.ok) {
    await authClient.signOut();
    location.href = "/login.html";
    throw new Error("session rejected");
  }
  const principal = await response.json();
  if (requiredRoles.length && !requiredRoles.some((role) => principal.roles.includes(role) || principal.roles.includes("tenant_admin"))) {
    location.href = "/?forbidden=1";
    throw new Error("forbidden");
  }
  renderShell(sessionResult.data.user, principal);
  document.querySelectorAll("[data-role]").forEach((node) => {
    const allowed = node.dataset.role.split(",");
    node.hidden = !allowed.some((role) => principal.roles.includes(role) || principal.roles.includes("tenant_admin"));
  });
  return principal;
}

export function apiFetch(url, init = {}) { return fetch(url, { ...init, credentials: "include" }); }

export function setStatus(node, message, kind = "") {
  if (!node) return;
  node.hidden = !message;
  node.className = `status-note ${kind}`.trim();
  node.textContent = message || "";
}

export function formatDate(value, fallback = "—") {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}

export { authClient };
