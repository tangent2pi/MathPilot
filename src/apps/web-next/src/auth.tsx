"use client";

import { createAuthClient } from "better-auth/react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export const AUTH_DRAFT_KEY = "mathpilot:pending-auth-draft";

export const authClient = createAuthClient({ baseURL: window.location.origin, basePath: "/api/auth" });

export interface AuthPrincipal {
  uid: string;
  tenantId: string;
  roles: string[];
  name: string;
  email: string;
}

interface AuthContextValue {
  principal: AuthPrincipal | null;
  loading: boolean;
  requireAuth: (draft?: string, mode?: "login" | "register") => void;
  refreshAccount: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const session = authClient.useSession();
  const [principal, setPrincipal] = useState<AuthPrincipal | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [mode, setMode] = useState<"login" | "register">("login");

  useEffect(() => {
    if (!session.data?.user) {
      setPrincipal(null);
      setProfileLoading(false);
      return;
    }
    const authUser = session.data.user;
    const controller = new AbortController();
    setProfileLoading(true);
    void fetch("/api/me", { credentials: "include", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("无法读取当前账户");
        return response.json() as Promise<{ uid: string; tenant_id: string; roles: string[]; name: string; email: string }>;
      })
      .then((profile) => setPrincipal({
        uid: profile.uid,
        tenantId: profile.tenant_id,
        roles: profile.roles,
        name: profile.name || authUser.name || profile.email,
        email: profile.email,
      }))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setPrincipal(null);
      })
      .finally(() => setProfileLoading(false));
    return () => controller.abort();
  }, [session.data?.user]);

  const requireAuth = useCallback((draft?: string, nextMode: "login" | "register" = "login") => {
    if (draft?.trim()) sessionStorage.setItem(AUTH_DRAFT_KEY, draft);
    setMode(nextMode);
    setDialogOpen(true);
  }, []);

  const signOut = useCallback(async () => {
    await authClient.signOut();
    setPrincipal(null);
    await session.refetch();
  }, [session]);

  const refreshAccount = useCallback(async () => {
    await session.refetch();
  }, [session]);

  const value = useMemo<AuthContextValue>(() => ({
    principal,
    loading: session.isPending || profileLoading,
    requireAuth,
    refreshAccount,
    signOut,
  }), [principal, session.isPending, profileLoading, requireAuth, refreshAccount, signOut]);

  return (
    <AuthContext.Provider value={value}>
      {children}
      <AuthDialog
        open={dialogOpen}
        mode={mode}
        onModeChange={setMode}
        onOpenChange={setDialogOpen}
        onAuthenticated={async () => {
          await session.refetch();
          setDialogOpen(false);
        }}
      />
    </AuthContext.Provider>
  );
}

function AuthDialog({
  open,
  mode,
  onModeChange,
  onOpenChange,
  onAuthenticated,
}: {
  open: boolean;
  mode: "login" | "register";
  onModeChange: (mode: "login" | "register") => void;
  onOpenChange: (open: boolean) => void;
  onAuthenticated: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const result = mode === "login"
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email({ email, password, name: name.trim() || email.split("@")[0] || "学习者" });
      if (result.error) throw new Error(result.error.message || "认证失败");
      await onAuthenticated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "认证失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === "login" ? "登录数学智元" : "创建学习账户"}</DialogTitle>
          <DialogDescription>登录后才会创建正式 Pi 学习线程；当前输入会保留。</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={submit}>
          {mode === "register" && (
            <Input aria-label="姓名" autoComplete="name" placeholder="姓名" value={name} onChange={(event) => setName(event.target.value)} />
          )}
          <Input required aria-label="邮箱" autoComplete="email" type="email" placeholder="邮箱" value={email} onChange={(event) => setEmail(event.target.value)} />
          <Input required minLength={8} aria-label="密码" autoComplete={mode === "login" ? "current-password" : "new-password"} type="password" placeholder="密码（至少 8 位）" value={password} onChange={(event) => setPassword(event.target.value)} />
          {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
          <Button className="w-full" disabled={submitting} type="submit">
            {submitting ? "请稍候…" : mode === "login" ? "登录" : "注册"}
          </Button>
          <Button className="w-full" variant="ghost" type="button" onClick={() => onModeChange(mode === "login" ? "register" : "login") }>
            {mode === "login" ? "没有账户？注册" : "已有账户？登录"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
