"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Camera, School, UserRound } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { authClient, type AuthPrincipal } from "./auth";
import {
  deleteStorageObject,
  storageUploadDeclaration,
  storageUploadFileTypes,
  uploadStorageObject,
} from "./storage-upload";

export type AccountPanel = "settings" | "help";
type SettingsSection = "profile" | "classes";

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    ...init,
    headers: init?.body ? { "content-type": "application/json", ...init.headers } : init?.headers,
  });
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `请求失败（${response.status}）`);
  return body;
}

export function AccountPanelDialog({
  panel,
  principal,
  avatarUrl,
  onOpenChange,
  onAvatarChange,
  onAccountChange,
}: {
  panel: AccountPanel | null;
  principal: AuthPrincipal;
  avatarUrl: string;
  onOpenChange: (open: boolean) => void;
  onAvatarChange: (url: string) => void;
  onAccountChange: () => Promise<void>;
}) {
  return (
    <Dialog open={panel !== null} onOpenChange={onOpenChange}>
      <DialogContent className={panel === "settings" ? "max-h-[88dvh] overflow-hidden sm:max-w-3xl" : "sm:max-w-lg"}>
        <DialogHeader>
          <DialogTitle>{panel === "help" ? "帮助" : "设置"}</DialogTitle>
          <DialogDescription>
            {panel === "help" ? "数学智元开发版使用说明。" : "管理个人资料、账户身份和班级关系。"}
          </DialogDescription>
        </DialogHeader>
        {panel === "settings" && (
          <SettingsPanel
            principal={principal}
            avatarUrl={avatarUrl}
            onAvatarChange={onAvatarChange}
            onAccountChange={onAccountChange}
          />
        )}
        {panel === "help" && <HelpPanel />}
      </DialogContent>
    </Dialog>
  );
}

function SettingsPanel({
  principal,
  avatarUrl,
  onAvatarChange,
  onAccountChange,
}: {
  principal: AuthPrincipal;
  avatarUrl: string;
  onAvatarChange: (url: string) => void;
  onAccountChange: () => Promise<void>;
}) {
  const [section, setSection] = useState<SettingsSection>("profile");
  const sections = [
    { id: "profile" as const, label: "个人资料", icon: UserRound },
    { id: "classes" as const, label: "班级与教师", icon: School },
  ];

  return (
    <div className="grid min-h-0 gap-5 overflow-y-auto md:grid-cols-[10rem_minmax(0,1fr)] md:overflow-hidden">
      <nav aria-label="设置子项" className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
        {sections.map((item) => (
          <Button
            key={item.id}
            type="button"
            variant={section === item.id ? "secondary" : "ghost"}
            className="min-h-10 shrink-0 justify-start"
            aria-current={section === item.id ? "page" : undefined}
            onClick={() => setSection(item.id)}
          >
            <item.icon aria-hidden="true" />
            {item.label}
          </Button>
        ))}
      </nav>
      <div className="min-w-0 md:max-h-[68dvh] md:overflow-y-auto md:pe-1">
        {section === "profile" ? (
          <ProfileSettings
            principal={principal}
            avatarUrl={avatarUrl}
            onAvatarChange={onAvatarChange}
            onAccountChange={onAccountChange}
          />
        ) : (
          <ClassesPanel principal={principal} />
        )}
      </div>
    </div>
  );
}

