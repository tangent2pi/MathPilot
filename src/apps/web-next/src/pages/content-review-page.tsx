"use client";

import { ArrowLeftIcon, CheckIcon, ClipboardCheckIcon, LoaderCircleIcon, MessageSquareTextIcon, RotateCcwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { MathText } from "@/components/assistant-ui/elements/math-text";
import { useAuth } from "@/auth";
import { cn } from "@/lib/utils";
import { contentApi, type CandidateDetail, type CandidateItem } from "@/lib/content-api";

const KIND_NAME: Record<CandidateItem["entity_kind"], string> = {
  knowledge: "知识点",
  question_type: "题型",
  question: "题目",
  error_cause: "错因",
  diagnosis_rule: "诊断规则",
};
const KIND_ORDER = Object.keys(KIND_NAME) as CandidateItem["entity_kind"][];

const FIELD_OPTIONS: Record<CandidateItem["entity_kind"], Array<{ value: string; label: string }>> = {
  knowledge: [
    { value: "name", label: "名称" }, { value: "description", label: "说明" },
    { value: "grade_band", label: "年级范围" }, { value: "difficulty", label: "难度" },
    { value: "mastery_standard", label: "掌握标准" }, { value: "remediation_advice", label: "补救建议" },
  ],
  question_type: [
    { value: "name", label: "名称" }, { value: "description", label: "说明" },
    { value: "identifying_features", label: "识别特征" }, { value: "standard_method", label: "标准方法" },
  ],
  question: [
    { value: "chapter_id", label: "一级模块" }, { value: "module_2", label: "二级模块" },
    { value: "module_3", label: "三级模块" }, { value: "stem_format", label: "题干格式" },
    { value: "stem_markdown", label: "题干" }, { value: "difficulty", label: "难度" },
    { value: "question_type_revision_id", label: "题型引用" }, { value: "analysis_markdown", label: "解析" },
  ],
  error_cause: [
    { value: "category", label: "类别" }, { value: "name", label: "名称" },
    { value: "description", label: "说明" }, { value: "manifestation", label: "表现" },
    { value: "judgment_basis", label: "判断依据" }, { value: "remediation", label: "补救方法" },
  ],
  diagnosis_rule: [
    { value: "rule_version", label: "规则版本" }, { value: "trigger_text", label: "触发条件" },
    { value: "probe_text", label: "追问文本" },
  ],
};

function itemText(item: CandidateItem): { title: string; description: string } {
  if (item.entity_kind === "knowledge") return { title: item.knowledge_name || item.entity_id, description: item.knowledge_description || "" };
  if (item.entity_kind === "question_type") return { title: item.question_type_name || item.entity_id, description: "" };
  if (item.entity_kind === "question") {
    const path = [item.chapter_id, item.question_module_2, item.question_module_3].filter(Boolean).join(" / ");
    return { title: item.stem_markdown || item.entity_id, description: path ? `${item.analysis_markdown || ""}\n模块归属：${path}`.trim() : item.analysis_markdown || "" };
  }
  if (item.entity_kind === "error_cause") return { title: item.error_name || item.entity_id, description: item.error_description || "" };
  return { title: item.trigger_text || item.entity_id, description: item.probe_text || "" };
}

export function ContentReviewPage({ candidateSetId }: { candidateSetId: string }) {
  const { principal, loading, requireAuth } = useAuth();
  const [detail, setDetail] = useState<CandidateDetail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState("");
  const [revisionId, setRevisionId] = useState("");
  const [fieldName, setFieldName] = useState("");
  const [packageId, setPackageId] = useState<string>();
  const [approvedGo, setApprovedGo] = useState(false);
  const [requestedGo, setRequestedGo] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setError("");
    try {
      const value = await contentApi<CandidateDetail>(`/candidates/${encodeURIComponent(candidateSetId)}`, { signal });
      setDetail(value);
      setRevisionId((current) => current || value.items[0]?.revision_id || "");
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : "无法读取候选集");
    }
  }, [candidateSetId]);

  useEffect(() => {
    if (!principal?.roles.includes("teacher")) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, principal]);

  useEffect(() => {
    // 只有在教师本人刚在本页点击“批准”后才跳转 ER 会话；直接打开已批准批次时
    // 停留在详情页供查看，避免被自动带回对话。
    const command = detail?.er_start_command;
    if (!command || !approvedGo) return;
    if (command.status === "dispatched") {
      window.location.assign(`/c/${encodeURIComponent(command.target_thread_id)}`);
      return;
    }
    const timer = window.setInterval(() => void load(), 2_000);
    return () => window.clearInterval(timer);
  }, [approvedGo, detail?.er_start_command, load]);

  useEffect(() => {
    // 同 approve：只有教师刚点击“返回修改”才跳回原会话。
    const decision = detail?.decision;
    const threadId = detail?.candidate.thread_id;
    if (decision?.decision !== "changes_requested" || !threadId || !requestedGo) return;
    if (decision.feedback_dispatched_at) {
      window.location.assign(`/c/${encodeURIComponent(threadId)}`);
      return;
    }
    const timer = window.setInterval(() => void load(), 2_000);
    return () => window.clearInterval(timer);
  }, [detail?.candidate.thread_id, detail?.decision, load, requestedGo]);

  const activeAnnotations = useMemo(
    () => detail?.annotations.filter((annotation) => annotation.state !== "withdrawn") ?? [],
    [detail],
  );
  const selectedItem = detail?.items.find((item) => item.revision_id === revisionId);

  const saveAnnotation = async (state: "draft" | "submitted") => {
    if (!revisionId || !comment.trim()) return;
    setBusy(true); setError("");
    try {
      await contentApi(`/candidates/${encodeURIComponent(candidateSetId)}/annotations`, {
        method: "POST",
        body: JSON.stringify({ revision_id: revisionId, field_name: fieldName || null, comment_text: comment.trim(), state }),
      });
      setComment("");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "批注提交失败"); }
    finally { setBusy(false); }
  };

  const submitAnnotation = async (event: FormEvent) => {
    event.preventDefault();
    await saveAnnotation("submitted");
  };

  const withdraw = async (annotationId: string) => {
    setBusy(true); setError("");
    try {
      await contentApi(`/candidates/${encodeURIComponent(candidateSetId)}/annotations/${encodeURIComponent(annotationId)}`, { method: "DELETE" });
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "批注撤回失败"); }
    finally { setBusy(false); }
  };

  const decide = async (decision: "approved" | "changes_requested") => {
    setBusy(true); setError("");
    try {
      const result = await contentApi<{ package_id?: string; target_thread_id?: string }>(`/candidates/${encodeURIComponent(candidateSetId)}/decide`, {
        method: "POST", body: JSON.stringify({ decision }),
      });
      if (result.package_id) setPackageId(result.package_id);
      if (decision === "approved") setApprovedGo(true);
      else setRequestedGo(true);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "复核决定提交失败"); }
    finally { setBusy(false); }
  };

  if (loading) return <PageState text="正在读取账户…" busy />;
  if (!principal) return <PageState text="登录教师账户后才能复核内容。" action={<Button className="min-h-11" onClick={() => requireAuth(undefined, "login")}>登录</Button>} />;
  if (!principal.roles.includes("teacher")) return <PageState text="此页面仅供教师使用。" />;
  if (!detail && !error) return <PageState text="正在加载候选集…" busy />;
  if (!detail) return <PageState text={error || "候选集不存在"} />;

  const pending = detail.candidate.status === "pending_review";
  return (
    <main className="min-h-dvh bg-muted/25">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
          <Button aria-label="返回原会话" className="min-h-11" variant="ghost" onClick={() => window.location.assign(`/c/${encodeURIComponent(detail.candidate.thread_id)}`)}>
            <ArrowLeftIcon aria-hidden="true" />返回会话
          </Button>
          <div className="min-w-0">
            <h1 className="truncate font-semibold">{detail.candidate.phase.toUpperCase()} 内容复核</h1>
            <p className="truncate text-xs text-muted-foreground">第 {detail.candidate.sequence_no} 版 · {detail.candidate.item_count} 项</p>
          </div>
          <StatusBadge className="ms-auto" status={detail.candidate.status} />
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-5 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section aria-labelledby="candidate-items-heading" className="space-y-3">
          <div>
            <h2 id="candidate-items-heading" className="font-semibold">候选内容</h2>
            <p className="mt-1 text-sm text-muted-foreground">逐项检查结构化字段；需要修改时先提交批注，再返回修改。</p>
          </div>
          {KIND_ORDER.map((kind) => {
            const items = detail.items.filter((item) => item.entity_kind === kind);
            if (!items.length) return null;
            return (
              <section className="space-y-3" key={kind}>
                <h3 className="pt-2 text-sm font-semibold">{KIND_NAME[kind]}（{items.length}）</h3>
                {items.map((item) => {
                  const text = itemText(item);
                  const sources = detail.provenance
                    .filter((entry) => entry.revision_id === item.revision_id && entry.source_locator)
                    .map((entry) => {
                      const locator = sourceLabel(entry.source_locator!);
                      return entry.source_object_id && entry.source_version_id
                        ? `${locator} · ${entry.source_object_id}@${entry.source_version_id}`
                        : locator;
                    });
                  return (
                    <article key={item.revision_id} className={cn("rounded-2xl border bg-card p-4 shadow-sm transition-colors", revisionId === item.revision_id && "border-primary/50 ring-2 ring-primary/10")}>
                      <button className="w-full cursor-pointer rounded-xl text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" type="button" onClick={() => { setRevisionId(item.revision_id); setFieldName(""); }}>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <code className="[overflow-wrap:anywhere]">{item.entity_id}</code>
                          <span>修订 {item.revision_no}</span>
                        </div>
                        <h4 className="mt-3 text-sm font-medium leading-6"><MathText text={text.title} /></h4>
                        {text.description && <div className="line-clamp-4 mt-2 text-sm leading-6 text-muted-foreground"><MathText text={text.description} /></div>}
                        {[...new Set(sources)].map((source) => <p className="mt-2 text-xs text-muted-foreground" key={source}>来源：{source}</p>)}
                      </button>
                    </article>
                  );
                })}
              </section>
            );
          })}
        </section>

        <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <section className="rounded-2xl border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2 font-medium"><MessageSquareTextIcon className="size-4" aria-hidden="true" />复核批注</div>
            <form className="mt-4 space-y-3" onSubmit={submitAnnotation}>
              <label className="block text-xs font-medium" htmlFor="review-target">批注对象</label>
              <select id="review-target" className="min-h-11 w-full rounded-md border bg-background px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm" value={revisionId} onChange={(event) => { setRevisionId(event.target.value); setFieldName(""); }}>
                {detail.items.map((item) => <option key={item.revision_id} value={item.revision_id}>{KIND_NAME[item.entity_kind]} · {item.entity_id}</option>)}
              </select>
              <label className="block text-xs font-medium" htmlFor="review-field">批注范围</label>
              <select id="review-field" className="min-h-11 w-full rounded-md border bg-background px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm" value={fieldName} onChange={(event) => setFieldName(event.target.value)}>
                <option value="">整条内容</option>
                {(selectedItem ? FIELD_OPTIONS[selectedItem.entity_kind] : []).map((field) => <option key={field.value} value={field.value}>{field.label}</option>)}
              </select>
              <label className="block text-xs font-medium" htmlFor="review-comment">修改意见</label>
              <textarea id="review-comment" className="min-h-28 w-full resize-y rounded-md border bg-background px-3 py-2 text-base leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm" maxLength={10000} required value={comment} onChange={(event) => setComment(event.target.value)} />
              <div className="grid grid-cols-2 gap-2">
                <Button className="min-h-11" disabled={busy || !pending || !revisionId || !comment.trim()} type="button" variant="outline" onClick={() => void saveAnnotation("draft")}>保存草稿</Button>
                <Button className="min-h-11" disabled={busy || !pending || !revisionId || !comment.trim()} type="submit">{busy ? "处理中…" : "提交批注"}</Button>
              </div>
            </form>
            {activeAnnotations.length > 0 && (
              <div className="mt-4 space-y-2 border-t pt-4">
                {activeAnnotations.map((annotation) => (
                  <div className="rounded-xl bg-muted/60 p-3 text-sm" key={annotation.annotation_id}>
                    <p className="mb-1 text-xs text-muted-foreground">{annotationTarget(detail.items, annotation.revision_id, annotation.field_name)}</p>
                    <p className="whitespace-pre-wrap leading-5">{annotation.comment_text}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{annotation.state === "draft" ? "草稿" : "已提交"}</p>
                    <Button className="mt-2 min-h-11 px-2" disabled={busy || !pending} size="sm" variant="ghost" onClick={() => void withdraw(annotation.annotation_id)}>撤回</Button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-2xl border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2 font-medium"><ClipboardCheckIcon className="size-4" aria-hidden="true" />复核决定</div>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">批准会冻结当前修订；KTQ 随后创建 ER 会话，ER 随后生成待发布内容包。</p>
            <div className="mt-4 grid gap-2">
              <Button className="min-h-11" disabled={busy || !pending || activeAnnotations.length > 0} onClick={() => void decide("approved")}><CheckIcon aria-hidden="true" />{busy ? "处理中…" : "批准"}</Button>
              <Button className="min-h-11" disabled={busy || !pending || activeAnnotations.length === 0} variant="outline" onClick={() => void decide("changes_requested")}><RotateCcwIcon aria-hidden="true" />{busy ? "处理中…" : "返回修改"}</Button>
            </div>
            {activeAnnotations.length > 0 && <p className="mt-2 text-xs text-muted-foreground">批准前需撤回当前有效批注，或选择“返回修改”。</p>}
            {detail.decision?.decision === "changes_requested" && !detail.decision.feedback_dispatched_at && <p className="mt-2 text-xs text-muted-foreground">正在把冻结批注送回原会话，完成后将自动返回。</p>}
            {detail.er_start_command?.status === "pending" && <p className="mt-2 text-xs text-muted-foreground">正在创建 ER 普通会话，完成后将自动进入。</p>}
            {packageId && <Button className="mt-3 min-h-11 w-full" variant="secondary" onClick={() => window.location.assign(`/content/packages/${encodeURIComponent(packageId)}`)}>打开内容包</Button>}
          </section>
          {error && <p className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">{error}</p>}
        </aside>
      </div>
    </main>
  );
}

function annotationTarget(items: CandidateItem[], revisionId: string, fieldName?: string | null): string {
  const item = items.find((candidate) => candidate.revision_id === revisionId);
  if (!item) return fieldName || "整条内容";
  const field = FIELD_OPTIONS[item.entity_kind].find((candidate) => candidate.value === fieldName);
  return `${KIND_NAME[item.entity_kind]} · ${item.entity_id} · ${field?.label ?? (fieldName || "整条内容")}`;
}

function sourceLabel(locator: string): string {
  try {
    const value = JSON.parse(locator) as { path?: unknown; page?: unknown };
    const sourcePath = typeof value.path === "string" ? value.path : "未知文件";
    return typeof value.page === "number" && Number.isSafeInteger(value.page) ? `${sourcePath} · 第 ${value.page} 页` : sourcePath;
  } catch {
    return locator;
  }
}

function StatusBadge({ status, className }: { status: CandidateDetail["candidate"]["status"]; className?: string }) {
  const label = { pending_review: "待复核", changes_requested: "已返回修改", approved: "已批准", superseded: "已被新版本替代" }[status];
  return <span className={cn("rounded-full border bg-card px-2.5 py-1 text-xs font-medium", className)}>{label}</span>;
}

function PageState({ text, busy, action }: { text: string; busy?: boolean; action?: ReactNode }) {
  return <main className="grid min-h-dvh place-items-center bg-muted/25 p-6"><div className="flex max-w-md flex-col items-center gap-4 text-center text-muted-foreground">{busy && <LoaderCircleIcon className="size-6 animate-spin motion-reduce:animate-none" aria-hidden="true" />}<p>{text}</p>{action}<Button className="min-h-11" variant="ghost" onClick={() => window.location.assign("/")}>返回首页</Button></div></main>;
}
