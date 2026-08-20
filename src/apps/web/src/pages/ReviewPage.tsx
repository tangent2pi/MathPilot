import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronLeft, ChevronRight, ExternalLink, Layers3, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AsyncButton } from "../components/feedback/AsyncButton";
import { BackButton } from "../components/BackButton";
import { EmptyState } from "../components/feedback/EmptyState";
import { MathText } from "../components/MathText";
import { apiFetch, formatDate, jsonBody } from "../lib/api";
import { candidateTitle, formatAnswer, optionLabel, reviewStatusLabel, reviewTypeLabel, stemFormatLabel } from "../lib/content";

type ReviewTask = {
  task_id: string;
  queue: string;
  target_type: string;
  target_id: string;
  status: string;
  created_at?: string;
  resolved_at?: string;
  payload?: Record<string, any>;
};
type Reviews = { tasks?: ReviewTask[]; filtered_count?: number; pending_count?: number };
type Evidence = { source_fragment_id?: string; document_name?: string; document_id?: string; page_no?: number; fragment_type?: string; excerpt?: string; field_paths?: string[] };
type Detail = Record<string, any> & {
  payload?: Record<string, any>;
  dimension_names?: Record<string, { name: string; type: "knowledge_component" | "question_type" }>;
  source_evidence?: Evidence[];
  assets?: Array<{ asset_id?: string; image_data_url?: string; page_no?: number; knowledge_components?: string[] }>;
  related_questions?: Array<{ question_id: string; stem_format?: string; stem?: string }>;
};

const decisions = [
  ["confirmed", "确认"],
  ["modified", "修改后确认"],
  ["rejected", "退回"],
  ["merged", "合并"],
] as const;
const fieldPathLabel: Record<string, string> = {
  "/stem_markdown": "题干",
  "/answer": "答案",
  "/options": "选项",
  "/measurement_targets": "知识关联",
  "/rubric": "评分依据",
  "/name": "名称",
  "/trigger": "触发条件",
};

function candidateOf(task: ReviewTask): Record<string, any> {
  return (task.payload?.candidate || task.payload || {}) as Record<string, any>;
}

function initialEdits(task: ReviewTask): Record<string, string> {
  const candidate = candidateOf(task), saved = task.payload?.modification ?? {};
  if (task.target_type === "question") return {
    stem_markdown: String(saved.stem_markdown ?? candidate.stem_markdown ?? ""),
    answer_summary: String(saved.answer_summary ?? candidate.answer?.summary ?? candidate.answer_summary ?? formatAnswer(candidate.answer)),
  };
  if (task.target_type === "error_cause") return { name: String(saved.name ?? candidate.name ?? ""), description: String(saved.description ?? candidate.description ?? "") };
  if (task.target_type === "diagnosis_rule") return { trigger: String(saved.trigger ?? candidate.trigger ?? ""), probe: String(saved.probe ?? candidate.probe ?? "") };
  return { name: String(saved.name ?? candidate.name ?? "") };
}

function taskLabel(task: ReviewTask): string {
  const candidate = candidateOf(task);
  if (task.target_type === "question") return stemFormatLabel[candidate.stem_format] || "题目";
  return reviewTypeLabel[task.target_type] || "复核内容";
}

function uniqueEvidence(items: Evidence[] = []): Evidence[] {
  const unique = new Map<string, Evidence>();
  for (const item of items) {
    const key = [item.document_id || item.document_name || "", item.page_no ?? "", item.fragment_type || "", (item.excerpt || "").trim()].join("\0");
    const previous = unique.get(key);
    if (!previous) unique.set(key, { ...item, field_paths: [...new Set(item.field_paths ?? [])] });
    else previous.field_paths = [...new Set([...(previous.field_paths ?? []), ...(item.field_paths ?? [])])];
  }
  return [...unique.values()];
}

