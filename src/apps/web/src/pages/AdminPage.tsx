import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AsyncButton } from "../components/feedback/AsyncButton";
import { EmptyState } from "../components/feedback/EmptyState";
import { apiFetch, formatDate, jsonBody } from "../lib/api";

type Student = { user_id: string; display_name?: string; current_score?: number; target_score?: number; completed_sessions?: number; latest_snapshot_at?: string };
type Binding = { binding_id: string; student_id: string; status: string };
type Overview = { students?: Student[]; classes?: Array<Record<string, unknown>>; trends?: Array<Record<string, unknown>>; packages?: Array<Record<string, unknown>>; golden_runs?: Array<Record<string, unknown>> };
type Bindings = { bindings?: Binding[] };

const exportsList: Record<string, string> = { knowledge_points: "知识点", question_types: "题型", error_causes: "错因", questions: "题目", diagnosis_rules: "诊断规则", student_cases: "学生学习记录", field_lineage: "内容来源" };

function DataTable({ rows, columns }: { rows: Array<Record<string, unknown>>; columns: Array<[string, string]> }) {
  return <div className="table-wrap"><table className="ledger"><thead><tr>{columns.map(([key, label]) => <th key={key}>{label}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{columns.map(([key]) => { const value = row[key]; const text = key.includes("at") ? formatDate(value) : typeof value === "object" ? JSON.stringify(value) : String(value ?? "—"); return <td key={key} className={key.endsWith("_id") || key.includes("hash") ? "mono" : undefined}>{text}</td>; })}</tr>)}</tbody></table></div>;
}

