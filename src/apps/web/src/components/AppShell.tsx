import {
  BookOpenText,
  ChevronDown,
  Home,
  LogOut,
  PencilLine,
  PieChart,
  Settings,
  UserRound,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { isTeacher } from "../lib/types";
import { PRODUCT_NAME } from "../lib/brand";
import { useAuth } from "../app/auth";
import { Brand } from "./Brand";
import { PageTransition } from "./PageTransition";

type NavItem = {
  to: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  match?: (location: ReturnType<typeof useLocation>) => boolean;
};

const studentNav: NavItem[] = [
  { to: "/", label: "学习", hint: "今天从这里开始", icon: Home },
  { to: "/solve", label: "练习", hint: "完成一道题", icon: PencilLine },
  { to: "/report", label: "报告", hint: "查看学习变化", icon: PieChart },
  { to: "/profile", label: "我的", hint: "学习设置", icon: UserRound },
];

const teacherNav: NavItem[] = [
  { to: "/teacher", label: "工作台", hint: "查看待处理事项", icon: Home },
  { to: "/content", label: "内容", hint: "整理教学资料", icon: BookOpenText, match: (l) => ["/content", "/review", "/agent-session"].includes(l.pathname) || l.pathname.startsWith("/library") },
  { to: "/admin?view=students", label: "学生", hint: "跟进学习进度", icon: UsersRound, match: (l) => l.pathname === "/admin" && new URLSearchParams(l.search).get("view") !== "settings" },
  { to: "/admin?view=settings", label: "设置", hint: "工作区设置", icon: Settings, match: (l) => l.pathname === "/admin" && new URLSearchParams(l.search).get("view") === "settings" },
];

const routeTitles: Record<string, string> = {
  "/": "学习",
  "/solve": "练习",
  "/ask": "向 AI 提问",
  "/report": "报告",
  "/profile": "我的",
  "/account": "账户设置",
  "/teacher": "教师工作台",
  "/content": "内容工坊",
  "/review": "内容复核",
  "/library": "已发布内容",
  "/agent-session": "处理对话",
  "/admin": "学生",
};

function ShellNavLink({ item, compact = false }: { item: NavItem; compact?: boolean }) {
  const location = useLocation();
  const current = item.match ? item.match(location) : location.pathname === item.to;
  const destination = current && item.to === "/solve" ? `${location.pathname}${location.search}` : item.to;
  const Icon = item.icon;
  return (
    <Link className={compact ? "mobile-nav-link" : "side-nav-link"} to={destination} aria-current={current ? "page" : undefined}>
      <span className="nav-glyph" aria-hidden="true"><Icon /></span>
      <span className="nav-link-copy"><strong>{item.label}</strong><small>{item.hint}</small></span>
    </Link>
  );
}

function TopNavLink({ item }: { item: NavItem }) {
  const location = useLocation();
  const current = item.match ? item.match(location) : location.pathname === item.to;
  const destination = current && item.to === "/solve" ? `${location.pathname}${location.search}` : item.to;
  const Icon = item.icon;
  return <Link className="top-nav-link" to={destination} aria-current={current ? "page" : undefined}>
    <Icon aria-hidden="true" /><span>{item.label}</span>
  </Link>;
}

export function AppShell() {
  const { state: { principal, user }, signOut } = useAuth();
  const teacher = isTeacher(principal);
  const items = teacher ? teacherNav : studentNav;
  const role = teacher ? "教师空间" : "学生空间";
  const location = useLocation();
  const navigate = useNavigate();
  const reduced = useReducedMotion();
  const [menuOpen, setMenuOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const name = user.name || user.email || "账户";
  const initial = name.trim().slice(0, 1).toUpperCase() || "A";
  const pageTitle = location.pathname.startsWith("/library/")
    ? "内容详细信息"
    : location.pathname === "/admin" && new URLSearchParams(location.search).get("view") === "settings"
    ? "设置"
    : routeTitles[location.pathname] ?? "学习空间";

  useEffect(() => {
    document.title = `${pageTitle} · ${PRODUCT_NAME}`;
    setMenuOpen(false);
  }, [pageTitle]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [location.pathname]);

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (!accountRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const leave = async () => {
    await signOut();
    navigate("/login?signed_out=1", { replace: true });
  };

  return (
    <>
      <header className="app-header" aria-label="应用顶栏">
        <a className="skip-link" href="#main-content">跳到主要内容</a>
        <div className="app-header-inner">
          <Brand to={teacher ? "/teacher" : "/"} role={role} />
          <div className="topbar-context"><span className="topbar-kicker">{role}</span><strong>{pageTitle}</strong></div>
          <nav className="top-nav" aria-label="主导航">{items.map((item) => <TopNavLink key={item.to} item={item} />)}</nav>
          <div className="app-account" ref={accountRef}>
            <button className="account-trigger" type="button" aria-expanded={menuOpen} aria-controls="account-menu" onClick={() => setMenuOpen((value) => !value)}>
              <span className="account-avatar" aria-hidden="true">{user.image ? <img src={user.image} alt="" /> : initial}</span>
              <span className="account-copy"><strong>{name}</strong><small>{teacher ? "教师" : "学生"}</small></span>
              <ChevronDown className="account-chevron" aria-hidden="true" />
            </button>
            <AnimatePresence>
              {menuOpen && (
                <motion.div
                  className="account-menu react-menu"
                  id="account-menu"
                  initial={reduced ? false : { opacity: 0, scale: 0.94, y: -4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: -2 }}
                  transition={{ duration: reduced ? 0 : 0.16, ease: [0.22, 1, 0.36, 1] }}
                >
                  <div className="account-menu-heading">{name}<small>{principal.email}</small></div>
                  <Link to="/account">账户设置</Link>
                  <button type="button" onClick={leave}><LogOut aria-hidden="true" />退出登录</button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </header>

      <PageTransition />

      <nav className="mobile-nav" aria-label="移动端主导航">
        {items.map((item) => <ShellNavLink key={item.to} item={item} compact />)}
      </nav>
    </>
  );
}