function ProfileSettings({
  principal,
  avatarUrl,
  onAvatarChange,
  onAccountChange,
}: {
  principal: AuthPrincipal;
  avatarUrl: string;
  onAvatarChange: (url: string) => void;
  onAccountChange: () => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [nickname, setNickname] = useState(principal.name);
  const [email, setEmail] = useState(principal.email);
  const [saving, setSaving] = useState<"avatar" | "nickname" | "email" | null>(null);
  const [feedback, setFeedback] = useState("");
  const initials = principal.name.trim().slice(0, 2).toUpperCase() || "MP";

  useEffect(() => setNickname(principal.name), [principal.name]);
  useEffect(() => setEmail(principal.email), [principal.email]);
  useEffect(() => {
    if (!file) {
      setPreviewUrl(undefined);
      return;
    }
    const next = URL.createObjectURL(file);
    setPreviewUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);

  const uploadAvatar = async () => {
    if (!file) return;
    setSaving("avatar");
    setFeedback("");
    let objectId: string | undefined;
    try {
      const object = await uploadStorageObject(file,"avatar");
      objectId=object.object_id;
      const result = await jsonFetch<{ image: string }>("/api/account/avatar", {
        method: "POST",
        body: JSON.stringify({ object_id:object.object_id }),
      });
      onAvatarChange(result.image);
      setFile(null);
      setFeedback("头像已更新");
    } catch (error) {
      if (objectId) await deleteStorageObject(objectId).catch(() => undefined);
      setFeedback(error instanceof Error ? error.message : "头像上传失败");
    } finally {
      setSaving(null);
    }
  };

  const selectAvatar = (next: File | null) => {
    if (!next) {
      setFile(null);
      return;
    }
    try {
      storageUploadDeclaration(next, "avatar");
      setFile(next);
      setFeedback("");
    } catch (error) {
      setFile(null);
      setFeedback(error instanceof Error ? error.message : "不支持这个头像文件");
    }
  };

  const removeAvatar = async () => {
    setSaving("avatar");
    setFeedback("");
    try {
      await jsonFetch("/api/account/avatar", { method: "DELETE" });
      setFile(null);
      onAvatarChange(`/api/account/avatar?v=${Date.now()}`);
      setFeedback("头像已移除");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法移除头像");
    } finally {
      setSaving(null);
    }
  };

  const saveNickname = async (event: FormEvent) => {
    event.preventDefault();
    const name = nickname.trim();
    if (!name) return;
    setSaving("nickname");
    setFeedback("");
    try {
      const result = await authClient.updateUser({ name });
      if (result.error) throw new Error(result.error.message || "昵称修改失败");
      await onAccountChange();
      setFeedback("昵称已更新");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "昵称修改失败");
    } finally {
      setSaving(null);
    }
  };

  const saveEmail = async (event: FormEvent) => {
    event.preventDefault();
    const newEmail = email.trim();
    if (!newEmail) return;
    setSaving("email");
    setFeedback("");
    try {
      const result = await authClient.changeEmail({ newEmail });
      if (result.error) throw new Error(result.error.message || "邮箱修改失败");
      await onAccountChange();
      setFeedback("邮箱已更新");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "邮箱修改失败");
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="space-y-6 text-sm">
      <section aria-labelledby="avatar-heading" className="space-y-3">
        <div>
          <h3 id="avatar-heading" className="font-medium">头像</h3>
          <p className="text-muted-foreground mt-1 text-xs">支持 PNG、JPEG 或 WebP，最大 1.5 MiB。</p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Avatar className="size-16">
            <AvatarImage src={previewUrl ?? avatarUrl} alt={`${principal.name}的头像`} />
            <AvatarFallback className="text-base">{initials}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1 space-y-2">
            <label htmlFor="account-avatar" className="text-muted-foreground block text-xs font-medium">选择新头像</label>
            <Input
              id="account-avatar"
              accept={storageUploadFileTypes("avatar").join(",")}
              type="file"
              onChange={(event) => selectAvatar(event.target.files?.[0] ?? null)}
            />
            <div className="flex flex-wrap gap-2">
              <Button disabled={!file || saving !== null} onClick={() => void uploadAvatar()}>
                <Camera aria-hidden="true" />{saving === "avatar" ? "正在保存…" : "保存头像"}
              </Button>
              <Button variant="outline" disabled={saving !== null} onClick={() => void removeAvatar()}>移除头像</Button>
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="identity-heading" className="space-y-4 border-t pt-5">
        <div>
          <h3 id="identity-heading" className="font-medium">账户信息</h3>
          <p className="text-muted-foreground mt-1 text-xs">UID 是账户的永久唯一标识，无法修改。</p>
        </div>
        <div className="rounded-xl border p-3">
          <div className="text-muted-foreground text-xs">UID</div>
          <div className="mt-1 break-all font-mono text-xs">{principal.uid}</div>
        </div>
        <form className="space-y-2" onSubmit={saveNickname}>
          <label htmlFor="account-nickname" className="text-xs font-medium">昵称</label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input id="account-nickname" required minLength={1} maxLength={80} autoComplete="name" value={nickname} onChange={(event) => setNickname(event.target.value)} />
            <Button className="sm:shrink-0" disabled={saving !== null || nickname.trim() === principal.name} type="submit">
              {saving === "nickname" ? "正在保存…" : "修改昵称"}
            </Button>
          </div>
        </form>
        <form className="space-y-2" onSubmit={saveEmail}>
          <label htmlFor="account-email" className="text-xs font-medium">邮箱</label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input id="account-email" required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} />
            <Button className="sm:shrink-0" disabled={saving !== null || email.trim() === principal.email} type="submit">
              {saving === "email" ? "正在保存…" : "更改邮箱"}
            </Button>
          </div>
        </form>
        <div className="text-muted-foreground text-xs">角色：{principal.roles.join("、")}</div>
      </section>

      <p role="status" aria-live="polite" className={cn("min-h-5 text-xs", feedback ? "text-muted-foreground" : "sr-only")}>
        {feedback || "账户资料等待操作"}
      </p>
    </div>
  );
}

