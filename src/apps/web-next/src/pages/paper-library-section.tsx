"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpenIcon,
  FileTextIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
  Wand2Icon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  AnswerReviewDialog,
  AutoPaperDialog,
  ManualPaperDialog,
  PaperDetailDialog,
  STATUS_LABEL,
  dateLabel,
  papersApi,
} from "./paper-compose.tsx";
import type { PaperConfig, PaperDetail } from "./paper-compose.tsx";

type PaperSummary = {
  paper_id: string;
  title: string;
  version_no: number;
  status: "draft" | "finalized";
  source: "manual" | "upload";
  config_snapshot: PaperConfig;
  pdf_sha256: string | null;
  created_at: string;
  finalized_at: string | null;
  item_count: number;
};

export function PaperLibrarySection({ autoRequest = 0 }: { autoRequest?: number }) {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [autoOpen, setAutoOpen] = useState(false);
  const [previewPaper, setPreviewPaper] = useState<PaperDetail | null>(null);
  const [answerPaper, setAnswerPaper] = useState<PaperDetail | null>(null);
  const [renamePaper, setRenamePaper] = useState<PaperSummary | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deletePaper, setDeletePaper] = useState<PaperSummary | null>(null);

  useEffect(() => {
    if (autoRequest > 0) setAutoOpen(true);
  }, [autoRequest]);

  const papers = useQuery({
    queryKey: ["teacher", "library", "papers"],
    queryFn: () => papersApi<{ papers: PaperSummary[] }>("/papers"),
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["teacher", "library", "papers"] });
  };

  const openDetail = async (paperId: string) => {
    const detail = await papersApi<PaperDetail>(`/papers/${encodeURIComponent(paperId)}`);
    setPreviewPaper(detail);
  };
  const closeDetail = () => setPreviewPaper(null);

  const renameItem = useMutation({
    mutationFn: (title: string) => papersApi<{ renamed: boolean }>(`/papers/${encodeURIComponent(renamePaper!.paper_id)}`, { method: "PATCH", body: JSON.stringify({ title }) }),
    onSuccess: async () => {
      setRenamePaper(null);
      await invalidate();
    },
  });
  const removeItem = useMutation({
    mutationFn: (paperId: string) => papersApi<{ deleted: boolean }>(`/papers/${encodeURIComponent(paperId)}`, { method: "DELETE" }),
    onSuccess: async () => {
      setDeletePaper(null);
      await invalidate();
    },
  });

  const list = papers.data?.papers ?? [];

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><FileTextIcon className="size-4" />我的试卷</h2>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setAutoOpen(true)}>
            <Wand2Icon className="size-3.5" />智能组卷
          </Button>
          <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
            <PlusIcon className="size-3.5" />自选题新建
          </Button>
        </div>
      </div>

      {papers.isPending && <p className="text-muted-foreground text-sm">正在读取试卷…</p>}
      {papers.error && <p className="text-destructive text-sm">{papers.error.message}</p>}

      {!papers.isPending && !papers.error && list.length === 0 && (
        <div className="text-muted-foreground rounded-2xl border border-dashed p-6 text-center text-sm">
          还没有试卷。点「智能组卷」从解析出的题目池自动组卷，或点「自选题新建」手工挑题；生成后可预览、换题并定稿。
        </div>
      )}

      <div className="grid gap-3">
        {list.map((paper) => (
          <article key={paper.paper_id} className="rounded-2xl border p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <h3 className="font-medium">{paper.title}</h3>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  v{paper.version_no} · {paper.item_count} 题 · {dateLabel(paper.created_at)} · {paper.source === "upload" ? "上传组卷" : "自选题"}
                </p>
              </div>
              <span className={cn("rounded-full px-2.5 py-1 text-xs", paper.status === "draft" ? "bg-muted" : "bg-emerald-100 text-emerald-700")}>
                {STATUS_LABEL[paper.status]}
                {paper.status === "finalized" && paper.finalized_at ? ` · ${dateLabel(paper.finalized_at)}` : ""}
              </span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => void openDetail(paper.paper_id)}>
                <BookOpenIcon className="size-3.5" />查看与编辑
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setRenameValue(paper.title); setRenamePaper(paper); }}>
                <PencilIcon className="size-3.5" />重命名
              </Button>
              <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setDeletePaper(paper)}>
                <TrashIcon className="size-3.5" />删除
              </Button>
            </div>
          </article>
        ))}
      </div>

      <ManualPaperDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={(id) => void openDetail(id)} />
      <AutoPaperDialog open={autoOpen} onOpenChange={setAutoOpen} onCreated={(id) => void openDetail(id)} />
      <PaperDetailDialog paper={previewPaper} onClose={closeDetail} onChanged={async (fresh) => { setPreviewPaper(fresh); await invalidate(); }} onOpenAnswer={(paper) => setAnswerPaper(paper)} />
      <AnswerReviewDialog
        paper={answerPaper}
        open={answerPaper !== null}
        onClose={() => setAnswerPaper(null)}
        onChanged={async (fresh) => { setPreviewPaper(fresh); setAnswerPaper(fresh); await invalidate(); }}
      />

      <Dialog open={renamePaper !== null} onOpenChange={(open) => { if (!open && !renameItem.isPending) setRenamePaper(null); }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader><DialogTitle>重命名试卷</DialogTitle><DialogDescription>输入新的试卷名称。</DialogDescription></DialogHeader>
          <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); const name = renameValue.trim(); if (name) renameItem.mutate(name); }}>
            <Input autoFocus maxLength={200} value={renameValue} onChange={(event) => setRenameValue(event.target.value)} aria-label="新名称" />
            <DialogFooter>
              <Button type="button" variant="outline" disabled={renameItem.isPending} onClick={() => setRenamePaper(null)}>取消</Button>
              <Button type="submit" disabled={renameItem.isPending || !renameValue.trim()}>
                {renameItem.isPending && <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" />}保存
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={deletePaper !== null} onOpenChange={(open) => { if (!open && !removeItem.isPending) setDeletePaper(null); }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader><DialogTitle>删除试卷</DialogTitle><DialogDescription>确定删除「{deletePaper?.title}」吗？试卷与已生成的答案内容会一并移除，此操作不可撤销。</DialogDescription></DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={removeItem.isPending} onClick={() => setDeletePaper(null)}>取消</Button>
            <Button variant="destructive" disabled={removeItem.isPending} onClick={() => deletePaper && removeItem.mutate(deletePaper.paper_id)}>
              {removeItem.isPending && <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" />}删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
