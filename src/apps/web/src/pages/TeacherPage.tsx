import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AsyncButton } from "../components/feedback/AsyncButton";
import { EmptyState } from "../components/feedback/EmptyState";
import { MathText } from "../components/MathText";
import { apiFetch, formatDate, jsonBody } from "../lib/api";

type ReviewTask = { task_id: string; queue: string; target_type: string; target_id: string; status: string; payload?: Record<string, any> };
type Reviews = { tasks?: ReviewTask[]; pending_count?: number };
type Pipeline = { run_id: string; status: string; stage: string; created_at: string; updated_at?: string; document_ids?: string[]; ktq_session_ref?: string; er_session_ref?: string };
type Pipelines = { runs?: Pipeline[] };
type Overview = { students?: unknown[] };
type QuestionDetail = { source_evidence?: Array<{ document_name?: string; document_id?: string; page_no?: number; fragment_type?: string; source_fragment_id?: string; excerpt?: string }>; assets?: Array<{ image_data_url: string; page_no?: number; knowledge_components?: string[] }> };

function useDebounced<T>(value: T, delay = 250) {
  const [result, setResult] = useState(value);
  useEffect(() => { const timer = window.setTimeout(() => setResult(value), delay); return () => clearTimeout(timer); }, [value, delay]);
  return result;
}

function candidateOf(task: ReviewTask) { return (task.payload?.candidate || task.payload || {}) as Record<string, any>; }
function displayValue(value: any): string {
  if (Array.isArray(value)) return value.map((item) => typeof item === "object" ? item.text_markdown || item.name || JSON.stringify(item) : item).join("、");
  if (value && typeof value === "object") return value.summary || JSON.stringify(value);
  return String(value ?? "");
}

function summaryFields(task: ReviewTask): Array<[string, any]> {
  const candidate = candidateOf(task);
  if (task.target_type === "question") return [["题干", candidate.stem_markdown], ["题型", candidate.stem_format], ["选项", candidate.options], ["答案", candidate.answer || candidate.answer_summary], ["知识关联", candidate.measurement_targets?.map((item: any) => item.dim)]];
  if (task.target_type === "error_cause") return [["错因名称", candidate.name], ["说明", candidate.description], ["研究引用", candidate.citations]];
  if (task.target_type === "diagnosis_rule") return [["触发条件", candidate.trigger], ["确认问题", candidate.probe], ["候选错因", candidate.candidate_error_causes], ["知识关联", candidate.dimension_ids], ["研究引用", candidate.citations]];
  return [["内容", candidate.name || candidate.description || candidate]];
}

function initialEdits(task: ReviewTask): Record<string, string> {
  const candidate = candidateOf(task), saved = task.payload?.modification || {};
  if (task.target_type === "question") return { stem_markdown: displayValue(saved.stem_markdown ?? candidate.stem_markdown), answer_summary: displayValue(saved.answer_summary ?? candidate.answer?.summary ?? candidate.answer_summary) };
  if (task.target_type === "error_cause") return { name: displayValue(saved.name ?? candidate.name), description: displayValue(saved.description ?? candidate.description) };
  if (task.target_type === "diagnosis_rule") return { trigger: displayValue(saved.trigger ?? candidate.trigger), probe: displayValue(saved.probe ?? candidate.probe) };
  return { name: displayValue(saved.name ?? candidate.name) };
}

function editLabel(key: string) { return ({ stem_markdown: "题干", answer_summary: "参考答案说明", name: "名称", description: "错因说明", trigger: "触发条件", probe: "用于确认的问题" } as Record<string, string>)[key] || key; }