type Classroom = { class_id: string; name: string; teacher_name?: string; join_code?: string; student_count?: number; allow_official_content?: boolean };
type TeacherBinding = { teacher_name: string; teacher_id: string; class_count?: number; first_joined_at?: string };

function ClassesPanel({ principal }: { principal: AuthPrincipal }) {
  const isTeacher = principal.roles.includes("teacher");
  const [classes, setClasses] = useState<Classroom[]>([]);
  const [teacher, setTeacher] = useState<TeacherBinding | null>(null);
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState("");

  const load = async () => {
    setLoading(true);
    setFeedback("");
    try {
      if (isTeacher) {
        const result = await jsonFetch<{ classes: Classroom[] }>("/api/classes");
        setClasses(result.classes);
      } else {
        const [classResult, teacherResult] = await Promise.all([
          jsonFetch<{ classes: Classroom[] }>("/api/my-class"),
          jsonFetch<{ teachers: TeacherBinding[] }>("/api/my-teacher"),
        ]);
        setClasses(classResult.classes);
        setTeacher(teacherResult.teachers[0] ?? null);
      }
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "无法读取班级信息");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFeedback("");
    try {
      await jsonFetch(isTeacher ? "/api/classes" : "/api/classes/join", {
        method: "POST",
        body: JSON.stringify(isTeacher ? { name: value.trim() } : { code: value.trim() }),
      });
      setValue("");
      setFeedback(isTeacher ? "班级已创建" : "已加入班级");
      await load();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "操作失败");
    }
  };

  const toggleOfficialContent = async (classroom: Classroom) => {
    setFeedback("");
    try {
      await jsonFetch(`/api/classes/${encodeURIComponent(classroom.class_id)}`, {
        method: "PATCH",
        body: JSON.stringify({ allow_official_content: !classroom.allow_official_content }),
      });
      setFeedback(classroom.allow_official_content ? "已关闭该班官方库" : "已开启该班官方库");
      await load();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "官方库设置失败");
    }
  };

  return (
    <div className="space-y-4 text-sm">
      <form className="space-y-2" onSubmit={submit}>
        <label htmlFor="class-action" className="text-xs font-medium">{isTeacher ? "新班级名称" : "班级码"}</label>
        <div className="flex gap-2">
          <Input id="class-action" required minLength={isTeacher ? 1 : 6} maxLength={isTeacher ? 80 : 12} value={value} onChange={(event) => setValue(event.target.value)} placeholder={isTeacher ? "例如：高二数学一班" : "输入教师提供的班级码"} />
          <Button type="submit">{isTeacher ? "创建" : "加入"}</Button>
        </div>
      </form>
      {feedback && <p role="status" className="text-muted-foreground text-xs">{feedback}</p>}
      {loading ? <p className="text-muted-foreground">正在读取…</p> : (
        <div className="space-y-2">
          {!isTeacher && <p className="text-muted-foreground">教师：{teacher?.teacher_name ?? "尚未绑定"}</p>}
          {classes.length === 0 ? <p className="text-muted-foreground rounded-xl border p-4">暂无班级</p> : classes.map((item) => (
            <div key={item.class_id} className="rounded-xl border p-3">
              <div className="font-medium">{item.name}</div>
              <div className="text-muted-foreground mt-1 text-xs">
                {isTeacher ? `${item.student_count ?? 0} 名学生 · 班级码 ${item.join_code}` : `教师 ${item.teacher_name ?? teacher?.teacher_name ?? "—"}`}
              </div>
              {isTeacher && (
                <Button className="mt-3 min-h-11" type="button" variant="outline" onClick={() => void toggleOfficialContent(item)}>
                  官方库：{item.allow_official_content === false ? "关闭" : "开启"}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function HelpPanel() {
  return (
    <div className="space-y-3 text-sm leading-6">
      <p>在输入框中发送数学问题；图片和文件通过回形针添加。正式对话与附件只在登录后写入。</p>
      <p>左侧栏用于新建、切换、重命名和归档对话，也可进入学习历史、科学状态、学习记忆和复习队列。</p>
      <p className="text-muted-foreground text-xs">题目、回答回执与学习更新来自服务端正式事实；刷新或换设备后会读取同一状态。</p>
    </div>
  );
}
