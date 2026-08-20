import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Eye, EyeOff } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useAuthQuery } from "../app/auth";
import { Brand } from "../components/Brand";
import { AsyncButton } from "../components/feedback/AsyncButton";
import { authClient } from "../lib/auth-client";
import { apiFetch } from "../lib/api";
import { isTeacher, type Principal } from "../lib/types";

export function LoginPage() {
  const auth = useAuthQuery();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const reduced = useReducedMotion();
  const [signup, setSignup] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => { document.title = "登录 · AGMATH"; }, []);
  if (auth.data) return <Navigate to={isTeacher(auth.data.principal) ? "/teacher" : "/"} replace />;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage("");
    setPending(true);
    const result = signup
      ? await authClient.signUp.email({ email: email.trim(), password, name: name.trim() })
      : await authClient.signIn.email({ email: email.trim(), password });
    if (result.error) {
      setMessage(result.error.message || "认证失败，请检查输入后重试。");
      setPending(false);
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ["auth", "principal"] });
    const principal = await apiFetch<Principal>("/api/me").catch(() => null);
    const next = params.get("next");
    if (next?.startsWith("/") && !next.startsWith("//")) navigate(next, { replace: true });
    else navigate(isTeacher(principal) ? "/teacher" : "/", { replace: true });
  };

  return (
    <main className="auth-page" id="main-content">
      <section className="auth-story" aria-label="产品说明">
        <div><p className="eyebrow">从学习过程出发</p><h1>先看你怎样思考，<br />再谈掌握与否。</h1><p>AGMATH 把每次作答、提示和修正整理为可追溯证据，给学生下一步，也给教师复核入口。</p></div>
      </section>
      <section className="auth-side">
        <div className="auth-card">
          <Brand />
          <p className="eyebrow auth-eyebrow">欢迎回来</p>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={signup ? "signup" : "login"} initial={reduced ? false : { opacity: 0, x: signup ? 8 : -8 }} animate={{ opacity: 1, x: 0 }} exit={reduced ? { opacity: 0 } : { opacity: 0, x: signup ? -8 : 8 }} transition={{ duration: reduced ? 0 : 0.16 }}>
              <h1>{signup ? "创建学生账号" : "登录"}</h1>
              <p className="muted">{signup ? "用一个账号保存你的学习过程。" : "继续你的学习证据，或进入教师工作台。"}</p>
            </motion.div>
          </AnimatePresence>
          <form onSubmit={submit} className={message ? "form-has-error" : ""}>
            <AnimatePresence initial={false}>
              {signup && <motion.label initial={reduced ? false : { opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }}>姓名<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required /></motion.label>}
            </AnimatePresence>
            <label>邮箱<input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="email" required /></label>
            <div className="field-group">
              <label htmlFor="auth-password">密码</label>
              <div className="password-control">
                <input id="auth-password" value={password} onChange={(e) => setPassword(e.target.value)} type={showPassword ? "text" : "password"} autoComplete={signup ? "new-password" : "current-password"} minLength={8} required />
                <button type="button" aria-label={showPassword ? "隐藏密码" : "显示密码"} aria-pressed={showPassword} onClick={() => setShowPassword((value) => !value)}>
                  {showPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                </button>
              </div>
            </div>
            <div className="action-cluster">
              <AsyncButton className="cinnabar" type="submit" pending={pending} pendingLabel={signup ? "正在创建…" : "正在登录…"}>{signup ? "注册并登录" : "登录"}</AsyncButton>
              <button className="btn ghost" type="button" onClick={() => { setSignup((v) => !v); setMessage(""); }}>{signup ? "已有账号" : "创建学生账号"}</button>
            </div>
          </form>
          <p className="error-text inline-error" role="alert">{message}</p>
        </div>
      </section>
    </main>
  );
}