function ReviewModal({ task, runs, nextTask, onClose, onContinue }: { task: ReviewTask; runs: Pipeline[]; nextTask?: ReviewTask; onClose: () => void; onContinue: (task: ReviewTask) => void }) {
  const queryClient = useQueryClient();
  const reduced = useReducedMotion();
  const [decision, setDecision] = useState(task.status === "pending" ? "confirmed" : task.status);
  const [edits, setEdits] = useState(() => initialEdits(task));
  const [advanced, setAdvanced] = useState("");
  const [feedback, setFeedback] = useState("");
  const detail = useQuery({ queryKey: ["review-question", task.target_id], queryFn: () => apiFetch<QuestionDetail>(`/api/content/questions/${encodeURIComponent(task.target_id)}/review`), enabled: task.target_type === "question", retry: false });
  const save = useMutation({
    mutationFn: async (continueNext: boolean) => {
      let extra = {};
      if (advanced.trim()) { try { extra = JSON.parse(advanced); } catch { throw new Error("高级字段不是有效的 JSON。 "); } }
      const modification = { ...extra, ...Object.fromEntries(Object.entries(edits).filter(([, value]) => value.trim())) };
      await apiFetch(`/api/review/tasks/${encodeURIComponent(task.task_id)}`, { method: "PATCH", ...jsonBody({ status: decision, ...(["modified", "merged"].includes(decision) ? { modification } : {}) }) });
      return continueNext;
    },
    onSuccess: async (continueNext) => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["reviews"] }), queryClient.invalidateQueries({ queryKey: ["pending-review-count"] })]);
      if (continueNext && nextTask) onContinue(nextTask);
      else onClose();
    },
    onError: (error) => setFeedback(error instanceof Error ? error.message : "保存失败，请稍后重试。"),
  });
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const handler = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", handler);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handler);
    };
  }, [onClose]);
  const run = runs.find((item) => item.run_id === task.payload?.source_pipeline_id);
  const sessionRef = task.target_type === "question" ? run?.ktq_session_ref : run?.er_session_ref;

  return <motion.div className="modal-backdrop" role="presentation" initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : 0.16 }} onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <motion.section id="reviewDialog" className="proof-sheet review-dialog-form react-review-dialog" role="dialog" aria-modal="true" aria-labelledby="review-dialog-title" initial={reduced ? false : { opacity: 0, scale: 0.96, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98, y: 4 }} transition={{ duration: reduced ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}>
      <div className="dialog-head"><div><p className="eyebrow">复核事项</p><h2 id="review-dialog-title">{({ question: "复核题目", error_cause: "复核错因", diagnosis_rule: "复核诊断规则" } as Record<string, string>)[task.target_type] || "复核内容"}</h2></div><button className="icon-button" type="button" aria-label="关闭" onClick={onClose}><X /></button></div>
      <div className="review-source"><h3>候选内容与来源</h3><div id="taskSummary" className="review-summary">{summaryFields(task).filter(([, value]) => value != null && value !== "" && (!Array.isArray(value) || value.length)).map(([label, value]) => <div key={label}><strong>{label}</strong><MathText text={displayValue(value)} /></div>)}<small className="muted">{task.payload?.chapter_id ? `来自本次资料任务 · ${task.payload.chapter_id}` : "来自当前学习记录"}</small>{sessionRef && <Link className="review-session-link" to={`/agent-session?ref=${encodeURIComponent(sessionRef)}`}>{task.target_type === "question" ? "查看题目整理对话" : "查看诊断研究对话"}</Link>}</div>
        {!!detail.data?.source_evidence?.length && <div id="taskEvidence" className="review-evidence"><h3>来源片段（{detail.data.source_evidence.length}）</h3>{detail.data.source_evidence.map((source, index) => <article key={source.source_fragment_id || index}><strong>{source.document_name || source.document_id || "原始资料"}</strong><small>{[source.page_no ? `第 ${source.page_no} 页` : "", source.fragment_type, source.source_fragment_id].filter(Boolean).join(" · ")}</small>{source.excerpt && <MathText text={source.excerpt} />}</article>)}</div>}
        {!!detail.data?.assets?.length && <div id="taskAssets" className="review-assets"><h3>题图（{detail.data.assets.length}）</h3>{detail.data.assets.map((asset, index) => <figure key={index}><img src={asset.image_data_url} alt={`题目 ${task.target_id} 的题图`} width="1200" height="900" loading="lazy" decoding="async" /><figcaption>{[asset.page_no ? `第 ${asset.page_no} 页` : "", ...(asset.knowledge_components || [])].filter(Boolean).join(" · ")}</figcaption></figure>)}</div>}
      </div>
      <label>处理结果<select value={decision} onChange={(e) => setDecision(e.target.value)}><option value="confirmed">确认</option><option value="modified">修改后确认</option><option value="rejected">退回</option><option value="merged">合并到已有内容</option></select></label>
      {["modified", "merged"].includes(decision) && <div className="review-edit-fields"><h3>需要调整的内容</h3>{Object.entries(edits).map(([key, value]) => <label key={key}>{editLabel(key)}<textarea rows={key === "name" ? 2 : 4} value={value} onChange={(e) => setEdits((current) => ({ ...current, [key]: e.target.value }))} /></label>)}<details className="advanced-editor"><summary>高级字段</summary><p className="muted">仅在需要调整选项、测量维度或其他结构化字段时使用。</p><label>结构化修改<textarea rows={6} value={advanced} onChange={(e) => setAdvanced(e.target.value)} placeholder="可选 JSON" /></label></details></div>}
      {feedback && <p className="status-note error" aria-live="polite">{feedback}</p>}
      <div className="action-cluster"><button type="button" className="btn ghost" onClick={onClose}>稍后处理</button><AsyncButton className="ghost" pending={save.isPending} pendingLabel="保存中…" onClick={() => save.mutate(false)}>仅保存</AsyncButton><AsyncButton id="saveAndContinue" className="cinnabar" pending={save.isPending} pendingLabel="保存中…" onClick={() => save.mutate(true)}>保存并继续</AsyncButton></div>
    </motion.section>
  </motion.div>;
}