function Summary({ task, detail }: { task: ReviewTask; detail?: Detail }) {
  // The review endpoint returns the candidate fields at the top level. Keep the
  // nested payload fallback for older persisted responses and test fixtures.
  const candidate = { ...candidateOf(task), ...(detail ?? {}), ...(detail?.payload ?? {}) };
  if (task.target_type === "question") {
    const options = Array.isArray(candidate.options) ? candidate.options : [];
    const targets = Array.isArray(candidate.measurement_targets) ? candidate.measurement_targets : [];
    const rubricItems = Array.isArray(candidate.rubric?.items) ? candidate.rubric.items : [];
    return <div className="review-content-blocks">
      <section><div className="content-label">题目类型</div><p>{stemFormatLabel[candidate.stem_format] || "题目"}</p></section>
      <section><div className="content-label">题干</div><MathText text={candidate.stem_markdown || ""} /></section>
      {!!options.length && <section><div className="content-label">选项</div><ol className="answer-options">{options.map((option: any, index: number) => <li key={`${option.key || index}`}><strong>{optionLabel(index, option.key)}</strong><MathText text={option.text_markdown || String(option)} /></li>)}</ol></section>}
      <section><div className="content-label">参考答案</div><MathText text={formatAnswer(candidate.answer ?? candidate.answer_summary)} /></section>
      {!!rubricItems.length && <section><div className="content-label">解题要点</div><ol className="solution-outline">{rubricItems.map((item: any, index: number) => <li key={item.id || index}><MathText text={item.description || ""} /></li>)}</ol></section>}
      <section><div className="content-label">知识关联</div><div className="knowledge-links">{targets.length ? targets.map((target: any) => {
        const dimension = detail?.dimension_names?.[target.dim];
        return target.dim && <Link key={target.dim} to={`/review?status=all&type=${dimension?.type || (String(target.dim).startsWith("T_") ? "question_type" : "knowledge_component")}&q=${encodeURIComponent(target.dim)}`}>{dimension?.name || target.name || target.dim}<ExternalLink aria-hidden="true" /></Link>;
      }) : <span className="muted">暂无关联</span>}</div></section>
      {candidate.question_type?.id && <section><div className="content-label">题型</div><Link className="text-link" to={`/review?status=all&type=question_type&q=${encodeURIComponent(candidate.question_type.id)}`}>{detail?.dimension_names?.[candidate.question_type.id]?.name || candidate.question_type.name || candidate.question_type.id}<ExternalLink aria-hidden="true" /></Link></section>}
    </div>;
  }
  if (task.target_type === "diagnosis_rule") return <div className="review-content-blocks"><section><div className="content-label">触发条件</div><MathText text={candidate.trigger || ""} /></section><section><div className="content-label">确认问题</div><MathText text={candidate.probe || ""} /></section><section><div className="content-label">候选错因</div><p>{(candidate.candidate_error_causes || []).join("、") || "暂无"}</p></section></div>;
  return <div className="review-content-blocks"><section><div className="content-label">名称</div><h3>{candidate.name || task.target_id}</h3></section>{candidate.description && <section><div className="content-label">说明</div><MathText text={candidate.description} /></section>}</div>;
}

