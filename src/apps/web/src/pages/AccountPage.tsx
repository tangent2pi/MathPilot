import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Camera, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../app/auth";
import { AsyncButton } from "../components/feedback/AsyncButton";
import { BackButton } from "../components/BackButton";
import { ImagePicker } from "../components/ImagePicker";
import { apiFetch, jsonBody } from "../lib/api";
import { authClient } from "../lib/auth-client";
import { isTeacher } from "../lib/types";

async function encodeFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = reject; reader.onload = () => resolve(String(reader.result).split(",")[1] || ""); reader.readAsDataURL(file); });
}

export function AccountPage() {
  const { state: { user, principal } } = useAuth();
  const queryClient = useQueryClient();
  const [name, setName] = useState(user.name || "");
  const [email, setEmail] = useState(user.email);
  const [phone, setPhone] = useState(user.phone || "");
  const [avatar, setAvatar] = useState<File[]>([]);
  const [feedback, setFeedback] = useState("");
  const [validationError, setValidationError] = useState(false);
  useEffect(() => { setName(user.name || ""); setEmail(user.email); setPhone(user.phone || ""); }, [user.email, user.name, user.phone]);
  const save = useMutation({
    mutationFn: async () => {
      let image: string | undefined;
      if (avatar[0]) {
        if (avatar[0].size > 1_572_864) throw new Error("头像文件不能超过 1.5 MiB。");
        const uploaded = await apiFetch<{ image: string }>("/api/account/avatar", { method: "POST", ...jsonBody({ mime_type: avatar[0].type, image_base64: await encodeFile(avatar[0]) }) });
        image = uploaded.image;
      }
      const profileResult = await authClient.updateUser({ name: name.trim(), phone: phone.trim(), ...(image ? { image } : {}) } as { name: string; phone: string; image?: string });
      if (profileResult.error) throw new Error(profileResult.error.message || "资料更新失败");
      if (email.trim().toLowerCase() !== user.email.toLowerCase()) {
        const emailResult = await authClient.changeEmail({ newEmail: email.trim(), callbackURL: "/account" });
        if (emailResult.error) throw new Error(emailResult.error.message || "邮箱更新失败");
      }
    },
    onSuccess: async () => { setAvatar([]); setValidationError(false); setFeedback("账户资料已更新。"); await queryClient.invalidateQueries({ queryKey: ["auth", "principal"] }); },
    onError: (error) => { setValidationError(false); setFeedback(error instanceof Error ? error.message : "账户资料更新失败。"); },
  });
  const removeAvatar = useMutation({
    mutationFn: async () => { await apiFetch("/api/account/avatar", { method: "DELETE" }); const result = await authClient.updateUser({ image: null }); if (result.error) throw new Error(result.error.message); },
    onSuccess: async () => { setFeedback("头像已移除。"); await queryClient.invalidateQueries({ queryKey: ["auth", "principal"] }); },
  });
  const submit = (event: FormEvent) => { event.preventDefault(); setFeedback(""); setValidationError(false); save.mutate(); };

  return <main className="page narrow page-stack" id="main-content">
    <BackButton fallback={isTeacher(principal) ? "/admin?view=settings" : "/profile"} />
    <section className="page-hero compact"><p className="eyebrow">账户设置</p><h1>管理个人资料</h1><p className="lede">更新头像、昵称、邮箱和联系电话。修改后的昵称和头像会显示在学习空间中。</p></section>
    <section className="section-card account-profile-card">
      <div className="account-avatar-editor"><div className="account-avatar-large">{user.image ? <img src={user.image} alt="当前头像" /> : <span>{(user.name || user.email).slice(0, 1).toUpperCase()}</span>}</div><div><h2>{user.name || "个人资料"}</h2><p className="muted">支持 PNG、JPEG、WebP，最大 1.5 MiB。</p>{user.image && <AsyncButton className="ghost" pending={removeAvatar.isPending} pendingLabel="正在移除…" onClick={() => removeAvatar.mutate()}><Trash2 aria-hidden="true" />移除当前头像</AsyncButton>}</div></div>
      <form className="account-profile-form" onSubmit={submit}>
        <ImagePicker files={avatar} onChange={(files) => { setAvatar(files); if (files.length) { setFeedback(""); setValidationError(false); } }} label="选择新头像" maxFiles={1} maxBytes={1_572_864} onReject={(message) => { setFeedback(message); setValidationError(true); }} />
        <div className="field-row"><label>昵称<input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoComplete="name" required /></label><label>联系电话<input value={phone} onChange={(event) => setPhone(event.target.value)} type="tel" maxLength={24} autoComplete="tel" placeholder="选填" /></label></div>
        <label>登录邮箱<input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" required /><small>未验证账号会立即更新；已验证账号会进入 Better Auth 的邮箱确认流程。</small></label>
        <div className="action-cluster"><AsyncButton className="cinnabar" type="submit" pending={save.isPending} pendingLabel="正在保存…"><Camera aria-hidden="true" />保存账户资料</AsyncButton></div>
        {feedback && <p className={`status-note ${validationError || save.isError || removeAvatar.isError ? "error" : "success"}`} aria-live="polite">{feedback}</p>}
      </form>
    </section>
  </main>;
}
