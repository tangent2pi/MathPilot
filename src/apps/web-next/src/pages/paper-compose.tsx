"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRightIcon,
  BookOpenIcon,
  DownloadIcon,
  Loader2Icon,
  PlusIcon,
  Undo2Icon,
  Wand2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/auth";
import { MathText } from "@/components/assistant-ui/elements/math-text";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";

export type PaperConfig = {
  counts: { single_choice: number; multiple_choice: number; fill_blank: number; true_false: number; open_solution: number };
  difficulty_ratio: { easy: number; medium: number; hard: number };
};

export type PaperItem = {
  item_order: number;
  entity_id: string;
  revision_id: string;
  difficulty: number | null;
  stem_format: string;
  chapter_id: string | null;
  question_type_name: string | null;
  stem_markdown: string | null;
  options: Array<{ option_key: string; option_text: string }>;
};

export type PaperDetail = {
  paper_id: string;
  title: string;
  version_no: number;
  status: "draft" | "finalized";
  source: "manual" | "upload" | "auto";
  config: PaperConfig;
  pdf_sha256: string | null;
  answer_pdf_sha256: string | null;
  created_at: string;
  finalized_at: string | null;
  items: PaperItem[];
};

export type AnswerReviewItem = {
  item_order: number;
  stem_format: string;
  stem_markdown: string | null;
  options: Array<{ option_key: string; option_text: string }>;
  answer_text: string;
  analysis_text: string;
  need_review: boolean;
  review_note: string | null;
  source: string;
};

export type AnswerReviewData = {
  paper_id: string;
  title: string;
  status: "draft" | "finalized";
  answer_pdf_sha256: string | null;
  items: AnswerReviewItem[];
};

export type PickableQuestion = {
  entity_id: string;
  revision_id: string;
  revision_no: number;
  lifecycle_status: string;
  batch_id: string | null;
  batch_display_name: string | null;
  batch_phase: string | null;
  chapter_id: string | null;
  stem_format: string | null;
  difficulty: number | null;
  stem_preview: string | null;
  question_type_name: string | null;
};

