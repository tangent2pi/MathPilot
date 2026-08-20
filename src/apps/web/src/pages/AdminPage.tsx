import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clipboard, RefreshCw } from "lucide-react";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AsyncButton } from "../components/feedback/AsyncButton";
import { EmptyState } from "../components/feedback/EmptyState";
import { apiFetch, formatDate, jsonBody } from "../lib/api";

type Student = { user_id: string; display_name?: string; current_score?: number; target_score?: number; completed_sessions?: number; latest_snapshot_at?: string };
type Binding = { binding_id: string; student_id: string; status: string };
type Classroom = { class_id: string; name: string; join_code: string; join_code_updated_at?: string; student_count?: number };
type Overview = { students?: Student[]; classes?: Array<Record<string, unknown>>; trends?: Array<Record<string, unknown>>; packages?: Array<Record<string, unknown>>; golden_runs?: Array<Record<string, unknown>> };
type Bindings = { bindings?: Binding[] };
type Classes = { classes?: Classroom[] };

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
  const [className, setClassName] = useState("");
  const [feedback, setFeedback] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const overview = useQuery({ queryKey: ["admin", "overview"], queryFn: () => apiFetch<Overview>("/api/admin/overview") });
  const bindings = useQuery({ queryKey: ["teacher-bindings"], queryFn: () => apiFetch<Bindings>("/api/teacher-student-bindings") });
  const classes = useQuery({ queryKey: ["classes"], queryFn: () => apiFetch<Classes>("/api/classes") });
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ["admin", "overview"] }), queryClient.invalidateQueries({ queryKey: ["teacher-bindings"] }), queryClient.invalidateQueries({ queryKey: ["classes"] })]);
  const createClass = useMutation({
    mutationFn: () => apiFetch<Classroom>("/api/classes", { method: "POST", ...jsonBody({ name: className.trim() }) }),
    onSuccess: async (created) => { setFeedback(`${created.name} 已创建，班级码为 ${created.join_code}。`); setClassName(""); await refresh(); },
    onError: () => setFeedback("暂时无法创建班级，请稍后重试。"),
  });
  const regenerate = useMutation({ mutationFn: (id: string) => apiFetch<Classroom>(`/api/classes/${encodeURIComponent(id)}/regenerate-code`, { method: "POST" }), onSuccess: async () => { setFeedback("新的班级码已生成，原班级码不再使用。"); await refresh(); } });
  const remove = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/teacher-student-bindings/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: async () => { setConfirmRemove(null); await refresh(); },
  });
  const submitClass = (event: FormEvent) => { event.preventDefault(); setFeedback(""); createClass.mutate(); };
  const students = useMemo(() => (overview.data?.students ?? []).filter((row) => !search.trim() || `${row.display_name || ""} ${row.user_id}`.toLowerCase().includes(search.trim().toLowerCase())), [overview.data?.students, search]);

  if (mode === "settings") {
    const packages = overview.data?.packages ?? [];
    const evaluations = overview.data?.golden_runs ?? [];
    return <main className="page page-stack" id="main-content">
      <section className="page-hero compact"><p className="eyebrow">设置</p><h1>管理教师空间</h1><p className="lede">查看账户信息、数据导出和内容版本。</p></section>
      <CardSection eyebrow="个人资料" title="账户设置" description="更新头像、昵称、邮箱和联系电话。" action={<Link className="btn ghost" to="/account">管理账户</Link>}><p className="muted">账户资料会显示在教师空间和学生的班级信息中。</p></CardSection>
      <CardSection eyebrow="内容版本" title="已发布内容" description="查看当前可用的内容版本和发布时间。" action={<Link className="btn ghost" to="/library">浏览已发布内容</Link>}>{packages.length ? <DataTable rows={packages} columns={[["chapter_id", "内容集"], ["version", "版本"], ["published_at", "发布时间"], ["manifest_hash", "内容标识"]]} /> : <EmptyState>还没有已发布内容</EmptyState>}</CardSection>
      <CardSection eyebrow="评估记录" title="质量检查" description="查看最近的自动检查和回归结果。">{evaluations.length ? <DataTable rows={evaluations} columns={[["eval_kind", "检查类型"], ["golden_set", "数据集"], ["metrics", "结果"], ["created_at", "时间"]]} /> : <EmptyState>还没有质量检查记录</EmptyState>}</CardSection>
      <CardSection eyebrow="数据" title="导出工作区数据" description="用于备份、教研分析或迁移。" action={<a className="btn cinnabar" href="/api/admin/export" download>导出完整数据</a>}><div className="export-grid">{Object.entries(exportsList).map(([id, label]) => <a className="export-card" href={`/api/admin/export?format=csv&dataset=${id}`} download={`${id}.csv`} key={id}><strong>{label}</strong><span>CSV 下载</span></a>)}</div></CardSection>
    </main>;
  }

  const titles = { students: ["学生", "学生列表"], classes: ["班级", "班级概览"], trends: ["学习趋势", "最近知识变化"] } as const;
  const rows = overview.data?.trends ?? [];
  return (
    <main className="page page-stack" id="main-content">
      <section className="page-hero compact"><p className="eyebrow">学生</p><h1>找到一个学生，继续下一步支持</h1><p className="lede">查看最近学习情况、掌握变化和学习计划，也可以按班级或知识点了解整体进度。</p></section>
      <nav className="subnav" aria-label="学生视图">{(["students", "classes", "trends"] as const).map((item) => <button className="subnav-item" aria-selected={tab === item} key={item} onClick={() => setTab(item)}>{titles[item][0]}</button>)}</nav>
      {tab === "classes" && <CardSection eyebrow="新班级" title="创建班级并邀请学生" description="创建后把班级码发给学生，学生在自己的账户中输入班级码即可加入。"><form className="inline-form class-create-form" onSubmit={submitClass}><label>班级名称<input value={className} onChange={(event) => setClassName(event.target.value)} maxLength={80} placeholder="例如：高二（3）班" required /></label><AsyncButton className="cinnabar" type="submit" pending={createClass.isPending} pendingLabel="正在创建…">创建班级</AsyncButton></form>{feedback && <p className={`status-note ${createClass.isError || regenerate.isError ? "error" : "success"}`} aria-live="polite">{feedback}</p>}</CardSection>}
      <CardSection eyebrow={titles[tab][0]} title={titles[tab][1]} action={tab === "students" ? <label className="search-field"><span className="sr-only">搜索学生</span><input value={search} onChange={(e) => setSearch(e.target.value)} type="search" placeholder="搜索姓名或学生 ID" /></label> : undefined}>
        {overview.isPending || classes.isPending ? <div className="pending-line"><span className="spinner" />正在读取数据…</div> : tab === "students" ? students.length ? <div className="student-grid">{students.map((student) => {
          const binding = bindings.data?.bindings?.find((item) => item.student_id === student.user_id && item.status === "active");
          return <article className="student-card" key={student.user_id}><h3>{student.display_name || "学生"}</h3><p>{student.current_score ?? "—"} → {student.target_score ?? "—"} 分 · 已完成 {student.completed_sessions || 0} 次学习</p><small>{student.latest_snapshot_at ? `最近更新 ${formatDate(student.latest_snapshot_at)}` : "等待首次学习记录"}</small><div className="action-cluster"><Link className="btn" to={`/report?student=${encodeURIComponent(student.user_id)}`}>查看学习报告</Link>{binding && <AsyncButton className={confirmRemove === binding.binding_id ? "cinnabar" : "ghost"} pending={remove.isPending && confirmRemove === binding.binding_id} pendingLabel="正在解除…" onClick={() => { if (confirmRemove === binding.binding_id) remove.mutate(binding.binding_id); else setConfirmRemove(binding.binding_id); }}>{confirmRemove === binding.binding_id ? "再次点击确认解除" : "解除绑定"}</AsyncButton>}</div></article>;
        })}</div> : <EmptyState title="没有找到学生">学生使用班级码加入后会出现在这里</EmptyState> : tab === "classes" ? (classes.data?.classes?.length ? <div className="class-grid">{classes.data.classes.map((classroom) => <article className="class-card" key={classroom.class_id}><div><p className="eyebrow">{classroom.student_count || 0} 名学生</p><h3>{classroom.name}</h3></div><div className="class-code"><span>班级码</span><strong>{classroom.join_code}</strong><button className="icon-button" type="button" aria-label={`复制 ${classroom.name} 的班级码`} onClick={async () => { await navigator.clipboard.writeText(classroom.join_code); setFeedback("班级码已复制。"); }}><Clipboard /></button></div><AsyncButton className="ghost" pending={regenerate.isPending} pendingLabel="正在生成…" onClick={() => regenerate.mutate(classroom.class_id)}><RefreshCw aria-hidden="true" />更换班级码</AsyncButton></article>)}</div> : <EmptyState title="还没有班级">创建一个班级，获得学生加入所需的班级码。</EmptyState>) : rows.length ? <DataTable rows={rows} columns={[["student_id", "学生"], ["dimension_id", "知识点"], ["observations", "学习记录"], ["successes", "独立完成"], ["last_observed_at", "最近更新"]]} /> : <EmptyState title="这里还没有数据">完成学习活动后会逐步积累</EmptyState>}
      </CardSection>
    </main>
  );
}