function ReviewDetail({ task, tasks, onMove }: { task: ReviewTask; tasks: ReviewTask[]; onMove: (task: ReviewTask, replace?: boolean) => void }) {
  const queryClient = useQueryClient();
  const index = tasks.findIndex((item) => item.task_id === task.task_id);
  const [decision, setDecision] = useState(task.status === "pending" ? "" : task.status);
  const [edits, setEdits] = useState<Record<string, string>>(() => initialEdits(task));
  const [removedAssets, setRemovedAssets] = useState<string[]>([]);
  const [feedback, setFeedback] = useState("");
  useEffect(() => { setDecision(task.status === "pending" ? "" : task.status); setEdits(initialEdits(task)); setRemovedAssets([]); setFeedback(""); }, [task.task_id, task.status]);
  const detailPath = task.target_type === "question"
    ? `/api/content/questions/${encodeURIComponent(task.target_id)}/review`
    : `/api/content/entities/${encodeURIComponent(task.target_type)}/${encodeURIComponent(task.target_id)}/review`;
  const detail = useQuery({ queryKey: ["review-detail", task.target_type, task.target_id], queryFn: () => apiFetch<Detail>(detailPath), retry: false });
  const evidence = uniqueEvidence(detail.data?.source_evidence);
  const save = useMutation({
    mutationFn: (nextDecision: string) => apiFetch(`/api/review/tasks/${encodeURIComponent(task.task_id)}`, {
      method: "PATCH",
      ...jsonBody({ status: nextDecision, ...(nextDecision === "modified" ? { modification: { ...edits, ...(removedAssets.length ? { remove_asset_ids: removedAssets } : {}) } } : {}) }),
    }),
    onSuccess: async () => {
      const next = tasks[index + 1];
      if (next) onMove(next, true);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["reviews"] }),
        queryClient.invalidateQueries({ queryKey: ["pending-review-count"] }),
        queryClient.invalidateQueries({ queryKey: ["content-pipelines"] }),
      ]);
    },
    onError: (error) => setFeedback(error instanceof Error ? error.message : "保存失败，请重试。"),
  });
  const editLabels: Record<string, string> = { stem_markdown: "题干", answer_summary: "参考答案", name: "名称", description: "说明", trigger: "触发条件", probe: "确认问题" };
  const hasModification = task.status === "modified" || removedAssets.length > 0 || JSON.stringify(edits) !== JSON.stringify(initialEdits(task));
  const choose = (nextDecision: string) => { setDecision(nextDecision); setFeedback(""); save.mutate(nextDecision); };

  return <article className="review-detail-panel">
    <header className="review-detail-head"><div><div className="review-detail-meta"><span className={`review-state ${task.status}`}>{reviewStatusLabel[task.status] || task.status}</span><span>{taskLabel(task)}</span><span className="mono">{task.target_id}</span></div><MathText as="h2" text={candidateTitle(candidateOf(task), task.target_id)} /><p className="muted">{formatDate(task.resolved_at || task.created_at, "")}</p></div><div className="review-neighbors"><button type="button" className="icon-button" disabled={index <= 0} aria-label="上一项" onClick={() => onMove(tasks[index - 1]!)}><ChevronLeft /></button><span>{index + 1} / {tasks.length}</span><button type="button" className="icon-button" disabled={index < 0 || index + 1 >= tasks.length} aria-label="下一项" onClick={() => onMove(tasks[index + 1]!)}><ChevronRight /></button></div></header>
    {detail.isPending ? <div className="pending-line"><span className="spinner" />正在读取内容和来源…</div> : <Summary task={task} detail={detail.data} />}
    {!!evidence.length && <details className="review-disclosure review-evidence"><summary><span><strong>来源</strong><small>{evidence.length} 个片段</small></span><ChevronRight aria-hidden="true" /></summary><div className="review-disclosure-body">{evidence.map((source, sourceIndex) => <article key={source.source_fragment_id || sourceIndex}><strong>{source.document_name || source.document_id || "原始资料"}</strong><small>{[source.page_no ? `第 ${source.page_no} 页` : "", source.field_paths?.map((path) => fieldPathLabel[path] || path).join("、")].filter(Boolean).join(" · ")}</small>{source.excerpt && <MathText text={source.excerpt} />}</article>)}</div></details>}
    {!!detail.data?.assets?.length && <section className="review-assets"><div className="section-heading"><div><p className="eyebrow">题图</p><h3>{detail.data.assets.length} 张</h3><p className="muted">发现错配题图时，先标记移除，再选择“修改后确认”。</p></div></div><div className="review-image-grid">{detail.data.assets.map((asset, imageIndex) => { const assetId = asset.asset_id || `image-${imageIndex}`, removed = removedAssets.includes(assetId); return <figure className={removed ? "is-removed" : ""} key={assetId}>{asset.image_data_url && <img src={asset.image_data_url} alt={`题目 ${task.target_id} 的第 ${imageIndex + 1} 张题图`} width="1200" height="900" loading="lazy" decoding="async" />}<figcaption><span>{[asset.page_no ? `第 ${asset.page_no} 页` : "", ...(asset.knowledge_components || []).map((id) => detail.data?.dimension_names?.[id]?.name || id)].filter(Boolean).join(" · ") || `题图 ${imageIndex + 1}`}</span>{asset.asset_id && <button className="text-button" type="button" onClick={() => { setRemovedAssets((current) => removed ? current.filter((id) => id !== assetId) : [...current, assetId]); setDecision("modified"); }}><Trash2 aria-hidden="true" />{removed ? "恢复" : "标记移除"}</button>}</figcaption></figure>; })}</div></section>}
    {!!detail.data?.related_questions?.length && <details className="review-disclosure"><summary><span><strong>关联题目</strong><small>{detail.data.related_questions.length} 道</small></span><ChevronRight aria-hidden="true" /></summary><div className="review-disclosure-body related-question-list">{detail.data.related_questions.map((item) => <Link key={item.question_id} to={`/review?status=all&type=question&q=${encodeURIComponent(item.question_id)}`}><span>{stemFormatLabel[item.stem_format || ""] || "题目"}</span><MathText as="span" text={item.stem || item.question_id} /></Link>)}</div></details>}
    <section className="review-decision-section"><div className="section-heading"><div><p className="eyebrow">复核结果</p><h3>选择处理方式</h3><p className="muted">点击状态后立即保存，并自动进入下一项；发布前可以随时回来覆盖选择。</p></div></div>
      <details className="review-edit-disclosure"><summary>需要修改内容</summary><div className="review-edit-fields">{Object.entries(edits).map(([key, value]) => <label key={key}>{editLabels[key] || key}<textarea rows={key === "name" ? 2 : 4} value={value} onChange={(event) => { setEdits((current) => ({ ...current, [key]: event.target.value })); setDecision("modified"); }} /></label>)}</div></details>
      <div className="decision-buttons">{decisions.map(([id, label]) => <button key={id} type="button" disabled={save.isPending || (id === "modified" && !hasModification)} aria-pressed={decision === id} className={decision === id ? "is-selected" : ""} title={id === "modified" && !hasModification ? "先修改文字或题图" : undefined} onClick={() => choose(id)}>{save.isPending && decision === id ? <span className="spinner" /> : decision === id ? <Check aria-hidden="true" /> : null}{label}</button>)}</div>
      {feedback && <p className={`status-note ${save.isError ? "error" : "success"}`} aria-live="polite">{feedback}</p>}
    </section>
  </article>;
}

