import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, type PropsWithChildren } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { authClient } from "../lib/auth-client";
import { apiFetch } from "../lib/api";
import type { AuthState, Principal, SessionUser } from "../lib/types";
import { hasRole } from "../lib/types";
import { AppLoading } from "../components/feedback/AppLoading";

type AuthContextValue = {
  state: AuthState;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

async function getAuthState(): Promise<AuthState | null> {
  const result = await authClient.getSession();
  const user = result.data?.user as SessionUser | undefined;
  if (!user) return null;
  try {
    const principal = await apiFetch<Principal>("/api/me", { cache: "no-store" });
    return { principal, user };
  } catch {
    await authClient.signOut();
    return null;
  }
}

export function useAuthQuery() {
  return useQuery({
    queryKey: ["auth", "principal"],
    queryFn: getAuthState,
    staleTime: 60_000,
    retry: false,
  });
}

export function RequireAuth({ children, roles = [] }: PropsWithChildren<{ roles?: string[] }>) {
  const location = useLocation();
  const queryClient = useQueryClient();
  const auth = useAuthQuery();

  if (auth.isPending) return <AppLoading label="正在打开学习空间" />;
  if (!auth.data) {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  if (roles.length && !hasRole(auth.data.principal, roles)) return <Navigate to="/?forbidden=1" replace />;

  const signOut = async () => {
    await authClient.signOut();
    queryClient.setQueryData(["auth", "principal"], null);
  };
  return <AuthContext.Provider value={{ state: auth.data, signOut }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be rendered inside RequireAuth");
  return value;
}