export async function papersApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/content${path}`, {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string; detail?: string };
  if (!response.ok) throw new Error(body.detail || body.error || `请求失败（${response.status}）`);
  return body;
}

export const prepareAnswerApi = (paperId: string) =>
  papersApi<AnswerReviewData>(`/papers/${encodeURIComponent(paperId)}/answer/prepare`, { method: "POST" });

export const getAnswerApi = (paperId: string) =>
  papersApi<AnswerReviewData>(`/papers/${encodeURIComponent(paperId)}/answer`);

export const saveAnswerItemsApi = (paperId: string, items: AnswerReviewItem[]) =>
  papersApi<{ saved: boolean; count: number }>(`/papers/${encodeURIComponent(paperId)}/answer/items`, {
    method: "PUT",
    body: JSON.stringify({ items: items.map((item) => ({
      item_order: item.item_order,
      answer_text: item.answer_text,
      analysis_text: item.analysis_text,
      need_review: item.need_review,
      review_note: item.review_note,
    })) }),
  });

export const renderAnswerApi = (paperId: string) =>
  papersApi<{ download_url?: string }>(`/papers/${encodeURIComponent(paperId)}/answer/render`, { method: "POST" });

export const TYPE_META: Record<string, { label: string; bucket: keyof PaperConfig["counts"] }> = {
  single_choice: { label: "选择题", bucket: "single_choice" },
  multiple_choice: { label: "多选题", bucket: "multiple_choice" },
  fill_blank: { label: "填空题", bucket: "fill_blank" },
  true_false: { label: "判断题", bucket: "true_false" },
  open_solution: { label: "解答题", bucket: "open_solution" },
};

const STEM_LABEL: Record<string, string> = {
  single_choice: "选择",
  multiple_choice: "多选",
  fill_blank: "填空",
  true_false: "判断",
  open_solution: "解答",
};

export const STATUS_LABEL: Record<string, string> = { draft: "草稿", finalized: "已定稿" };

export function dateLabel(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "时间待同步";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(parsed));
}

function difficultyLabel(value: number | null): string {
  if (value === null) return "未标注";
  if (value < 0.33) return "偏易";
  if (value <= 0.67) return "中等";
  return "偏难";
}

const TYPE_OPTIONS: ReadonlyArray<{ key: string; label: string; default: boolean }> = [
  { key: "single_choice", label: "选择题", default: true },
  { key: "fill_blank", label: "填空题", default: true },
  { key: "open_solution", label: "解答题", default: true },
  { key: "multiple_choice", label: "多选题", default: false },
  { key: "true_false", label: "判断题", default: false },
];

const DEFAULT_TYPE_KEYS = ["single_choice", "fill_blank", "open_solution"];

/** 题型题量编辑器：默认三种题型，可经「补充题型」加入多选/判断，也可移除。 */
export function QuestionTypeCountsEditor({ counts, onChange }: {
  counts: Record<string, number>;
  onChange: (counts: Record<string, number>) => void;
}) {
  const [extra, setExtra] = useState<string[]>([]);
  const active = useMemo(() => {
    const set = new Set<string>(DEFAULT_TYPE_KEYS);
    for (const t of TYPE_OPTIONS) if ((counts[t.key] ?? 0) > 0) set.add(t.key);
    for (const key of extra) set.add(key);
    return TYPE_OPTIONS.filter((t) => set.has(t.key)).map((t) => t.key);
  }, [counts, extra]);
  const available = TYPE_OPTIONS.filter((t) => !active.includes(t.key));

  const setCount = (key: string, value: number) => onChange({ ...counts, [key]: value });
  const removeType = (key: string) => {
    onChange({ ...counts, [key]: 0 });
    setExtra((prev) => prev.filter((k) => k !== key));
  };
  const addType = (key: string) => setExtra((prev) => (prev.includes(key) ? prev : [...prev, key]));

  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-3 gap-3">
        {active.map((key) => {
          const meta = TYPE_OPTIONS.find((t) => t.key === key)!;
          return (
            <div key={key} className="grid gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground text-xs">{meta.label}</span>
                {!meta.default && (
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={`移除${meta.label}`}
                    onClick={() => removeType(key)}
                  >
                    <XIcon className="size-3.5" />
                  </button>
                )}
              </div>
              <Input
                type="number" min={0} max={200} value={counts[key] ?? 0}
                onChange={(event) => setCount(key, Math.max(0, parseInt(event.target.value || "0", 10)))}
              />
            </div>
          );
        })}
      </div>
      {available.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button type="button" size="sm" variant="outline" className="justify-self-start"><PlusIcon className="size-3.5" />补充题型</Button>}
          />
          <DropdownMenuContent align="start">
            {available.map((t) => (
              <DropdownMenuItem key={t.key} onClick={() => addType(t.key)}>{t.label}</DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

export function ManualPaperDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (paperId: string) => void }) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<"config" | "pick">("config");
  const [title, setTitle] = useState("");
  const [counts, setCounts] = useState<Record<string, number>>({ single_choice: 0, fill_blank: 0, open_solution: 0 });
  const [ratio, setRatio] = useState({ easy: 3, medium: 5, hard: 2 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [keyword, setKeyword] = useState("");

  const questions = useQuery({
    queryKey: ["teacher", "library", "questions"],
    queryFn: () => papersApi<{ questions: PickableQuestion[] }>("/teacher/library/questions"),
    enabled: open && step === "pick",
  });

  const countByType = useMemo(() => {
    const map: Record<string, number> = {};
    for (const row of questions.data?.questions ?? []) {
      if (selected.has(row.revision_id) && row.stem_format && TYPE_META[row.stem_format]) {
        map[row.stem_format] = (map[row.stem_format] ?? 0) + 1;
      }
    }
    return map;
  }, [selected, questions.data]);

  const totalCount = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const selectedTotal = selected.size;
  const canCreate = step === "pick" && selectedTotal > 0 && selectedTotal === totalCount;

  const reset = () => {
    setStep("config");
    setTitle("");
    setCounts({ single_choice: 0, fill_blank: 0, open_solution: 0 });
    setRatio({ easy: 3, medium: 5, hard: 2 });
    setSelected(new Set());
    setKeyword("");
  };

  const createPaper = useMutation({
    mutationFn: async () => {
      const all = questions.data?.questions ?? [];
      const revisions = all
        .filter((row) => selected.has(row.revision_id))
        .map((row) => ({ entity_id: row.entity_id, revision_id: row.revision_id }));
      return papersApi<{ paper_id: string }>("/papers", {
        method: "POST",
        body: JSON.stringify({ title, config: { counts, difficulty_ratio: ratio }, revisions }),
      });
    },
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ["teacher", "library", "papers"] });
      reset();
      onOpenChange(false);
      onCreated(created.paper_id);
    },
  });

  const byType = useMemo(() => {
    const groups: Record<string, PickableQuestion[]> = {};
    for (const row of questions.data?.questions ?? []) {
      if (row.stem_format && TYPE_META[row.stem_format]) {
        (groups[row.stem_format] ??= []).push(row);
      }
    }
    const q = keyword.trim().toLowerCase();
    return Object.entries(groups)
      .filter(([, rows]) => rows.length > 0)
      .map(([bucket, rows]) => ({
        bucket,
        label: TYPE_META[bucket]?.label ?? bucket,
        need: counts[bucket] ?? 0,
        picked: countByType[bucket] ?? 0,
        rows: q ? rows.filter((row) => [row.entity_id, row.question_type_name, row.stem_preview, row.chapter_id].filter(Boolean).join(" ").toLowerCase().includes(q)) : rows,
      }));
  }, [questions.data, keyword, counts, countByType]);

  const toggle = (row: PickableQuestion) => {
    if (!row.stem_format || !TYPE_META[row.stem_format]) return;
    const newSet = new Set(selected);
    if (newSet.has(row.revision_id)) {
      newSet.delete(row.revision_id);
    } else {
      if ((countByType[row.stem_format] ?? 0) >= (counts[row.stem_format] ?? 0)) return;
      newSet.add(row.revision_id);
    }
    setSelected(newSet);
  };

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value && !createPaper.isPending) { reset(); onOpenChange(false); } }}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>自选题组卷{step === "pick" ? " · 选择题目" : ""}</DialogTitle>
          <DialogDescription>
            {step === "config" ? "先设置题型数量与难度安排，再挑选题目。" : `从私人题库挑选题目，数量与配置一致后可创建。已选 ${selected.size}/${totalCount} 题。`}
          </DialogDescription>
        </DialogHeader>

        {step === "config" ? (
          <div className="grid gap-4">
            <div className="grid gap-3">
              <span className="text-sm font-medium">试卷名称</span>
              <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：解三角形单元测验" maxLength={200} />
            </div>
            <div className="grid gap-3">
              <span className="text-sm font-medium">题型与题量</span>
              <QuestionTypeCountsEditor counts={counts} onChange={setCounts} />
            </div>
            <div className="grid gap-3">
              <span className="text-sm font-medium">难度安排（易 : 中 : 难）</span>
              <div className="grid grid-cols-3 gap-3">
                {(["easy", "medium", "hard"] as const).map((key, index) => (
                  <div key={key} className="grid gap-1.5">
                    <span className="text-muted-foreground text-xs">{["偏易", "中等", "偏难"][index]}</span>
                    <Input type="number" min={0} max={100} value={ratio[key]} onChange={(event) => setRatio({ ...ratio, [key]: Math.max(0, parseInt(event.target.value || "0", 10)) })} />
                  </div>
                ))}
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" disabled={createPaper.isPending} onClick={() => onOpenChange(false)}>取消</Button>
              <Button disabled={totalCount < 1} onClick={() => setStep("pick")}>
                下一步 <ArrowRightIcon className="size-4" />
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="grid gap-4">
            <Input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索题干/题型/章节…" />
            <div className="max-h-[50vh] space-y-4 overflow-y-auto pr-1">
              {questions.isPending && <p className="text-muted-foreground text-sm">正在加载题目…</p>}
              {questions.error && <p className="text-destructive text-sm">{questions.error.message}</p>}
              {byType.map((group) => (
                <section key={group.bucket}>
                  <h4 className="text-muted-foreground mb-1 text-xs font-semibold">
                    {group.label} · 需 {group.need} 题 · 已选 {group.picked} 题
                  </h4>
                  {group.rows.length === 0 && <p className="text-muted-foreground text-sm">无可用题目</p>}
                  <div className="divide-y">
                    {group.rows.map((row) => (
                      <label key={row.revision_id} className="flex cursor-pointer items-start gap-2 py-2">
                        <input
                          type="checkbox"
                          className="mt-1 size-4"
                          checked={selected.has(row.revision_id)}
                          disabled={(countByType[row.stem_format!] ?? 0) >= (counts[row.stem_format!] ?? 0) && !selected.has(row.revision_id)}
                          onChange={() => toggle(row)}
                        />
                        <span className="text-muted-foreground w-10 shrink-0 text-xs">难度{difficultyLabel(row.difficulty)}</span>
                        <span className="min-w-0 flex-1 text-sm">
                          <MathText text={row.stem_preview || "（题目内容）"} />
                          {row.question_type_name ? <span className="text-muted-foreground ml-2 text-xs">{row.question_type_name}</span> : null}
                        </span>
                      </label>
                    ))}
                  </div>
                </section>
              ))}
            </div>
            <DialogFooter>
              <Button variant="outline" disabled={createPaper.isPending} onClick={() => setStep("config")}>上一步</Button>
              <Button disabled={!canCreate} onClick={() => createPaper.mutate()}>
                {createPaper.isPending && <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" />}创建试卷
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function AutoPaperDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (paperId: string) => void }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [counts, setCounts] = useState<Record<string, number>>({ single_choice: 5, fill_blank: 3, open_solution: 2 });
  const [ratio, setRatio] = useState({ easy: 3, medium: 5, hard: 2 });

  const totalCount = Object.values(counts).reduce((sum, n) => sum + n, 0);

  const createPaper = useMutation({
    mutationFn: () => papersApi<{ paper_id: string }>("/papers/auto", {
      method: "POST",
      body: JSON.stringify({ title, config: { counts, difficulty_ratio: ratio } }),
    }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ["teacher", "library", "papers"] });
      reset();
      onOpenChange(false);
      onCreated(created.paper_id);
    },
  });

  const reset = () => {
    setTitle("");
    setCounts({ single_choice: 5, fill_blank: 3, open_solution: 2 });
    setRatio({ easy: 3, medium: 5, hard: 2 });
  };

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value && !createPaper.isPending) { reset(); onOpenChange(false); } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>智能组卷</DialogTitle>
          <DialogDescription>从你解析出的题目池中按题型题量与难度比例自动抽取。若池中某题型题目不足会提示调整。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-3">
            <span className="text-sm font-medium">试卷名称</span>
            <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：解三角形单元测验" maxLength={200} />
          </div>
          <div className="grid gap-3">
            <span className="text-sm font-medium">题型与题量</span>
            <QuestionTypeCountsEditor counts={counts} onChange={setCounts} />
          </div>
          <div className="grid gap-3">
            <span className="text-sm font-medium">难度安排（易 : 中 : 难）</span>
            <div className="grid grid-cols-3 gap-3">
              {(["easy", "medium", "hard"] as const).map((key, index) => (
                <div key={key} className="grid gap-1.5">
                  <span className="text-muted-foreground text-xs">{["偏易", "中等", "偏难"][index]}</span>
                  <Input type="number" min={0} max={100} value={ratio[key]}
                    onChange={(event) => setRatio({ ...ratio, [key]: Math.max(0, parseInt(event.target.value || "0", 10)) })} />
                </div>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={createPaper.isPending} onClick={() => onOpenChange(false)}>取消</Button>
            <Button disabled={totalCount < 1} onClick={() => createPaper.mutate()}>
              {createPaper.isPending && <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" />}开始组卷（{totalCount} 题）
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function PaperDetailDialog({ paper, onClose, onChanged, onOpenAnswer }: { paper: PaperDetail | null; onClose: () => void; onChanged: (fresh: PaperDetail) => void; onOpenAnswer?: (paper: PaperDetail) => void }) {
  const queryClient = useQueryClient();
  const swapItem = useMutation({
    mutationFn: async ({ order, action }: { order: number; action: "harder" | "easier" | "same" }) => {
      await papersApi(`/papers/${encodeURIComponent(paper!.paper_id)}/items/${order}/swap`, {
        method: "POST", body: JSON.stringify({ action }),
      });
    },
  });
  const adjustDifficulty = useMutation({
    mutationFn: async ({ order, difficulty }: { order: number; difficulty: number }) => {
      await papersApi(`/papers/${encodeURIComponent(paper!.paper_id)}/items/${order}`, {
        method: "PATCH", body: JSON.stringify({ difficulty }),
      });
    },
  });
  const finalizeItem = useMutation({
    mutationFn: () => papersApi(`/papers/${encodeURIComponent(paper!.paper_id)}/finalize`, { method: "POST" }),
  });
  const iterateItem = useMutation({
    mutationFn: () => papersApi<{ paper_id: string }>(`/papers/${encodeURIComponent(paper!.paper_id)}/iterate`, { method: "POST" }),
  });
  const exportItem = useMutation({
    mutationFn: () => papersApi<{ download_url?: string }>(`/papers/${encodeURIComponent(paper!.paper_id)}/export`, { method: "POST" }),
  });

  const refresh = async () => {
    if (!paper) return;
    await queryClient.invalidateQueries({ queryKey: ["teacher", "library", "papers"] });
    const detail = await papersApi<PaperDetail>(`/papers/${encodeURIComponent(paper.paper_id)}`);
    onChanged(detail);
  };

  const run = async (fn: () => Promise<unknown>) => {
    try { await fn(); await refresh(); } catch (error) { window.alert(error instanceof Error ? error.message : String(error)); }
  };

  const mutateItem = async (order: number, action: "harder" | "easier" | "same") => {
    await run(() => swapItem.mutateAsync({ order, action }));
  };

  const handleExport = async () => {
    try {
      const result = await exportItem.mutateAsync();
      if (result.download_url) {
        const anchor = window.open(result.download_url, "_blank", "noopener,noreferrer");
        if (!anchor) window.location.href = result.download_url;
      }
      await refresh();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  };

  if (!paper) return null;

  const counts = paper.config?.counts ?? {};
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const countSummary = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([key, n]) => `${TYPE_META[key]?.label ?? key} ${n}`)
    .join(" · ");

  return (
    <Dialog open onOpenChange={(value) => { if (!value && !swapItem.isPending && !adjustDifficulty.isPending) onClose(); }}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {paper.title} <span className="ml-2 text-xs text-muted-foreground">v{paper.version_no} · {paper.items.length} 题 · {STATUS_LABEL[paper.status]}</span>
          </DialogTitle>
          <DialogDescription>
            共 {total} 题（{countSummary}），难度易:中:难 = {paper.config?.difficulty_ratio?.easy ?? 0}:{(paper.config?.difficulty_ratio?.medium ?? 0)}:{(paper.config?.difficulty_ratio?.hard ?? 0)}。
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[55vh] space-y-3 overflow-y-auto pr-1" aria-busy={swapItem.isPending || adjustDifficulty.isPending}>
          {paper.items.map((item) => (
            <article key={item.item_order} className="rounded-2xl border p-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold">{item.item_order + 1}. {STEM_LABEL[item.stem_format] ?? item.stem_format}</span>
                <span className="bg-muted rounded-full px-2 py-0.5 text-xs">{difficultyLabel(item.difficulty)} {item.difficulty?.toFixed ? `(${item.difficulty.toFixed(2)})` : ""}</span>
              </div>
              <div className="text-sm leading-relaxed">
                <MathText text={item.stem_markdown || "（题目内容）"} />
              </div>
              {item.options.length > 0 && (
                <ul className="mt-2 grid gap-1 text-sm">
                  {item.options.map((option) => (
                    <li key={option.option_key}><span className="mr-1 font-semibold">{option.option_key}.</span><MathText text={option.option_text} /></li>
                  ))}
                </ul>
              )}
              {paper.status === "draft" && (
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-2">
                  <Button size="sm" variant="outline" onClick={() => void mutateItem(item.item_order, "same")} disabled={swapItem.isPending}>
                    <Wand2Icon className="size-3.5" />换题
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void mutateItem(item.item_order, "easier")} disabled={swapItem.isPending}>偏轻</Button>
                  <Button size="sm" variant="ghost" onClick={() => void mutateItem(item.item_order, "harder")} disabled={swapItem.isPending}>偏重</Button>
                  <Button
                    size="sm" variant="ghost"
                    disabled={adjustDifficulty.isPending}
                    onClick={() => {
                      const next = item.difficulty === null ? 0.5 : Math.min(1, Number((item.difficulty + 0.1).toFixed(2)));
                      void run(() => adjustDifficulty.mutateAsync({ order: item.item_order, difficulty: next }));
                    }}
                  >
                    <Undo2Icon className="size-3.5" />难度+0.1
                  </Button>
                </div>
              )}
            </article>
          ))}
        </div>

        <DialogFooter className="flex-wrap gap-2">
          <Button size="sm" variant="outline" type="button" disabled={exportItem.isPending} onClick={() => void handleExport()} title="生成整卷 PDF 并下载">
            {exportItem.isPending
              ? <Loader2Icon className="size-3.5 animate-spin motion-reduce:animate-none" />
              : <DownloadIcon className="size-3.5" />}
            {paper.pdf_sha256 ? "重新下载 PDF" : "生成 PDF"}
          </Button>
          {paper.status === "finalized" && (
            <Button size="sm" variant="outline" type="button" onClick={() => onOpenAnswer?.(paper)} title="生成并复核参考答案与解析">
              <BookOpenIcon className="size-3.5" />
              {paper.answer_pdf_sha256 ? "答案解析" : "生成答案解析"}
            </Button>
          )}
          {paper.status === "draft" ? (
            <Button size="sm" disabled={finalizeItem.isPending} onClick={() => void run(() => finalizeItem.mutateAsync())}>
              {finalizeItem.isPending && <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" />}定稿存档
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={iterateItem.isPending} onClick={() => void run(async () => { await iterateItem.mutateAsync(); onClose(); })}>
              <PlusIcon className="size-3.5" />以此卷新建版本
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onClose}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AnswerReviewDialog({ paper, open, onClose, onChanged }: {
  paper: PaperDetail | null;
  open: boolean;
  onClose: () => void;
  onChanged: (fresh: PaperDetail) => void;
}) {
  const queryClient = useQueryClient();
  const [items, setItems] = useState<AnswerReviewItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!paper) return;
    setLoading(true);
    setError(null);
    try {
      let data = await getAnswerApi(paper.paper_id);
      if (!data.items || data.items.length === 0) {
        data = await prepareAnswerApi(paper.paper_id);
      }
      setItems(data.items ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open && paper) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, paper?.paper_id]);

  const updateItem = (order: number, patch: Partial<AnswerReviewItem>) => {
    setItems((prev) => prev.map((item) => (item.item_order === order ? { ...item, ...patch } : item)));
  };

  const unresolved = items.filter((item) => item.need_review).length;

  const handleSave = async () => {
    if (!paper) return;
    setSaving(true);
    setError(null);
    try {
      await saveAnswerItemsApi(paper.paper_id, items);
      await queryClient.invalidateQueries({ queryKey: ["teacher", "library", "papers"] });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const handleRender = async () => {
    if (!paper) return;
    setRendering(true);
    setError(null);
    try {
      await handleSave();
      const result = await renderAnswerApi(paper.paper_id);
      if (result.download_url) {
        const anchor = window.open(result.download_url, "_blank", "noopener,noreferrer");
        if (!anchor) window.location.href = result.download_url;
      }
      const detail = await papersApi<PaperDetail>(`/papers/${encodeURIComponent(paper.paper_id)}`);
      onChanged(detail);
    } catch (renderError) {
      setError(renderError instanceof Error ? renderError.message : String(renderError));
    } finally {
      setRendering(false);
    }
  };

  if (!paper) return null;

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value && !saving && !rendering) onClose(); }}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>答案解析 · {paper.title}</DialogTitle>
          <DialogDescription>
            逐题核对答案与解析，可在线修改。红色【复核】项须全部处理后才能生成 PDF。
            {unresolved > 0 ? ` 还有 ${unresolved} 题待复核。` : " 无待复核项。"}
          </DialogDescription>
        </DialogHeader>

        {error && <p className="text-destructive text-sm">{error}</p>}

        <div className="max-h-[55vh] space-y-3 overflow-y-auto pr-1" aria-busy={loading}>
          {loading && <p className="text-muted-foreground text-sm">正在生成答案解析…（缺失解析的题目会调用 AI 补全，可能需要一点时间）</p>}
          {!loading && items.length === 0 && <p className="text-muted-foreground text-sm">暂无答案解析数据。</p>}
          {items.map((item) => (
            <article key={item.item_order} className={`rounded-2xl border p-4 ${item.need_review ? "border-destructive/60" : ""}`}>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold">{item.item_order + 1}. {STEM_LABEL[item.stem_format] ?? item.stem_format}</span>
                <div className="flex items-center gap-2">
                  <span className="bg-muted rounded-full px-2 py-0.5 text-xs">{item.source === "ai" ? "AI 补全" : item.source === "teacher" ? "已复核" : "题库"}</span>
                  {item.need_review && <span className="rounded-full bg-destructive px-2 py-0.5 text-xs text-white">待复核</span>}
                </div>
              </div>
              <div className="text-sm leading-relaxed">
                <MathText text={item.stem_markdown || "（题目内容）"} />
              </div>
              {item.options.length > 0 && (
                <ul className="mt-2 grid gap-1 text-sm">
                  {item.options.map((option) => (
                    <li key={option.option_key}><span className="mr-1 font-semibold">{option.option_key}.</span><MathText text={option.option_text} /></li>
                  ))}
                </ul>
              )}
              {item.need_review && item.review_note && (
                <p className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{item.review_note}</p>
              )}
              <div className="mt-3 grid gap-2">
                <label className="grid gap-1">
                  <span className="text-muted-foreground text-xs font-semibold">答案</span>
                  <textarea
                    className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring min-h-[44px] w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2"
                    value={item.answer_text}
                    onChange={(event) => updateItem(item.item_order, { answer_text: event.target.value })}
                    rows={1}
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-muted-foreground text-xs font-semibold">解析</span>
                  <textarea
                    className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring min-h-[96px] w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2"
                    value={item.analysis_text}
                    onChange={(event) => updateItem(item.item_order, { analysis_text: event.target.value })}
                    rows={4}
                  />
                </label>
                <div className="flex items-center gap-2">
                  <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      className="size-3.5"
                      checked={item.need_review}
                      onChange={(event) => updateItem(item.item_order, { need_review: event.target.checked })}
                    />
                    标记为待复核
                  </label>
                  {item.need_review && (
                    <input
                      className="border-input bg-background placeholder:text-muted-foreground min-w-0 flex-1 rounded-md border px-2 py-1 text-xs"
                      placeholder="复核说明（可选）"
                      value={item.review_note ?? ""}
                      onChange={(event) => updateItem(item.item_order, { review_note: event.target.value || null })}
                    />
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>

        <DialogFooter className="flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={saving || loading} onClick={() => void handleSave()}>
            {saving && <Loader2Icon className="size-3.5 animate-spin motion-reduce:animate-none" />}保存修改
          </Button>
          <Button size="sm" disabled={rendering || loading || unresolved > 0} onClick={() => void handleRender()} title={unresolved > 0 ? "请先处理待复核项" : "生成答案解析 PDF 并下载"}>
            {rendering
              ? <Loader2Icon className="size-3.5 animate-spin motion-reduce:animate-none" />
              : <DownloadIcon className="size-3.5" />}
            {paper.answer_pdf_sha256 ? "重新生成 PDF" : "生成答案解析 PDF"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PaperComposePage() {
  const { principal } = useAuth();
  const [autoOpen, setAutoOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [previewPaper, setPreviewPaper] = useState<PaperDetail | null>(null);
  const [answerPaper, setAnswerPaper] = useState<PaperDetail | null>(null);

  const openDetail = async (paperId: string) => {
    const detail = await papersApi<PaperDetail>(`/papers/${encodeURIComponent(paperId)}`);
    setPreviewPaper(detail);
  };

  if (!principal?.roles.includes("teacher")) {
    return <main className="mx-auto w-full max-w-5xl p-10"><p className="text-muted-foreground text-sm">教师专属页面，请用教师账号登录后查看。</p></main>;
  }

  return (
    <main className="mx-auto w-full max-w-5xl p-5 md:p-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">组卷工作台</h1>
        <p className="text-muted-foreground mt-1 text-sm">设置题型题量与难度，从解析出的题目池自动组卷，或手工挑选题目。题型不限于三种，可随时补充多选题、判断题等。</p>
      </div>
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <button type="button" onClick={() => setAutoOpen(true)} className="hover:bg-accent/50 rounded-2xl border p-6 text-start transition-colors">
          <Wand2Icon className="size-6" />
          <h2 className="mt-3 font-semibold">智能组卷</h2>
          <p className="text-muted-foreground mt-1 text-sm">按题型题量与难度比例，从解析出的题目池自动抽取成卷。</p>
        </button>
        <button type="button" onClick={() => setManualOpen(true)} className="hover:bg-accent/50 rounded-2xl border p-6 text-start transition-colors">
          <BookOpenIcon className="size-6" />
          <h2 className="mt-3 font-semibold">自选题组卷</h2>
          <p className="text-muted-foreground mt-1 text-sm">从私人题库逐题勾选，组成符合你要求的试卷。</p>
        </button>
      </div>

      <ManualPaperDialog open={manualOpen} onOpenChange={setManualOpen} onCreated={(id) => void openDetail(id)} />
      <AutoPaperDialog open={autoOpen} onOpenChange={setAutoOpen} onCreated={(id) => void openDetail(id)} />
      <PaperDetailDialog paper={previewPaper} onClose={() => setPreviewPaper(null)} onChanged={(fresh) => setPreviewPaper(fresh)} onOpenAnswer={(paper) => setAnswerPaper(paper)} />
      <AnswerReviewDialog
        paper={answerPaper}
        open={answerPaper !== null}
        onClose={() => setAnswerPaper(null)}
        onChanged={(fresh) => { setPreviewPaper(fresh); setAnswerPaper(fresh); }}
      />
    </main>
  );
}