export function ReviewPage() {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const status = params.get("status") || "pending";
  const type = params.get("type") || "";
  const stemFormat = params.get("format") || "";
  const queue = params.get("queue") || "content";
  const pipeline = params.get("pipeline") || "";
  const search = params.get("q") || "";
  const page = Math.max(0, Number(params.get("page") || "1") - 1);
  const pageSize = 30;
  const [searchInput, setSearchInput] = useState(search);
  const [checked, setChecked] = useState<string[]>([]);
  const [bulkDecision, setBulkDecision] = useState<"confirmed" | "rejected" | "merged">("confirmed");
  const queryParams = new URLSearchParams({ queue, limit: String(pageSize), offset: String(page * pageSize) });
  if (status !== "all") queryParams.set("status", status);
  if (type) queryParams.set("target_type", type);
  if (stemFormat) queryParams.set("stem_format", stemFormat);
  if (pipeline) queryParams.set("source_pipeline_id", pipeline);
  if (search) queryParams.set("q", search);
  const reviews = useQuery({ queryKey: ["reviews", queryParams.toString()], queryFn: () => apiFetch<Reviews>(`/api/review/tasks?${queryParams}`) });
  const tasks = useMemo(() => reviews.data?.tasks ?? [], [reviews.data?.tasks]);
  const selectedId = params.get("task") || tasks[0]?.task_id || "";
  const selected = tasks.find((task) => task.task_id === selectedId) || tasks[0];
  const total = Number(reviews.data?.filtered_count ?? (status === "pending" ? reviews.data?.pending_count : tasks.length) ?? 0);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const update = (patch: Record<string, string | null>, replace = true) => setParams((current) => {
    const next = new URLSearchParams(current);
    for (const [key, value] of Object.entries(patch)) value ? next.set(key, value) : next.delete(key);
    return next;
  }, { replace });
  useEffect(() => { setSearchInput(search); }, [search]);
  useEffect(() => { setChecked((current) => current.filter((id) => tasks.some((task) => task.task_id === id && task.status !== "cancelled"))); }, [tasks]);
  const bulk = useMutation({
    mutationFn: () => apiFetch("/api/review/tasks/bulk", { method: "POST", ...jsonBody({ task_ids: checked, status: bulkDecision }) }),
    onSuccess: async () => { setChecked([]); await Promise.all([queryClient.invalidateQueries({ queryKey: ["reviews"] }), queryClient.invalidateQueries({ queryKey: ["pending-review-count"] }), queryClient.invalidateQueries({ queryKey: ["content-pipelines"] })]); },
  });
  const allEditableOnPage = tasks.filter((task) => task.status !== "cancelled");

  return <main className="page page-stack review-page" id="main-content">
    <BackButton fallback="/content" />
    <section className="page-hero compact"><p className="eyebrow">内容复核</p><h1>核对内容，再决定是否发布</h1><p className="lede">逐项查看题目、知识关联、题型、错因和来源。状态点击后自动保存，发布前仍可随时调整。</p></section>
    <section className="review-filter-card">
      <form className="review-filter-grid" onSubmit={(event) => { event.preventDefault(); update({ q: searchInput.trim() || null, page: null, task: null }); }}>
        <label className="search-field"><span>搜索</span><input type="search" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="题干、名称或 ID" /></label>
        <label>状态<select value={status} onChange={(event) => update({ status: event.target.value, page: null, task: null })}><option value="pending">待复核</option><option value="confirmed">已确认</option><option value="modified">修改后确认</option><option value="rejected">已退回</option><option value="merged">已合并</option><option value="all">全部状态</option></select></label>
        <label>内容类型<select value={type} onChange={(event) => update({ type: event.target.value || null, format: event.target.value === "question" ? stemFormat || null : null, page: null, task: null })}><option value="">全部内容</option><option value="question">题目</option><option value="knowledge_component">知识点</option><option value="question_type">题型</option><option value="error_cause">错因</option><option value="diagnosis_rule">诊断规则</option></select></label>
        <label>题目类型<select value={stemFormat} disabled={Boolean(type && type !== "question")} onChange={(event) => update({ format: event.target.value || null, page: null, task: null })}><option value="">全部题目</option><option value="single_choice">单选题</option><option value="multiple_choice">多选题</option><option value="fill_blank">填空题</option><option value="true_false">判断题</option><option value="open_solution">解答题</option></select></label>
        <button className="btn ghost" type="submit">应用筛选</button>
      </form>
      {pipeline && <p className="review-scope">正在查看本批资料的复核事项 · <Link to="/review?status=pending&queue=content">查看全部待复核</Link></p>}
    </section>
    {checked.length > 0 && <section className="bulk-action-bar" aria-live="polite"><div><Layers3 aria-hidden="true" /><strong>已选择 {checked.length} 项</strong><button className="text-button" type="button" onClick={() => setChecked([])}>取消选择</button></div><div className="bulk-decision-buttons">{([['confirmed','确认'],['rejected','退回'],['merged','合并']] as const).map(([id, label]) => <button type="button" key={id} aria-pressed={bulkDecision === id} onClick={() => setBulkDecision(id)}>{label}</button>)}</div><AsyncButton className="cinnabar" pending={bulk.isPending} pendingLabel="正在提交…" onClick={() => bulk.mutate()}>提交 {checked.length} 项</AsyncButton>{bulk.isError && <span className="status-note error">部分事项已变更，请刷新后重试。</span>}</section>}
    <div className="review-workspace">
      <aside className="review-queue-panel" aria-label="复核事项列表">
        <div className="review-queue-head"><div><p className="eyebrow">复核列表</p><h2>{total} 项</h2></div>{allEditableOnPage.length > 0 && <label className="select-all"><input type="checkbox" checked={allEditableOnPage.every((task) => checked.includes(task.task_id))} onChange={(event) => setChecked(event.target.checked ? [...new Set([...checked, ...allEditableOnPage.map((task) => task.task_id)])] : checked.filter((id) => !allEditableOnPage.some((task) => task.task_id === id)))} />本页全选</label>}</div>
        {reviews.isPending ? <div className="pending-line"><span className="spinner" />正在读取复核事项…</div> : tasks.length ? <div className="review-queue-list">{tasks.map((task) => <article className={`review-queue-item ${selected?.task_id === task.task_id ? "is-active" : ""}`} key={task.task_id}>
          <input className="review-checkbox" type="checkbox" aria-label={`选择 ${task.target_id}`} checked={checked.includes(task.task_id)} onChange={(event) => setChecked((current) => event.target.checked ? [...current, task.task_id] : current.filter((id) => id !== task.task_id))} />
          <button type="button" onClick={() => update({ task: task.task_id }, false)}><span className="review-queue-label">{taskLabel(task)} · {reviewStatusLabel[task.status] || task.status}</span><MathText as="strong" text={candidateTitle(candidateOf(task), task.target_id)} /><small className="mono">{task.target_id}</small></button><ChevronRight aria-hidden="true" />
        </article>)}</div> : <EmptyState title="没有符合条件的事项">可以调整状态或筛选条件。</EmptyState>}
        {pages > 1 && <nav className="review-pager" aria-label="复核分页"><button className="btn ghost" type="button" disabled={page <= 0} onClick={() => update({ page: String(page), task: null })}>上一页</button><span>{page + 1} / {pages}</span><button className="btn ghost" type="button" disabled={page + 1 >= pages} onClick={() => update({ page: String(page + 2), task: null })}>下一页</button></nav>}
      </aside>
      {selected ? <ReviewDetail task={selected} tasks={tasks} onMove={(task, replace = false) => update({ task: task.task_id }, replace)} /> : <section className="review-detail-panel"><EmptyState title="选择一项开始复核">你会在这里看到内容、来源和题图。</EmptyState></section>}
    </div>
  </main>;
}