function CardSection({ eyebrow, title, description, action, children }: { eyebrow: string; title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return <section className="section-card"><div className="section-heading"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2>{description && <p className="muted">{description}</p>}</div>{action}</div>{children}</section>;
}

export function AdminPage() {
  const [params] = useSearchParams();
  const mode = params.get("view") === "settings" ? "settings" : "students";
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"students" | "classes" | "trends">("students");
  const [search, setSearch] = useState("");
  const [email, setEmail] = useState("");
  const [feedback, setFeedback] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const overview = useQuery({ queryKey: ["admin", "overview"], queryFn: () => apiFetch<Overview>("/api/admin/overview") });
  const bindings = useQuery({ queryKey: ["teacher-bindings"], queryFn: () => apiFetch<Bindings>("/api/teacher-student-bindings") });
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ["admin", "overview"] }), queryClient.invalidateQueries({ queryKey: ["teacher-bindings"] })]);
  const add = useMutation({
    mutationFn: () => apiFetch<{ binding?: Binding }>("/api/teacher-student-bindings", { method: "POST", ...jsonBody({ student_email: email.trim() }) }),
    onSuccess: async () => { setFeedback("学生已添加到你的教学空间。"); setEmail(""); await refresh(); },
    onError: (error) => setFeedback(error instanceof Error && error.message.includes("not found") ? "没有找到使用该邮箱注册的学生。" : error instanceof Error && error.message.includes("already") ? "该学生已经绑定了教师。" : "暂时无法添加，请稍后重试。"),
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/teacher-student-bindings/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: async () => { setConfirmRemove(null); await refresh(); },
  });
  const submit = (event: FormEvent) => { event.preventDefault(); setFeedback(""); add.mutate(); };
  const students = useMemo(() => (overview.data?.students ?? []).filter((row) => !search.trim() || `${row.display_name || ""} ${row.user_id}`.toLowerCase().includes(search.trim().toLowerCase())), [overview.data?.students, search]);

  if (mode === "settings") {
    const packages = overview.data?.packages ?? [];
    const evaluations = overview.data?.golden_runs ?? [];
    return <main className="page page-stack" id="main-content">
      <section className="page-hero compact"><p className="eyebrow">设置</p><h1>管理教师空间</h1><p className="lede">查看账户信息、数据导出和内容版本。</p></section>
      <CardSection eyebrow="内容版本" title="已发布内容" description="查看当前可用的内容版本和发布时间。" action={<Link className="btn ghost" to="/content">打开内容</Link>}>{packages.length ? <DataTable rows={packages} columns={[["chapter_id", "内容集"], ["version", "版本"], ["published_at", "发布时间"], ["manifest_hash", "内容标识"]]} /> : <EmptyState>还没有已发布内容</EmptyState>}</CardSection>
      <CardSection eyebrow="评估记录" title="质量检查" description="查看最近的自动检查和回归结果。">{evaluations.length ? <DataTable rows={evaluations} columns={[["eval_kind", "检查类型"], ["golden_set", "数据集"], ["metrics", "结果"], ["created_at", "时间"]]} /> : <EmptyState>还没有质量检查记录</EmptyState>}</CardSection>
      <CardSection eyebrow="数据" title="导出工作区数据" description="用于备份、教研分析或迁移。" action={<a className="btn cinnabar" href="/api/admin/export" download>导出完整数据</a>}><div className="export-grid">{Object.entries(exportsList).map(([id, label]) => <a className="export-card" href={`/api/admin/export?format=csv&dataset=${id}`} download={`${id}.csv`} key={id}><strong>{label}</strong><span>CSV 下载</span></a>)}</div></CardSection>
    </main>;
  }

  const titles = { students: ["学生", "学生列表"], classes: ["班级", "班级概览"], trends: ["学习趋势", "最近知识变化"] } as const;
  const rows = tab === "classes" ? overview.data?.classes ?? [] : overview.data?.trends ?? [];
  return (
    <main className="page page-stack" id="main-content">
      <section className="page-hero compact"><p className="eyebrow">学生</p><h1>找到一个学生，继续下一步支持</h1><p className="lede">查看最近学习情况、掌握变化和学习计划，也可以按班级或知识点了解整体进度。</p></section>
      <CardSection eyebrow="添加学生" title="建立教学绑定" description="输入学生注册邮箱。绑定后，你可以查看其学习报告，学生也可以使用你的教学内容。">
        <form className="inline-form" onSubmit={submit}><label>学生邮箱<input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="off" placeholder="student@example.com" required /></label><AsyncButton className="cinnabar" type="submit" pending={add.isPending} pendingLabel="正在添加…">添加学生</AsyncButton></form>
        {feedback && <p className={`status-note ${add.isError ? "error" : "success"}`} aria-live="polite">{feedback}</p>}
      </CardSection>
      <nav className="subnav" aria-label="学生视图">{(["students", "classes", "trends"] as const).map((item) => <button className="subnav-item" aria-selected={tab === item} key={item} onClick={() => setTab(item)}>{titles[item][0]}</button>)}</nav>
      <CardSection eyebrow={titles[tab][0]} title={titles[tab][1]} action={tab === "students" ? <label className="search-field"><span className="sr-only">搜索学生</span><input value={search} onChange={(e) => setSearch(e.target.value)} type="search" placeholder="搜索姓名或学生 ID" /></label> : undefined}>
        {overview.isPending ? <div className="pending-line"><span className="spinner" />正在读取数据…</div> : tab === "students" ? students.length ? <div className="student-grid">{students.map((student) => {
          const binding = bindings.data?.bindings?.find((item) => item.student_id === student.user_id && item.status === "active");
          return <article className="student-card" key={student.user_id}><h3>{student.display_name || "学生"}</h3><p>{student.current_score ?? "—"} → {student.target_score ?? "—"} 分 · 已完成 {student.completed_sessions || 0} 次学习</p><small>{student.latest_snapshot_at ? `最近更新 ${formatDate(student.latest_snapshot_at)}` : "等待首次学习记录"}</small><div className="action-cluster"><Link className="btn" to={`/report?student=${encodeURIComponent(student.user_id)}`}>查看学习报告</Link>{binding && <AsyncButton className={confirmRemove === binding.binding_id ? "cinnabar" : "ghost"} pending={remove.isPending && confirmRemove === binding.binding_id} pendingLabel="正在解除…" onClick={() => { if (confirmRemove === binding.binding_id) remove.mutate(binding.binding_id); else setConfirmRemove(binding.binding_id); }}>{confirmRemove === binding.binding_id ? "再次点击确认解除" : "解除绑定"}</AsyncButton>}</div></article>;
        })}</div> : <EmptyState title="没有找到学生">学生完成绑定后会出现在这里</EmptyState> : rows.length ? <DataTable rows={rows} columns={tab === "classes" ? [["name", "班级"], ["students", "学生数"], ["class_id", "班级 ID"]] : [["student_id", "学生"], ["dimension_id", "知识点"], ["observations", "学习记录"], ["successes", "独立完成"], ["last_observed_at", "最近更新"]]} /> : <EmptyState title="这里还没有数据">完成学习活动后会逐步积累</EmptyState>}
      </CardSection>
    </main>
  );
}
