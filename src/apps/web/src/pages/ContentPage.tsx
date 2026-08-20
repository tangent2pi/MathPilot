import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FilePlus2, RefreshCw, RotateCcw, Trash2, UploadCloud, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../app/auth";
import { AsyncButton } from "../components/feedback/AsyncButton";
import { EmptyState } from "../components/feedback/EmptyState";
import { apiFetch, formatDate, jsonBody } from "../lib/api";

type PipelineFile = { document_id?: string; name?: string; duplicate?: boolean };
type Pipeline = {
  run_id: string;
  status: string;
  stage: string;
  chapter_id?: string;
  created_at: string;
  updated_at?: string;
  library_visibility?: string;
  document_ids?: string[];
  ktq_session_ref?: string;
  er_session_ref?: string;
  error_detail?: string | null;
  can_retry?: boolean;
  payload?: { files?: PipelineFile[]; publication?: { package_id?: string; version?: string } };
};
type PipelineList = { runs?: Pipeline[] };
type ReviewProgress = { total_count?: number; pending_count?: number; rejected_count?: number; resolved_count?: number };

const stageName: Record<string, string> = { upload: "资料已保存", ktq: "整理题目与知识点", er: "补充错因与规则", review: "复核与发布" };
const statusName: Record<string, string> = { draft: "待确认", queued: "准备中", running: "处理中", review_ready: "需要复核", published: "已发布", failed: "需要处理" };
const stages = ["upload", "ktq", "er", "review"];
const MAX_MATERIAL_FILES = 100;
const MAX_MATERIAL_BYTES = 20 * 1_048_576;

function fileKey(file: File) { return `${file.name}\0${file.size}\0${file.lastModified}`; }
function fileSize(bytes: number) { return bytes < 1_048_576 ? `${Math.max(1, Math.ceil(bytes / 1024))} KiB` : `${(bytes / 1_048_576).toFixed(1)} MiB`; }
async function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = reject; reader.onload = () => resolve(String(reader.result).split(",")[1] || ""); reader.readAsDataURL(file); });
}
async function uploadPayload(file: File) { return { filename: file.name, mime_type: file.type || "application/octet-stream", kind: "teaching_material", file_base64: await toBase64(file) }; }
async function appendFiles(runId: string, files: File[], progress: (current: number, total: number) => void) {
  for (let index = 0; index < files.length; index++) {
    progress(index + 1, files.length);
    await apiFetch(`/api/content/pipelines/${encodeURIComponent(runId)}/files`, { method: "POST", ...jsonBody({ files: [await uploadPayload(files[index])] }) });
  }
}

function LocalImagePreview({ file }: { file: File }) {
  const [url, setUrl] = useState("");
  useEffect(() => { if (!file.type.startsWith("image/")) return; const next = URL.createObjectURL(file); setUrl(next); return () => URL.revokeObjectURL(next); }, [file]);
  return url ? <img className="file-item-thumb" src={url} alt="" width="64" height="64" /> : null;
}