export function TeacherPage() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get("q") || "");
  const deferredSearch = useDebounced(search);
  const [queue, setQueue] = useState(params.get("queue") || "");
  const [type, setType] = useState(params.get("type") || "");
  const [page, setPage] = useState(Math.max(0, Number(params.get("page") || 1) - 1));
  const [selected, setSelected] = useState<ReviewTask | null>(null);
  const [correction, setCorrection] = useState({ target_id: "", replacement_outcome: "success", reason: "" });
  const pageSize = 12;
  const pipeline = params.get("pipeline") || "";
  const reviewParams = new URLSearchParams({ status: "pending", limit: String(pageSize), offset: String(page * pageSize) });
  if (queue) reviewParams.set("queue", queue); if (type) reviewParams.set("target_type", type); if (deferredSearch.trim()) reviewParams.set("q", deferredSearch.trim()); if (pipeline) reviewParams.set("source_pipeline_id", pipeline);
  const reviews = useQuery({ queryKey: ["reviews", reviewParams.toString()], queryFn: () => apiFetch<Reviews>(`/api/review/tasks?${reviewParams}`) });
  const pending = useQuery({ queryKey: ["pending-review-count"], queryFn: () => apiFetch<Reviews>("/api/review/tasks?status=pending&limit=1") });
  const pipelines = useQuery({ queryKey: ["content-pipelines"], queryFn: () => apiFetch<Pipelines>("/api/content/pipelines") });
  const overview = useQuery({ queryKey: ["admin", "overview"], queryFn: () => apiFetch<Overview>("/api/admin/overview") });
  const tasks = (reviews.data?.tasks ?? []).filter((task) => task.status === "pending");
  const total = Number(reviews.data?.pending_count ?? tasks.length), pages = Math.max(1, Math.ceil(total / pageSize));
  const runs = pipelines.data?.runs ?? [];
  const activeRuns = runs.filter((run) => ["draft", "queued", "running"].includes(run.status)).length;
  const sync = (next: { queue?: string; type?: string; search?: string; page?: number }) => {
    const q = next.queue ?? queue, t = next.type ?? type, s = next.search ?? search, p = next.page ?? page;
    const copy = new URLSearchParams(params); copy.set("view", "review"); q ? copy.set("queue", q) : copy.delete("queue"); t ? copy.set("type", t) : copy.delete("type"); s.trim() ? copy.set("q", s.trim()) : copy.delete("q"); p ? copy.set("page", String(p + 1)) : copy.delete("page"); setParams(copy, { replace: true });
  };
  const correctionMutation = useMutation({ mutationFn: () => apiFetch("/api/review/corrections", { method: "POST", ...jsonBody(correction) }) });

  return <>
    <main className="page page-stack" id="main-content">
      <section className="page-hero compact teacher-welcome"><p className="eyebrow">教师工作台</p><h1>今天先处理最需要你判断的事情</h1><p className="lede">从待复核内容、进行中的资料任务和学生动态继续。每项任务都会带你回到上次停下的位置。</p></section>
      <section className="priority-grid" aria-label="今日任务"><Link className="priority-card is-primary" to="/teacher?view=review"><span className="priority-count">{pending.data?.pending_count ?? "—"}</span><div><h2>待复核</h2><p>确认题目、错因和学生诊断</p></div><span className="priority-arrow">→</span></Link><Link className="priority-card" to="/content"><span className="priority-count">{activeRuns}</span><div><h2>内容任务</h2><p>继续待确认或正在处理的资料</p></div><span className="priority-arrow">→</span></Link><Link className="priority-card" to="/admin?view=students"><span className="priority-count">{overview.data?.students?.length ?? "—"}</span><div><h2>学生</h2><p>查看最近学习情况和计划</p></div><span className="priority-arrow">→</span></Link></section>
      <section className="section-card"><div className="section-heading"><div><p className="eyebrow">最近任务</p><h2>继续处理</h2></div><Link className="btn ghost" to="/content">查看全部内容</Link></div><div className="run-list">{runs.length ? runs.slice(0, 4).map((run) => { const ref = run.stage === "er" ? run.er_session_ref : run.ktq_session_ref; return <Link className="work-row" key={run.run_id} to={run.status === "draft" || !ref ? "/content" : `/agent-session?ref=${encodeURIComponent(ref)}`}><span className={`work-state ${run.status}`}>{({ draft: "等待确认", queued: "准备中", running: "处理中", review_ready: "等待复核", failed: "需要处理" } as Record<string, string>)[run.status] || run.status}</span><span className="work-copy"><strong>{run.document_ids?.length || 0} 个文件</strong><small>{formatDate(run.updated_at || run.created_at)}</small></span><span className="priority-arrow">→</span></Link>; }) : <EmptyState title="还没有内容任务" action={<Link className="btn" to="/content">添加资料</Link>}>添加教学资料后，进度会出现在这里</EmptyState>}</div></section>
      <section className="section-card" id="reviewArea"><div className="section-heading"><div><p className="eyebrow">复核</p><h2>需要你的判断</h2><p className="muted">打开一项任务，核对内容和来源后保存结果。</p>{pipeline && <p id="reviewScope" className="review-scope">正在查看一批资料的复核事项 · <Link to="/teacher?view=review&queue=content">查看全部</Link></p>}</div><span id="reviewCount" className="paper-tag">{total} 项</span></div>
        <div className="review-toolbar" aria-label="筛选复核事项"><label className="search-field"><span className="sr-only">搜索复核事项</span><input id="reviewSearch" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); sync({ search: e.target.value, page: 0 }); }} type="search" placeholder="搜索题干、名称或 ID" /></label><label className="compact-field">任务<select value={queue} onChange={(e) => { setQueue(e.target.value); setPage(0); sync({ queue: e.target.value, page: 0 }); }}><option value="">全部任务</option><option value="content">教学内容</option><option value="student_diagnosis">学生诊断</option></select></label><label className="compact-field">内容<select value={type} onChange={(e) => { setType(e.target.value); setPage(0); sync({ type: e.target.value, page: 0 }); }}><option value="">全部类型</option><option value="question">题目</option><option value="error_cause">错因</option><option value="diagnosis_rule">诊断规则</option></select></label></div>
        {reviews.isPending ? <div className="pending-line"><span className="spinner" />正在读取待复核事项…</div> : tasks.length ? <div className="review-list">{tasks.map((task) => { const candidate = candidateOf(task); return <button type="button" className="review-list-item" key={task.task_id} onClick={() => setSelected(task)}><span><strong>{task.queue === "content" ? ({ question: "题目", error_cause: "错因", diagnosis_rule: "诊断规则" } as Record<string, string>)[task.target_type] || "教学内容" : "学生诊断"}</strong><small>{String(candidate.stem_markdown || candidate.name || candidate.trigger || task.target_id || "").slice(0, 100)}</small></span><span className="review-action">开始复核</span></button>; })}</div> : <EmptyState title="没有符合条件的事项">可以调整搜索或筛选条件</EmptyState>}
        {pages > 1 && <nav className="review-pager" aria-label="复核事项分页"><button className="btn ghost" type="button" disabled={!page} onClick={() => { const next = page - 1; setPage(next); sync({ page: next }); }}>上一页</button><span>第 {page + 1} / {pages} 页</span><button className="btn ghost" type="button" disabled={page + 1 >= pages} onClick={() => { const next = page + 1; setPage(next); sync({ page: next }); }}>下一页</button></nav>}
      </section>
      <details className="section-card correction-panel"><summary>纠正一条已有结论</summary><p className="muted">当已有诊断需要更新时，填写原记录和新的结果。</p><form className="correction-form" onSubmit={(event: FormEvent) => { event.preventDefault(); correctionMutation.mutate(); }}><label>原记录 ID<input value={correction.target_id} onChange={(e) => setCorrection((current) => ({ ...current, target_id: e.target.value }))} required placeholder="obs_…" /></label><label>更新为<select value={correction.replacement_outcome} onChange={(e) => setCorrection((current) => ({ ...current, replacement_outcome: e.target.value }))}><option value="success">已掌握</option><option value="failure">需要继续学习</option><option value="unresolved">继续观察</option></select></label><label>说明<textarea value={correction.reason} onChange={(e) => setCorrection((current) => ({ ...current, reason: e.target.value }))} required rows={3} placeholder="记录这次更新的依据" /></label><AsyncButton className="cinnabar" type="submit" pending={correctionMutation.isPending} pendingLabel="正在保存…">保存更新</AsyncButton></form>{correctionMutation.isSuccess && <p className="status-note success">更新已保存，相关学习状态会重新计算。</p>}{correctionMutation.isError && <p className="status-note error">保存失败，请重试。</p>}</details>
    </main>
    <AnimatePresence>{selected && <ReviewModal key={selected.task_id} task={selected} runs={runs} nextTask={tasks.find((task) => task.task_id !== selected.task_id)} onClose={() => setSelected(null)} onContinue={setSelected} />}</AnimatePresence>
  </>;
}
