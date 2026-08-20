import { useMutation, useQuery } from "@tanstack/react-query";
import { CircleHelp, PencilLine, RefreshCcw } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../app/auth";
import { AsyncButton } from "../components/feedback/AsyncButton";
import { EmptyState } from "../components/feedback/EmptyState";
import { ApiError, apiFetch } from "../lib/api";

type Profile = { target_score?: number | null; weekly_hours?: string };
type Projection = { snapshot?: { dimensions?: Array<{ state?: string }> } };
type Run = { run_id: string };
type Next = { question_id?: string; goal?: string };

async function optionalProfile(id: string): Promise<Profile | null> {
  try { return await apiFetch<Profile>(`/api/students/${encodeURIComponent(id)}/profile`); }
  catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
}

export function HomePage() {
  const { state: { principal } } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const id = principal.user_id;
  const profile = useQuery({ queryKey: ["profile", id], queryFn: () => optionalProfile(id), retry: false });
  const projection = useQuery({ queryKey: ["projection", id], queryFn: () => apiFetch<Projection>(`/api/students/${encodeURIComponent(id)}/projection`), retry: false });
  const start = useMutation({
    mutationFn: async (goal: string) => {
      if (!profile.data) { navigate("/profile?first=1"); return; }
      const run = await apiFetch<Run>("/api/assessment-runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ student_id: id, goal }) });
      const next = await apiFetch<Next>(`/api/assessment-runs/${encodeURIComponent(run.run_id)}/next`, { method: "POST" });
      if (!next.question_id) throw new Error("no_questions");
      navigate(`/solve?run=${encodeURIComponent(run.run_id)}&goal=${encodeURIComponent(next.goal || goal)}&q=${encodeURIComponent(next.question_id)}`);
    },
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

  return (
    <main className="page student-home" id="main-content">
      {params.get("forbidden") && <div className="status-note warning">这个账户没有访问该页面的权限，已经带你回到学习空间。</div>}
      <section className="home-focus">
        <div className="home-intro"><p className="eyebrow">今天的学习</p><h1>从最值得继续的一步开始</h1><p>{profile.isPending ? "正在为你整理今天的任务…" : ready ? `目标 ${profile.data?.target_score ?? "待设置"} 分 · 每周 ${profile.data?.weekly_hours || "按你的节奏"}` : "先用两分钟告诉我们你的学习目标。"}</p></div>
        <blockquote className="daily-note"><p>“真正的理解，会在你能解释每一步时出现。”</p><footer>今日学习提示</footer></blockquote>
      </section>

      <section className="next-task">
        <div className="next-task-copy"><span className="next-task-label">下一步</span><h2>{ready ? "开始一轮短练习" : "完成学习设置"}</h2><p>{startError || (ready ? "从当前学习证据中选择一道最有价值的题，完成后再决定是否继续。" : "设置年级、目标和每周时间，系统就能安排第一轮练习。")}</p>{ready && <div className="next-task-meta">通常 10–15 分钟</div>}</div>
        <AsyncButton className="cinnabar" pending={start.isPending} pendingLabel="正在准备…" disabled={profile.isPending} onClick={() => start.mutate("coverage")}>{ready ? "开始学习" : "开始设置"}</AsyncButton>
      </section>

      <div className="home-columns">
        <section className="section-card">
          <div className="section-heading"><div><p className="eyebrow">快捷开始</p><h2>你想做什么？</h2></div></div>
          <div className="quick-list">
            <button className="quick-action" type="button" disabled={!ready || start.isPending} onClick={() => start.mutate("review")}><span className="nav-glyph"><RefreshCcw /></span><span><strong>复习到期内容</strong><small>看看哪些知识需要再确认一次</small></span><span>→</span></button>
            <button className="quick-action" type="button" disabled={!ready || start.isPending} onClick={() => start.mutate("training")}><span className="nav-glyph"><PencilLine /></span><span><strong>专项练习</strong><small>围绕一个薄弱点逐步巩固</small></span><span>→</span></button>
            <Link className="quick-action" to="/solve"><span className="nav-glyph"><CircleHelp /></span><span><strong>问一道题</strong><small>上传题目或草稿，和智能老师讨论</small></span><span>→</span></Link>
          </div>
        </section>
        <section className="section-card progress-card">
          <div className="section-heading"><div><p className="eyebrow">最近进度</p><h2>学习概览</h2></div><Link to="/report">查看报告</Link></div>
          {projection.data?.snapshot?.dimensions?.length ? <div className="progress-grid"><div><strong>{counts.mastered}</strong><span>较稳定</span></div><div><strong>{counts.learning}</strong><span>学习中</span></div><div><strong>{counts.weak}</strong><span>需要关注</span></div></div> : <EmptyState>完成一次学习后，这里会显示最近变化</EmptyState>}
        </section>
      </div>
    </main>
  );
}
