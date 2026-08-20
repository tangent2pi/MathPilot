import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Outlet, createBrowserRouter, useLocation } from "react-router-dom";
import { RequireAuth, useAuth } from "./auth";
import { AppShell } from "../components/AppShell";
import { AppLoading } from "../components/feedback/AppLoading";
import { workspaceHome } from "../lib/auth-routing";
import { hasRole, isTeacher } from "../lib/types";

const LoginPage = lazy(() => import("../pages/LoginPage").then((module) => ({ default: module.LoginPage })));
const HomePage = lazy(() => import("../pages/HomePage").then((module) => ({ default: module.HomePage })));
const ProfilePage = lazy(() => import("../pages/ProfilePage").then((module) => ({ default: module.ProfilePage })));
const AccountPage = lazy(() => import("../pages/AccountPage").then((module) => ({ default: module.AccountPage })));
const ReportPage = lazy(() => import("../pages/ReportPage").then((module) => ({ default: module.ReportPage })));
const SolvePage = lazy(() => import("../pages/SolvePage").then((module) => ({ default: module.SolvePage })));
const AskPage = lazy(() => import("../pages/AskPage").then((module) => ({ default: module.AskPage })));
const TeacherPage = lazy(() => import("../pages/TeacherPage").then((module) => ({ default: module.TeacherPage })));
const ContentPage = lazy(() => import("../pages/ContentPage").then((module) => ({ default: module.ContentPage })));
const ReviewPage = lazy(() => import("../pages/ReviewPage").then((module) => ({ default: module.ReviewPage })));
const PublishedLibraryPage = lazy(() => import("../pages/PublishedLibraryPage").then((module) => ({ default: module.PublishedLibraryPage })));
const PublishedContentDetailPage = lazy(() => import("../pages/PublishedContentDetailPage").then((module) => ({ default: module.PublishedContentDetailPage })));
const AgentSessionPage = lazy(() => import("../pages/AgentSessionPage").then((module) => ({ default: module.AgentSessionPage })));
const AdminPage = lazy(() => import("../pages/AdminPage").then((module) => ({ default: module.AdminPage })));
const NotFoundPage = lazy(() => import("../pages/NotFoundPage").then((module) => ({ default: module.NotFoundPage })));

function Load({ children }: { children: ReactNode }) {
  return <Suspense fallback={<AppLoading label="正在打开页面" />}>{children}</Suspense>;
}

function ProtectedShell() {
  return <RequireAuth><AppShell /></RequireAuth>;
}

function WorkspaceHome() {
  const { state: { principal } } = useAuth();
  return workspaceHome(principal) === "/teacher"
    ? <Navigate to="/teacher" replace />
    : <Load><HomePage /></Load>;
}

function RoleGate({ roles, children }: { roles: string[]; children: ReactNode }) {
  const { state: { principal } } = useAuth();
  return hasRole(principal, roles) ? children : <Navigate to={isTeacher(principal) ? "/teacher?forbidden=1" : "/?forbidden=1"} replace />;
}

function LegacyRedirect({ to }: { to: string }) {
  const location = useLocation();
  return <Navigate to={`${to}${location.search}`} replace />;
}

export const router = createBrowserRouter([
  { path: "/login", element: <Load><LoginPage /></Load> },
  { path: "/login.html", element: <LegacyRedirect to="/login" /> },
  {
    element: <ProtectedShell />,
    children: [
      { index: true, element: <WorkspaceHome /> },
      { path: "index.html", element: <LegacyRedirect to="/" /> },
      { path: "profile", element: <Load><ProfilePage /></Load> },
      { path: "account", element: <Load><AccountPage /></Load> },
      { path: "profile.html", element: <LegacyRedirect to="/profile" /> },
      { path: "report", element: <Load><ReportPage /></Load> },
      { path: "report.html", element: <LegacyRedirect to="/report" /> },
      { path: "solve", element: <Load><SolvePage /></Load> },
      { path: "solve.html", element: <LegacyRedirect to="/solve" /> },
      { path: "ask", element: <Load><AskPage /></Load> },
      { path: "teacher", element: <RoleGate roles={["teacher", "content_reviewer"]}><Load><TeacherPage /></Load></RoleGate> },
      { path: "teacher.html", element: <LegacyRedirect to="/teacher" /> },
      { path: "content", element: <RoleGate roles={["teacher", "content_reviewer"]}><Load><ContentPage /></Load></RoleGate> },
      { path: "content.html", element: <LegacyRedirect to="/content" /> },
      { path: "review", element: <RoleGate roles={["teacher", "content_reviewer"]}><Load><ReviewPage /></Load></RoleGate> },
      { path: "library", element: <RoleGate roles={["teacher", "content_reviewer"]}><Load><PublishedLibraryPage /></Load></RoleGate> },
      { path: "library/:packageId/:type/:id", element: <RoleGate roles={["teacher", "content_reviewer"]}><Load><PublishedContentDetailPage /></Load></RoleGate> },
      { path: "agent-session", element: <RoleGate roles={["teacher", "content_reviewer"]}><Load><AgentSessionPage /></Load></RoleGate> },
      { path: "agent-session.html", element: <LegacyRedirect to="/agent-session" /> },
      { path: "admin", element: <RoleGate roles={["teacher"]}><Load><AdminPage /></Load></RoleGate> },
      { path: "admin.html", element: <LegacyRedirect to="/admin" /> },
      { path: "*", element: <Load><NotFoundPage /></Load> },
    ],
  },
]);
