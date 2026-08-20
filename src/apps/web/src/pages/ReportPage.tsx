import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../app/auth";
import { EmptyState } from "../components/feedback/EmptyState";
import { AsyncButton } from "../components/feedback/AsyncButton";
import { MathText } from "../components/MathText";
import { apiFetch, formatDate, jsonBody } from "../lib/api";

type Dimension = { dimension_id: string; state: string; p_profile?: number; independent_observation_count?: number };
type Projection = { snapshot?: { published_at?: string; dimensions?: Dimension[] } };
type History = {
  retention?: Array<{ dimension_id: string; stable?: boolean; next_review_due?: string }>;
  misconceptions?: Array<{ error_cause_id: string; state: string; evidence_refs?: string[] }>;
  snapshots?: Array<{ snapshot_id: string; published_at?: string; created_at?: string }>;
};
type Evidence = { sessions?: Array<{ question_id: string; state: string; started_at?: string; hint_level?: number; judgments?: Array<{ verdict: string; uncertainty?: string; payload?: { decision_summary?: string; uncertainty?: string; rubric_items?: Array<{ id: string; status: string }> } }> }> };
type Plan = { explanation?: string; tasks?: Array<{ week: number; kind: string; dimension_ids?: string[]; criterion: string; review_condition: string; why?: string }> };

const rank: Record<string, number> = { weak: 0, learning: 1, insufficient_evidence: 2, possibly_mastered: 3, mastered: 4 };
const risk: Record<string, string> = { weak: "需要重点练习", learning: "正在学习", insufficient_evidence: "还需要更多练习", possibly_mastered: "基本稳定", mastered: "掌握稳定" };
const misconceptionState: Record<string, string> = { active: "仍需关注", resolved: "已经改善", observing: "继续观察" };

