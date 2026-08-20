import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
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
type TeacherBinding = { binding: null | { teacher_name?: string } };

const initialForm: ProfileForm = { grade: "高二", current_score: "", target_score: "", weekly_hours: "4-6", weak: "", device_draft: "无草稿" };

export function ProfilePage() {
  const { state: { principal } } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const id = principal.user_id;
  const [form, setForm] = useState(initialForm);
  const profile = useQuery({
    queryKey: ["profile", id],
    queryFn: async () => {
      try { return await apiFetch<StoredProfile>(`/api/students/${encodeURIComponent(id)}/profile`); }
      catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
    },
    retry: false,
  });
  const teacher = useQuery({ queryKey: ["my-teacher"], queryFn: () => apiFetch<TeacherBinding>("/api/my-teacher"), retry: false });

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
      navigate("/");
    },
  });
  const set = (key: keyof ProfileForm, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => { event.preventDefault(); save.mutate(); };

  return (
    <main className="page narrow" id="main-content">
      <section className="page-hero compact"><p className="eyebrow">学习设置</p><h1>告诉我们你的目标和学习节奏</h1><p className="lede">这些信息会帮助系统安排第一轮练习和每周计划，你可以随时回来更新。</p></section>
      <section className="section-card interview profile-card">
        <div className="notice">{teacher.isPending ? "正在读取教学绑定…" : teacher.data?.binding ? `你的学习记录会用于生成报告和计划，并与 ${teacher.data.binding.teacher_name || "你的教师"} 共享。` : "当前使用公共教学内容。绑定教师后，还可以使用教师为你准备的内容。"}</div>
        <form onSubmit={submit}>
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
        </form>
      </section>
    </main>
  );
}
