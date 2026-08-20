import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, ChevronRight, GraduationCap, History, UserRound } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../app/auth";
import { AsyncButton } from "../components/feedback/AsyncButton";
import { ApiError, apiFetch, jsonBody } from "../lib/api";

type ProfileForm = {
  grade: string;
  current_score: string;
  target_score: string;
  weekly_hours: string;
  weak: string;
  device_draft: string;
};
type StoredProfile = Omit<ProfileForm, "current_score" | "target_score" | "weak"> & {
  current_score?: number | null;
  target_score?: number | null;
  self_reported_weak?: string[];
};
type MyClasses = { classes?: Array<{ class_id: string; name: string; teacher_name?: string; joined_at?: string }> };

const initialForm: ProfileForm = { grade: "高二", current_score: "", target_score: "", weekly_hours: "4-6", weak: "", device_draft: "无草稿" };

export function ProfilePage() {
  const { state: { principal } } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const firstRun = params.get("first") === "1";
  const queryClient = useQueryClient();
  const id = principal.user_id;
  const [form, setForm] = useState(initialForm);
  const [classCode, setClassCode] = useState("");
  const [isSettingsOpen, setIsSettingsOpen] = useState(() => firstRun);
  const profile = useQuery({
    queryKey: ["profile", id],
    queryFn: async () => {
      try { return await apiFetch<StoredProfile>(`/api/students/${encodeURIComponent(id)}/profile`); }
      catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
    },
    retry: false,
  });
  const myClass = useQuery({ queryKey: ["my-class"], queryFn: () => apiFetch<MyClasses>("/api/my-class"), retry: false });
  const joinClass = useMutation({
    mutationFn: () => apiFetch("/api/classes/join", { method: "POST", ...jsonBody({ code: classCode.trim() }) }),
    onSuccess: async () => { setClassCode(""); await Promise.all([queryClient.invalidateQueries({ queryKey: ["my-class"] }), queryClient.invalidateQueries({ queryKey: ["my-teacher"] })]); },
  });

  useEffect(() => {
    if (!profile.data) return;
    setForm({
      grade: profile.data.grade ?? "高二",
      current_score: profile.data.current_score == null ? "" : String(profile.data.current_score),
      target_score: profile.data.target_score == null ? "" : String(profile.data.target_score),
      weekly_hours: profile.data.weekly_hours ?? "4-6",
      weak: profile.data.self_reported_weak?.join("，") ?? "",
      device_draft: profile.data.device_draft ?? "无草稿",
    });
  }, [profile.data]);

  const save = useMutation({
    mutationFn: () => apiFetch(`/api/students/${encodeURIComponent(id)}/profile`, {
      method: "PUT",
      ...jsonBody({
        grade: form.grade,
        current_score: form.current_score === "" ? null : Number(form.current_score),
        target_score: form.target_score === "" ? null : Number(form.target_score),
        weekly_hours: form.weekly_hours,
        self_reported_weak: form.weak.split(/[,，]/).map((value) => value.trim()).filter(Boolean),
        device_draft: form.device_draft,
      }),
    }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["profile", id] });
      navigate(firstRun ? "/?onboarding=assessment" : "/");
    },
  });
  const set = (key: keyof ProfileForm, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => { event.preventDefault(); save.mutate(); };
  const settingsSummary = `${form.grade} · ${form.target_score ? `目标 ${form.target_score} 分` : "目标待设置"} · 每周 ${form.weekly_hours.replace("-", "–")} 小时`;

  return (
    <main className="page narrow" id="main-content">
      <section className="page-hero compact"><p className="eyebrow">{firstRun ? "新账号引导 · 第 1 步（共 2 步）" : "学习设置"}</p><h1>{firstRun ? "先认识你的目标和学习节奏" : "更新你的目标和学习节奏"}</h1><p className="lede">这些信息会帮助系统安排第一轮练习和每周计划，你可以随时回来更新。</p></section>
      {!firstRun && <nav className="profile-settings-nav" aria-label="个人设置相关页面">
        <Link to="/account"><UserRound aria-hidden="true" /><span><strong>账户资料</strong><small>头像、昵称与联系方式</small></span><ArrowUpRight aria-hidden="true" /></Link>
        <Link to="/report#learning-records"><History aria-hidden="true" /><span><strong>学习记录</strong><small>学习变化与判断依据</small></span><ArrowUpRight aria-hidden="true" /></Link>
      </nav>}
      <details className="profile-settings-card" open={isSettingsOpen} onToggle={(event) => setIsSettingsOpen(event.currentTarget.open)}>
        <summary>
          <GraduationCap aria-hidden="true" />
          <span><strong>学习设置</strong><small>{settingsSummary}</small></span>
          <ChevronRight aria-hidden="true" />
        </summary>
        <div className="profile-settings-body"><form onSubmit={submit}>
          <div className="interview-step"><p className="eyebrow">学习阶段</p><div className="field-row">
              <label>你现在是哪个年级？<select value={form.grade} onChange={(e) => set("grade", e.target.value)}><option>高一</option><option>高二</option><option>高三</option></select></label>
              <label>每周能稳定投入多少时间？<select value={form.weekly_hours} onChange={(e) => set("weekly_hours", e.target.value)}><option>1-3</option><option>4-6</option><option>7-10</option><option>10+</option></select></label>
          </div></div>
          <div className="interview-step"><p className="eyebrow">学习目标</p><div className="field-row">
            <label>最近数学大约多少分？（150 分制，选填）<input value={form.current_score} onChange={(e) => set("current_score", e.target.value)} type="number" min="0" max="150" placeholder="例如 90" /></label>
            <label>希望提升到多少分？（选填）<input value={form.target_score} onChange={(e) => set("target_score", e.target.value)} type="number" min="0" max="150" placeholder="例如 110" /></label>
          </div></div>
          <div className="interview-step"><p className="eyebrow">学习习惯</p>
            <label>你觉得哪些知识点最容易卡住？（选填，用逗号分隔）<input value={form.weak} onChange={(e) => set("weak", e.target.value)} placeholder="例如：正弦定理、数列、不等式" /></label>
            <label>通常怎样写草稿？<select value={form.device_draft} onChange={(e) => set("device_draft", e.target.value)}><option>触屏手写</option><option>纸面拍照</option><option>无草稿</option></select></label>
          </div>
          <div className="action-cluster"><AsyncButton type="submit" className="cinnabar" pending={save.isPending} pendingLabel="正在保存…">保存设置</AsyncButton><Link className="btn ghost" to="/">暂不修改</Link></div>
          {save.isError && <p className="status-note error" role="alert">保存失败，请检查输入或稍后重试。</p>}
        </form></div>
      </details>
      <section className="section-card class-join-card"><div className="section-heading"><div><p className="eyebrow">我的班级</p><h2>{myClass.data?.classes?.length ? "已经加入班级" : "使用班级码加入"}</h2><p className="muted">加入班级后，可以使用教师为班级准备的内容，教师也能跟进你的学习情况。</p></div></div>{myClass.data?.classes?.length ? <div className="joined-class-list">{myClass.data.classes.map((classroom) => <article key={classroom.class_id}><strong>{classroom.name}</strong><span>{classroom.teacher_name ? `${classroom.teacher_name} 老师` : "班级教师"}</span></article>)}</div> : <form className="inline-form" onSubmit={(event) => { event.preventDefault(); joinClass.mutate(); }}><label>班级码<input value={classCode} onChange={(event) => setClassCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} minLength={6} maxLength={12} placeholder="输入教师提供的班级码" autoComplete="off" required /></label><AsyncButton className="cinnabar" type="submit" pending={joinClass.isPending} pendingLabel="正在加入…">加入班级</AsyncButton></form>}{joinClass.isSuccess && <p className="status-note success">已加入班级。</p>}{joinClass.isError && <p className="status-note error">班级码无效，或你已绑定其他教师。</p>}</section>
    </main>
  );
}