export function ReportPage() {
  const { state: { principal } } = useAuth();
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  const requested = params.get("student");
  const canViewStudent = principal.roles.some((role) => role === "teacher" || role === "tenant_admin");
  const id = canViewStudent && requested ? requested : principal.user_id;
  const projection = useQuery({ queryKey: ["projection", id], queryFn: () => apiFetch<Projection>(`/api/students/${encodeURIComponent(id)}/projection`), retry: false });
  const history = useQuery({ queryKey: ["history", id], queryFn: () => apiFetch<History>(`/api/students/${encodeURIComponent(id)}/history`), retry: false });
  const evidence = useQuery({ queryKey: ["evidence", id], queryFn: () => apiFetch<Evidence>(`/api/students/${encodeURIComponent(id)}/evidence`), retry: false });
  const plan = useQuery({ queryKey: ["plan", id], queryFn: () => apiFetch<Plan>(`/api/students/${encodeURIComponent(id)}/plans`), retry: false });
  const generate = useMutation({
    mutationFn: () => apiFetch(`/api/students/${encodeURIComponent(id)}/plans`, { method: "POST", ...jsonBody({ horizon_weeks: 4 }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["plan", id] }),
  });
  const dimensions = [...(projection.data?.snapshot?.dimensions ?? [])].sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9));

  return (
    <main className="page narrow page-stack" id="main-content">
      <section className="page-hero compact"><p className="eyebrow">学习报告</p><h1>先看现在，再决定下一步</h1><p className="lede">这里汇总最近的学习变化、需要复习的内容和接下来的计划。想了解某个判断时，可以展开查看依据。</p></section>
      <section className="proof-sheet"><div className="sheet-heading"><div><p className="eyebrow">当前状态</p><h2>知识掌握</h2></div><span className="mono">{projection.data?.snapshot?.published_at ? new Date(projection.data.snapshot.published_at).toLocaleDateString() : ""}</span></div>
        <div className="artifact-deck">{dimensions.length ? dimensions.map((item) => <article className="artifact-card" key={item.dimension_id}><strong>{item.dimension_id} · {risk[item.state] || "继续观察"}</strong><p>当前稳定度 {Math.round(Number(item.p_profile || 0) * 100)}%</p><small className="muted">依据 {item.independent_observation_count || 0} 次独立练习</small></article>) : <EmptyState title="学习状态正在建立" action={<Link className="btn ghost" to="/profile?first=1">完成学习设置</Link>}>先完成学习设置和一轮练习，这里就会显示知识掌握变化。</EmptyState>}</div>
      </section>
      <section className="proof-sheet"><div className="sheet-heading"><div><p className="eyebrow">接下来</p><h2>复习安排</h2></div></div><div className="artifact-deck">{history.data?.retention?.length ? history.data.retention.map((item) => <article className="artifact-card" key={item.dimension_id}><strong>{item.dimension_id}</strong><p>{item.stable ? `建议复习：${item.next_review_due ? new Date(item.next_review_due).toLocaleDateString() : "待安排"}` : "继续完成几次间隔练习后安排复习"}</p></article>) : <EmptyState>目前没有到期复习内容</EmptyState>}</div></section>
      <section className="proof-sheet"><div className="sheet-heading"><div><p className="eyebrow">学习卡点</p><h2>需要继续观察的错误</h2></div></div><div className="artifact-deck">{history.data?.misconceptions?.length ? history.data.misconceptions.map((item) => <article className="artifact-card" key={item.error_cause_id}><strong>{item.error_cause_id}</strong><p>{misconceptionState[item.state] || item.state} · {item.evidence_refs?.length || 0} 条学习记录</p></article>) : <EmptyState>目前没有需要重点关注的错误模式</EmptyState>}</div></section>
      <section className="proof-sheet"><div className="sheet-heading"><div><p className="eyebrow">学习计划</p><h2>未来 1–4 周</h2></div><AsyncButton className="ghost" pending={generate.isPending} pendingLabel="正在更新…" onClick={() => generate.mutate()}>更新计划</AsyncButton></div>
        <div>{plan.data?.explanation && <p>{plan.data.explanation}</p>}{plan.data?.tasks?.length ? plan.data.tasks.map((task, index) => <article className="artifact-card plan-task" key={`${task.week}-${index}`}><strong>第 {task.week} 周 · {task.kind}</strong><p>重点：{task.dimension_ids?.join("、") || "按当前证据安排"}</p><p>完成标准：{task.criterion}</p><p>复习安排：{task.review_condition}</p>{task.why && <p>为什么这样安排：{task.why}</p>}</article>) : <EmptyState>完成几次学习后，可以生成你的学习计划</EmptyState>}</div>
        {generate.isSuccess && <p className="status-note success">计划已根据最近证据更新。</p>}{generate.isError && <p className="status-note error">暂时无法更新计划，请先完成几次学习后重试。</p>}
      </section>
      <details className="proof-sheet"><summary>查看学习状态的更新时间</summary><div className="page-stack">{history.data?.snapshots?.length ? history.data.snapshots.map((item) => <article className="artifact-card" key={item.snapshot_id}>{formatDate(item.published_at || item.created_at)} · <span className="mono">{item.snapshot_id}</span></article>) : <p>还没有历史记录。</p>}</div></details>
      <details className="proof-sheet"><summary>查看判断依据</summary><div>{evidence.data?.sessions?.length ? evidence.data.sessions.map((session) => <details className="artifact-card evidence-session" key={`${session.question_id}-${session.started_at}`}><summary>题目 {session.question_id} · {session.state === "CLOSED" ? "已完成" : "进行中"}</summary><p className="muted">{formatDate(session.started_at, "")} · 提示程度 {Number(session.hint_level || 0)}</p>{session.judgments?.map((judgment, index) => <div key={index} className="judgment-detail"><h3>{({ correct: "回答正确", partially_correct: "部分正确", incorrect: "需要修正", unresolved: "继续观察" } as Record<string, string>)[judgment.verdict] || judgment.verdict}</h3><MathText text={judgment.payload?.decision_summary || ""} className="muted" /><details><summary>查看判断依据</summary>{judgment.payload?.rubric_items?.length ? <ul>{judgment.payload.rubric_items.map((item) => <li key={item.id}>{item.id}：{({ met: "已做到", not_met: "待改进", unclear: "待确认" } as Record<string, string>)[item.status] || "继续观察"}</li>)}</ul> : <p className="muted">这次判断仍需结合后续练习。</p>}</details></div>)}</details>) : <p>还没有可查看的学习记录。</p>}</div></details>
    </main>
  );
}
