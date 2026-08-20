import { hasRole, isTeacher, type Principal } from "./types";

const SHARED_PATHS = ["/account", "/report"];
const STUDENT_PATHS = ["/", "/profile", "/solve", "/ask"];
const TEACHER_PATHS = ["/teacher", "/content", "/review", "/library", "/agent-session"];

function isAtOrBelow(pathname: string, base: string): boolean {
  return pathname === base || (base !== "/" && pathname.startsWith(`${base}/`));
}

function internalDestination(next: string | null | undefined): { pathname: string; destination: string } | null {
  if (!next?.startsWith("/") || next.startsWith("//")) return null;
  try {
    const base = "https://mathpilot.local";
    const parsed = new URL(next, base);
    if (parsed.origin !== base) return null;
    return { pathname: parsed.pathname, destination: `${parsed.pathname}${parsed.search}${parsed.hash}` };
  } catch {
    return null;
  }
}

export function workspaceHome(principal: Principal | null | undefined): "/" | "/teacher" {
  return isTeacher(principal) ? "/teacher" : "/";
}

export function postLoginDestination(
  principal: Principal | null | undefined,
  next: string | null | undefined,
  options: { signedOut?: boolean } = {},
): string {
  const fallback = workspaceHome(principal);
  if (options.signedOut) return fallback;

  const candidate = internalDestination(next);
  if (!candidate) return fallback;
  if (SHARED_PATHS.some((path) => isAtOrBelow(candidate.pathname, path))) return candidate.destination;

  if (isTeacher(principal)) {
    if (TEACHER_PATHS.some((path) => isAtOrBelow(candidate.pathname, path))) return candidate.destination;
    if (candidate.pathname === "/admin" && principal && hasRole(principal, ["teacher"])) return candidate.destination;
    return fallback;
  }

  return STUDENT_PATHS.some((path) => isAtOrBelow(candidate.pathname, path))
    ? candidate.destination
    : fallback;
}
