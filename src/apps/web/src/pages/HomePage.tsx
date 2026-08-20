import { useMutation, useQuery } from "@tanstack/react-query";
import { BookOpen, CircleHelp, RefreshCcw } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../app/auth";
import { AsyncButton } from "../components/feedback/AsyncButton";
import { EmptyState } from "../components/feedback/EmptyState";
import { ApiError, apiFetch } from "../lib/api";

type Profile = { target_score?: number | null; weekly_hours?: string };
type Projection = { snapshot?: { dimensions?: Array<{ state?: string }> } };
type Run = { run_id: string; goal?: string; current_question?: string };
type Next = { question_id?: string; goal?: string };

async function optionalProfile(id: string): Promise<Profile | null> {
  try { return await apiFetch<Profile>(`/api/students/${encodeURIComponent(id)}/profile`); }
  catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
}

export function HomePage() {
  const { state: { principal, user } } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const mounted = useRef(true);
  const id = principal.user_id;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const profile = useQuery({ queryKey: ["profile", id], queryFn: () => optionalProfile(id), retry: false });
  const projection = useQuery({ queryKey: ["projection", id], queryFn: () => apiFetch<Projection>(`/api/students/${encodeURIComponent(id)}/projection`), retry: false });
  const start = useMutation({
    mutationFn: async (goal: string) => {
      if (!profile.data) return { path: "/profile?first=1" };
      const run = await apiFetch<Run>("/api/assessment-runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ student_id: id, goal }) });
      if (run.current_question) return { path: `/solve?run=${encodeURIComponent(run.run_id)}&goal=${encodeURIComponent(run.goal || goal)}&q=${encodeURIComponent(run.current_question)}` };
      const next = await apiFetch<Next>(`/api/assessment-runs/${encodeURIComponent(run.run_id)}/next`, { method: "POST" });
      if (!next.question_id) throw new Error("no_questions");
      return { path: `/solve?run=${encodeURIComponent(run.run_id)}&goal=${encodeURIComponent(next.goal || goal)}&q=${encodeURIComponent(next.question_id)}` };
    },
    onSuccess: (result) => { if (mounted.current && window.location.pathname === "/") navigate(result.path); },
  });

  const ready = profile.data !== null && profile.data !== undefined;
  const counts = { mastered: 0, learning: 0, weak: 0 };
  for (const dim of projection.data?.snapshot?.dimensions ?? []) {
    if (dim.state === "mastered" || dim.state === "possibly_mastered") counts.mastered++;
    else if (dim.state === "weak") counts.weak++;
    else counts.learning++;
  }
  const startError = start.error instanceof ApiError && start.error.message === "no_questions"
    ? "当前还没有可用练习，请稍后再来。"
    : start.error ? "暂时无法开始，稍后再试。" : "";
  const hour = new Date().getHours();
  const greeting = hour < 6 ? "夜深了" : hour < 11 ? "早上好" : hour < 14 ? "中午好" : hour < 18 ? "下午好" : "晚上好";
  const firstName = (user.name || "同学").trim();
  const needsFirstAssessment = ready && !(projection.data?.snapshot?.dimensions?.length);

  return (
    <main className="page student-home" id="main-content">
      {params.get("forbidden") && <div className="status-note warning">这个账户没有访问该页面的权限，已经带你回到学习空间。</div>}
      <section className="home-focus">
        <div className="home-intro"><p className="eyebrow">今天的学习</p><h1>{greeting}，{firstName}</h1><p>{profile.isPending ? "正在为你整理今天的任务…" : ready ? needsFirstAssessment ? "完成一轮简短测评，我们就能开始为你安排学习。" : `目标 ${profile.data?.target_score ?? "待设置"} 分 · 每周 ${profile.data?.weekly_hours || "按你的节奏"}` : "先用两分钟告诉我们你的学习目标。"}</p></div>
        <blockquote className="daily-note"><p>“数学是科学的大门和钥匙。”</p><footer>罗杰·培根《大著作》</footer></blockquote>
      </section>
      {!ready && !profile.isPending ? <section className="onboarding-callout"><div><span className="onboarding-step">新账号引导 · 第 1 步</span><h2>先完成学习设置</h2><p>设置年级、目标和每周学习节奏，下一步会进行首次测评。</p></div><Link className="btn cinnabar" to="/profile?first=1">开始设置</Link></section> : <section className="learning-entry-grid" aria-label="开始学习"><AsyncButton className="learning-entry is-primary" pending={start.isPending} pendingLabel="正在准备…" disabled={profile.isPending} onClick={() => start.mutate("coverage")}><BookOpen aria-hidden="true" /><span><strong>{needsFirstAssessment ? "开始首次测评" : "开始学习"}</strong><small>{startError || (needsFirstAssessment ? "用几道题建立你的初始学习状态" : "继续当前最值得学习的内容")}</small></span><b>→</b></AsyncButton><AsyncButton className="learning-entry" pending={start.isPending} pendingLabel="正在准备…" disabled={profile.isPending || needsFirstAssessment} onClick={() => start.mutate("review")}><RefreshCcw aria-hidden="true" /><span><strong>开始复习</strong><small>回顾到期内容并确认掌握是否稳定</small></span><b>→</b></AsyncButton><Link className="learning-entry" to="/ask"><CircleHelp aria-hidden="true" /><span><strong>向 AI 提问</strong><small>上传问题、题图或草稿，直接获得解答与引导</small></span><b>→</b></Link></section>}

      <div className="home-columns single-progress">
        <section className="section-card progress-card">
          <div className="section-heading"><div><p className="eyebrow">最近进度</p><h2>学习概览</h2></div><Link to="/report">查看报告</Link></div>
          {projection.data?.snapshot?.dimensions?.length ? <div className="progress-grid"><div><strong>{counts.mastered}</strong><span>较稳定</span></div><div><strong>{counts.learning}</strong><span>学习中</span></div><div><strong>{counts.weak}</strong><span>需要关注</span></div></div> : <EmptyState>完成一次学习后，这里会显示最近变化</EmptyState>}
        </section>
      </div>
    </main>
  );
}