function PipelineCard({ run }: { run: Pipeline }) {
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const addRef = useRef<HTMLInputElement>(null);
  const progress = useQuery({
    queryKey: ["pipeline-review", run.run_id],
    queryFn: () => apiFetch<ReviewProgress>(`/api/review/tasks?${new URLSearchParams({ queue: "content", source_pipeline_id: run.run_id, limit: "1" })}`),
    enabled: run.status === "review_ready",
    retry: false,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["content-pipelines"] });
  const confirm = useMutation({ mutationFn: () => apiFetch(`/api/content/pipelines/${encodeURIComponent(run.run_id)}/confirm`, { method: "POST" }), onSuccess: async () => { setFeedback("任务已开始，可以打开对话查看进度。"); await refresh(); }, onError: () => setFeedback("无法开始处理，请确认至少保留一份资料。") });
  const retry = useMutation({
    mutationFn: () => apiFetch<Partial<Pipeline> & { run_id: string }>(`/api/content/pipelines/${encodeURIComponent(run.run_id)}/retry`, { method: "POST" }),
    onSuccess: async (next) => {
      setFeedback("任务已重新启动，正在重新处理这批资料。");
      queryClient.setQueryData<PipelineList>(["content-pipelines"], (current) => current ? {
        ...current,
        runs: current.runs?.map((item) => item.run_id === run.run_id ? { ...item, ...next, error_detail: null } : item),
      } : current);
      await refresh();
    },
    onError: () => setFeedback("暂时无法重试，请刷新任务状态后再试。"),
  });
  const dismiss = useMutation({
    mutationFn: () => apiFetch(`/api/content/pipelines/${encodeURIComponent(run.run_id)}/dismiss`, { method: "POST" }),
    onSuccess: () => queryClient.setQueryData<PipelineList>(["content-pipelines"], (current) => current ? {
      ...current,
      runs: current.runs?.filter((item) => item.run_id !== run.run_id),
    } : current),
    onError: () => setFeedback("暂时无法关闭这张任务卡片，请稍后重试。"),
  });
  const remove = useMutation({ mutationFn: (id: string) => apiFetch(`/api/content/pipelines/${encodeURIComponent(run.run_id)}/files/${encodeURIComponent(id)}`, { method: "DELETE" }), onSuccess: refresh });
  const add = useMutation({
    mutationFn: async (files: File[]) => {
      if ((run.document_ids?.length || 0) + files.length > MAX_MATERIAL_FILES) throw new Error("一个资料集最多保存 100 个文件。");
      if (files.some((file) => file.size > MAX_MATERIAL_BYTES)) throw new Error("单个文件不能超过 20 MiB。");
      await appendFiles(run.run_id, files, (current, total) => setFeedback(`正在追加 ${current} / ${total}…`));
    },
    onSuccess: async () => { setFeedback("文件已添加，请继续检查清单。"); await refresh(); },
    onError: (error) => setFeedback(error instanceof Error ? error.message : "追加失败，请重试。"),
  });
  const publish = useMutation({ mutationFn: () => apiFetch("/api/content/publish", { method: "POST", ...jsonBody({ chapter_id: run.chapter_id, version: version.trim(), quality_profile: "generic" }) }), onSuccess: async () => { setFeedback("内容已发布，学生现在可以开始使用。"); await refresh(); }, onError: (error) => setFeedback(error instanceof Error && error.message.includes("version") ? "这个版本号已经使用，请填写新的版本号。" : "暂时无法发布，请检查复核状态后重试。") });
  const files = run.payload?.files ?? [];
  const review = progress.data;
  const pending = Number(review?.pending_count || 0), rejected = Number(review?.rejected_count || 0), total = Number(review?.total_count || 0), resolved = Number(review?.resolved_count || 0);

  return <article className={`run-card ${run.status}`}>
    <div className="run-card-head"><div><strong>{statusName[run.status] || run.status} · {stageName[run.stage] || run.stage}</strong><small>{formatDate(run.created_at)} · {run.library_visibility === "public" ? "公共内容库" : "我的内容库"}</small></div><span className="paper-tag">{run.document_ids?.length || 0} 个文件</span></div>
    <div className="stage-rail">{stages.map((stage) => <span key={stage} className={stages.indexOf(stage) <= stages.indexOf(run.stage) ? "reached" : ""}>{stageName[stage]}</span>)}</div>
    <ul className="run-file-checklist" aria-label="本次资料清单">{files.length ? files.map((file, index) => <li key={file.document_id || `${file.name}-${index}`}><span>{file.name || `文件 ${index + 1}`}</span>{file.duplicate && <small>已有相同文件，将复用原件</small>}{run.status === "draft" && file.document_id && <button className="text-button" type="button" disabled={remove.isPending} onClick={() => remove.mutate(file.document_id as string)}><Trash2 aria-hidden="true" />移除</button>}</li>) : <li><span>资料集暂时为空，请继续添加文件</span></li>}</ul>
    {run.error_detail && <p className="status-note warning">处理遇到问题：{run.error_detail}</p>}
    <div className="action-cluster">
      {run.status === "draft" && <><input ref={addRef} type="file" multiple hidden onChange={(event) => { const picked = [...(event.target.files ?? [])]; if (picked.length) add.mutate(picked); event.target.value = ""; }} /><AsyncButton className="ghost" pending={add.isPending} pendingLabel="正在添加…" onClick={() => addRef.current?.click()}><FilePlus2 aria-hidden="true" />继续添加文件</AsyncButton><AsyncButton className="cinnabar" pending={confirm.isPending} pendingLabel="正在开始…" disabled={!run.document_ids?.length} onClick={() => confirm.mutate()}>确认清单，开始处理</AsyncButton></>}
      {run.status !== "draft" && ["ktq", "er", "review"].includes(run.stage) && run.ktq_session_ref && <Link className="btn ghost" to={`/agent-session?ref=${encodeURIComponent(run.ktq_session_ref)}`}>打开题目整理对话</Link>}
      {run.status !== "draft" && ["er", "review"].includes(run.stage) && run.er_session_ref && <Link className="btn ghost" to={`/agent-session?ref=${encodeURIComponent(run.er_session_ref)}`}>打开诊断研究对话</Link>}
      {run.status === "review_ready" && <Link className="btn cinnabar" to={`/review?status=pending&queue=content&pipeline=${encodeURIComponent(run.run_id)}`}>{pending ? `继续复核（${pending}）` : "查看复核"}</Link>}
      {run.status === "published" && run.payload?.publication?.package_id && <Link className="btn cinnabar" to={`/library?package=${encodeURIComponent(run.payload.publication.package_id)}`}>查看已发布内容</Link>}
      {run.status === "failed" && run.can_retry !== false && <AsyncButton className="cinnabar" pending={retry.isPending} pendingLabel="正在重启…" disabled={dismiss.isPending} onClick={() => retry.mutate()}><RotateCcw aria-hidden="true" />重试处理</AsyncButton>}
      <AsyncButton className="ghost run-card-close" pending={dismiss.isPending} pendingLabel="正在关闭…" disabled={retry.isPending} onClick={() => dismiss.mutate()}><X aria-hidden="true" />关闭卡片</AsyncButton>
    </div>
    {run.status === "review_ready" && <section className="publish-panel"><p className={`status-note ${rejected ? "warning" : pending || !total ? "" : "success"}`}>{progress.isPending ? "正在读取本批复核进度…" : rejected ? `本批有 ${rejected} 项已退回，请修正内容后重新处理。` : pending ? `已完成 ${resolved} / ${total} 项复核，全部确认后即可发布。` : total ? `${total} 项复核已完成，可以发布给学生。` : "等待生成复核事项。"}</p>{Boolean(total && !pending && !rejected) && <form className="publish-form" onSubmit={(event: FormEvent) => { event.preventDefault(); publish.mutate(); }}><label>内容版本<input value={version} onChange={(e) => setVersion(e.target.value)} required pattern="\d+\.\d+\.\d+" inputMode="numeric" /></label><AsyncButton type="submit" className="cinnabar" pending={publish.isPending} pendingLabel="发布检查中…">发布给学生</AsyncButton></form>}</section>}
    {run.status === "published" && run.payload?.publication && <p className="status-note success">版本 {run.payload.publication.version} 已发布，可以打开内容库查看。</p>}
    {feedback && <p className={`status-note ${publish.isSuccess || confirm.isSuccess || retry.isSuccess ? "success" : publish.isError || confirm.isError || add.isError || retry.isError || dismiss.isError ? "error" : ""}`} aria-live="polite">{feedback}</p>}
  </article>;
}

