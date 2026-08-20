import { useQuery } from "@tanstack/react-query";
import { BookOpenCheck, ChartNoAxesCombined, ClipboardCheck, UsersRound } from "lucide-react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { EmptyState } from "../components/feedback/EmptyState";
import { apiFetch, formatDate } from "../lib/api";

type Pipeline = { run_id: string; status: string; stage: string; created_at: string; updated_at?: string; document_ids?: string[]; ktq_session_ref?: string; er_session_ref?: string; payload?: { publication?: { package_id?: string; version?: string } } };
type Pipelines = { runs?: Pipeline[] };
type Overview = { students?: unknown[]; classes?: unknown[]; stats?: { pending_reviews?: number; questions?: number; published_questions?: number; packages?: number; completed_sessions?: number; sessions_this_week?: number } };

const stateLabel: Record<string, string> = { draft: "等待确认", queued: "准备中", running: "处理中", review_ready: "等待复核", published: "已发布", failed: "需要处理" };

export function TeacherPage() {
  const [params] = useSearchParams();
  if (params.get("view") === "review") {
    const next = new URLSearchParams(params); next.delete("view");
    return <Navigate to={`/review${next.size ? `?${next}` : ""}`} replace />;
  }
  const pipelines = useQuery({ queryKey: ["content-pipelines"], queryFn: () => apiFetch<Pipelines>("/api/content/pipelines"), refetchInterval: 10_000 });
  const overview = useQuery({ queryKey: ["admin", "overview"], queryFn: () => apiFetch<Overview>("/api/admin/overview") });
  const runs = pipelines.data?.runs ?? [];
  const activeRuns = runs.filter((run) => ["draft", "queued", "running", "review_ready"].includes(run.status));
  const stats = [
    { label: "待复核内容", value: overview.data?.stats?.pending_reviews ?? "—", detail: "等待你的判断", icon: ClipboardCheck, to: "/review?status=pending" },
    { label: "已发布题目", value: overview.data?.stats?.published_questions ?? "—", detail: `${overview.data?.stats?.packages ?? 0} 个内容版本`, icon: BookOpenCheck, to: "/library" },
    { label: "学生与班级", value: overview.data?.students?.length ?? "—", detail: `${overview.data?.classes?.length ?? 0} 个班级`, icon: UsersRound, to: "/admin?view=students" },
    { label: "本周学习", value: overview.data?.stats?.sessions_this_week ?? "—", detail: "已完成的学习会话", icon: ChartNoAxesCombined, to: "/admin?view=students" },
  ];

  return <main className="page page-stack" id="main-content">
    <section className="page-hero compact teacher-welcome"><p className="eyebrow">教师工作台</p><h1>从今天最重要的教学任务开始</h1><p className="lede">查看内容进度、学生学习情况和需要你判断的事项。</p></section>
    <section className="dashboard-stat-grid" aria-label="工作台概览">{stats.map((item) => { const Icon = item.icon; return <Link className="dashboard-stat-card" to={item.to} key={item.label}><span className="dashboard-stat-icon"><Icon aria-hidden="true" /></span><span><small>{item.label}</small><strong>{item.value}</strong><em>{item.detail}</em></span></Link>; })}</section>
    <div className="teacher-dashboard-grid">
      <section className="section-card"><div className="section-heading"><div><p className="eyebrow">待办</p><h2>继续处理</h2></div><Link className="btn ghost" to="/content">全部内容任务</Link></div><div className="run-list">{activeRuns.length ? activeRuns.slice(0, 5).map((run) => {
        const ref = run.stage === "er" ? run.er_session_ref : run.ktq_session_ref;
        const to = run.status === "review_ready" ? `/review?status=pending&queue=content&pipeline=${encodeURIComponent(run.run_id)}` : run.status === "draft" || !ref ? "/content" : `/agent-session?ref=${encodeURIComponent(ref)}`;
        return <Link className="work-row" key={run.run_id} to={to}><span className={`work-state ${run.status}`}>{stateLabel[run.status] || run.status}</span><span className="work-copy"><strong>{run.document_ids?.length || 0} 个文件</strong><small>{formatDate(run.updated_at || run.created_at)}</small></span><span className="priority-arrow">→</span></Link>;
      }) : <EmptyState title="目前没有待处理任务" action={<Link className="btn cinnabar" to="/content">添加教学资料</Link>}>新的内容任务会显示在这里。</EmptyState>}</div></section>
      <section className="section-card"><div className="section-heading"><div><p className="eyebrow">常用工作</p><h2>进入教学空间</h2></div></div><div className="teacher-action-list"><Link to="/review?status=pending"><ClipboardCheck aria-hidden="true" /><span><strong>复核教学内容</strong><small>核对题目、知识点、题型与诊断内容</small></span><span>→</span></Link><Link to="/library"><BookOpenCheck aria-hidden="true" /><span><strong>浏览已发布内容</strong><small>查看学生当前可以使用的内容版本</small></span><span>→</span></Link><Link to="/admin?view=students"><UsersRound aria-hidden="true" /><span><strong>查看学生</strong><small>跟进班级、学习报告与计划</small></span><span>→</span></Link></div></section>
    </div>
  </main>;
}