export function ContentPage() {
  const { state: { principal } } = useAuth();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [visibility, setVisibility] = useState("teacher");
  const [feedback, setFeedback] = useState("");
  const [progress, setProgress] = useState(0);
  const canPublic = principal.roles.includes("tenant_admin");
  const runs = useQuery({ queryKey: ["content-pipelines"], queryFn: () => apiFetch<PipelineList>("/api/content/pipelines"), refetchInterval: 5_000 });
  const addFiles = (files: File[]) => {
    const oversized = files.filter((file) => file.size > MAX_MATERIAL_BYTES);
    const seen = new Set(selected.map(fileKey));
    const valid = files.filter((file) => file.size <= MAX_MATERIAL_BYTES && !seen.has(fileKey(file)) && (seen.add(fileKey(file)) || true));
    const remaining = Math.max(0, MAX_MATERIAL_FILES - selected.length);
    setSelected([...selected, ...valid.slice(0, remaining)]);
    if (oversized.length) setFeedback(`${oversized.map((file) => file.name).join("、")} 超过 20 MiB，未添加。`);
    else if (valid.length > remaining) setFeedback(`一个资料集最多保存 ${MAX_MATERIAL_FILES} 个文件，超出的文件未添加。`);
    else setFeedback("");
  };
  const invalid = false;
  const upload = useMutation({
    mutationFn: async () => {
      if (!selected.length) return;
      const files = [...selected];
      setProgress(1);
      const created = await apiFetch<{ run_id: string }>("/api/content/pipelines", { method: "POST", ...jsonBody({ files: [await uploadPayload(files[0])], library_visibility: canPublic ? visibility : "teacher" }) });
      await appendFiles(created.run_id, files.slice(1), (current) => setProgress(current + 1));
      return created.run_id;
    },
    onSuccess: async () => { setFeedback("文件已保存。请检查清单，然后确认开始处理。"); setSelected([]); setProgress(0); await queryClient.invalidateQueries({ queryKey: ["content-pipelines"] }); },
    onError: (error) => { setFeedback(`提交失败：${error instanceof Error ? error.message : "请稍后重试"}`); setProgress(0); },
  });
  const onDrop = (event: DragEvent) => { event.preventDefault(); setDragging(false); addFiles([...(event.dataTransfer.files ?? [])]); };
  const pipelineRuns = useMemo(() => runs.data?.runs ?? [], [runs.data?.runs]);

  return (
    <main className="page content-studio" id="main-content">
      <section className="page-hero compact studio-hero"><div><p className="eyebrow">内容</p><h1>整理一批新的教学资料</h1><p className="lede">添加讲义、题目或图片，检查清单后再开始处理。任务开始后，你可以随时回来查看进度和继续对话。</p></div><Link className="btn ghost" to="/library">查看已发布内容</Link></section>
      <div className="studio-grid">
        <section className="section-card upload-sheet"><div className="section-heading"><div><p className="eyebrow">新资料</p><h2>添加文件</h2></div><span id="selectionSummary" className="paper-tag">{selected.length} 个文件</span></div>
          <input id="materials" ref={inputRef} type="file" multiple hidden onChange={(event) => { addFiles([...(event.target.files ?? [])]); event.target.value = ""; }} />
          <button id="dropzone" className={`dropzone ${dragging ? "is-dragging" : ""}`} type="button" onClick={() => inputRef.current?.click()} onDragEnter={(e) => { e.preventDefault(); setDragging(true); }} onDragOver={(e) => e.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={onDrop}><UploadCloud aria-hidden="true" /><span><strong>拖到这里，或点击选择文件</strong>可以分多次添加 PDF、图片、Office 文档、文本和常见数据文件。</span></button>
          <div id="fileList" className="file-list">{selected.length ? selected.map((file) => <article className="file-item" key={fileKey(file)}><LocalImagePreview file={file} /><div><strong>{file.name}</strong><small>{file.type || "待识别类型"} · {fileSize(file.size)}</small></div><button className="text-button" type="button" onClick={() => setSelected((current) => current.filter((item) => fileKey(item) !== fileKey(file)))}>移除</button></article>) : <EmptyState>添加本次要一起整理的资料</EmptyState>}</div>
          {canPublic && <label className="field-stack"><span>保存到</span><select value={visibility} onChange={(e) => setVisibility(e.target.value)}><option value="public">公共内容库</option><option value="teacher">我的内容库</option></select><small>公共内容可供所有学生使用；我的内容仅供已绑定的学生使用。</small></label>}
          <div className="action-cluster"><AsyncButton className="cinnabar" pending={upload.isPending} pendingLabel={`正在上传 ${progress || 1} / ${selected.length || 1}…`} disabled={!selected.length || invalid} onClick={() => upload.mutate()}>上传并检查</AsyncButton><button className="btn ghost" type="button" disabled={!selected.length || upload.isPending} onClick={() => setSelected([])}>清空选择</button></div>
          <p className={upload.isError || feedback.includes("未添加") ? "status-note error" : "muted"} aria-live="polite">{feedback || "单个文件最大 20 MiB，每批最多 100 个文件。"}</p>
        </section>
        <aside className="section-card pipeline-guide"><p className="eyebrow">处理步骤</p><h2>你始终知道下一步</h2><ol className="atelier-steps"><li><strong>检查资料</strong><span>上传后先核对文件清单，再确认开始。</span></li><li><strong>整理内容</strong><span>系统提取题目、知识点、错因和诊断规则。</span></li><li><strong>复核发布</strong><span>检查来源、题图和答案后发布给学生使用。</span></li></ol></aside>
      </div>
      <section className="section-card run-ledger"><div className="section-heading"><div><p className="eyebrow">内容任务</p><h2>最近处理</h2><p className="muted">待确认、处理中和需要复核的任务都会保留在这里。</p></div><button className="btn ghost" type="button" onClick={() => runs.refetch()}><RefreshCw aria-hidden="true" />刷新</button></div><div className="run-list">{runs.isPending ? <div className="pending-line"><span className="spinner" />正在读取任务…</div> : pipelineRuns.length ? pipelineRuns.map((run) => <PipelineCard run={run} key={run.run_id} />) : <EmptyState>还没有内容任务。添加一批资料开始整理。</EmptyState>}</div></section>
    </main>
  );
}
