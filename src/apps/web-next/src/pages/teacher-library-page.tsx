"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArchiveIcon,
  BookOpenCheckIcon,
  FileTextIcon,
  FolderOpenIcon,
  ListChecksIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  TrashIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
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
import { useAuth } from "@/auth";
import { cn } from "@/lib/utils";
import { MathText } from "@/components/assistant-ui/elements/math-text";
import { PaperLibrarySection } from "./paper-library-section.tsx";

type CandidateSummary = {
  candidate_set_id: string;
  phase: "ktq" | "er";
  status: string;
  item_count: number;
  display_name: string | null;
  created_at: string;
};

type PackageSummary = {
  package_id: string;
  origin: string;
  title: string;
  status: string;
  version_no: number;
  item_count: number;
  created_at: string;
};

type PickableQuestion = {
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

type LibraryView = { candidates: CandidateSummary[]; packages: PackageSummary[] };

async function libraryApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/content${path}`, {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body = await response.json().catch(() => ({})) as T & { error?: string; detail?: string };
  if (!response.ok) throw new Error(body.detail || body.error || `请求失败（${response.status}）`);
  return body;
}

const phaseLabel = (phase: string) => (phase === "ktq" ? "知识点/题型/题目抽取" : "错因扩展");
const candidateStatusLabel: Record<string, string> = {
  pending_review: "待人工检查",
  changes_requested: "已退回",
  approved: "已批准",
  superseded: "已更新",
};
const packageStatusLabel: Record<string, string> = {
  ready: "待发布",
  published: "已发布",
  withdrawn: "已撤回",
};

function dateLabel(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "时间待同步";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(parsed));
}

type RenameTarget = { kind: "candidate" | "package"; id: string; initial: string };

function batchLabel(batch: Pick<PickableQuestion, "batch_display_name" | "batch_phase"> | null | undefined): string {
  if (!batch?.batch_phase) return "未分组";
  const phaseName = batch.batch_phase === "ktq" ? "知识点/题型/题目抽取" : "错因扩展";
  return batch.batch_display_name || `${phaseName}批次`;
}

function ManualPackageDialog({ open, onOpenChange, onCreated }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [keyword, setKeyword] = useState("");
  const questions = useQuery({
    queryKey: ["teacher", "library", "questions"],
    queryFn: () => libraryApi<{ questions: PickableQuestion[] }>("/teacher/library/questions"),
    enabled: open,
  });
  const createPackage = useMutation({
    mutationFn: () => libraryApi<{ package_id: string }>("/teacher/library/packages/manual", {
      method: "POST",
      body: JSON.stringify({ title: title.trim(), revision_ids: [...selected] }),
    }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ["teacher", "library"] });
      onCreated();
      onOpenChange(false);
      window.location.assign(`/content/packages/${encodeURIComponent(created.package_id)}`);
    },
  });

  const list = useMemo(() => {
    const all = questions.data?.questions ?? [];
    const kw = keyword.trim();
    if (!kw) return all;
    return all.filter((item) =>
      `${item.entity_id} ${item.question_type_name ?? ""} ${item.stem_preview ?? ""} ${item.chapter_id ?? ""}`.toLowerCase().includes(kw.toLowerCase()),
    );
  }, [questions.data, keyword]);

  const grouped = useMemo(() => {
    const groups = new Map<string, PickableQuestion[]>();
    for (const item of list) {
      const key = item.batch_id ?? "unbound";
      const bucket = groups.get(key) ?? [];
      bucket.push(item);
      groups.set(key, bucket);
    }
    return [...groups.entries()];
  }, [list]);

  const toggle = (revisionId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(revisionId)) next.delete(revisionId); else next.add(revisionId);
      return next;
    });
  };

  const close = () => {
    if (createPackage.isPending) return;
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent showCloseButton={false} className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>自选题新建练习包</DialogTitle>
          <DialogDescription>从你解析出的题目里勾选，组成一个新的练习包，保存后可发布到班级。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Input
            autoFocus
            value={title}
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="练习包名称，例如：解三角形·选填专项"
            aria-label="练习包名称"
          />
          <div className="relative">
            <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
            <Input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜索题目关键词（题干/题型/编号）"
              aria-label="搜索题目"
              className="pl-9"
            />
          </div>
          <div className="text-muted-foreground text-xs">已选 {selected.size} 道</div>
          {questions.isPending && <Centered><Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" />正在读取可选题目</Centered>}
          {questions.error && <p className="text-destructive text-sm">{questions.error.message}</p>}
          {questions.data && (
            <div className="max-h-[45vh] space-y-4 overflow-y-auto pr-1">
              {grouped.map(([batchId, items]) => (
                <div key={batchId}>
                  <h4 className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs font-semibold">
                    <ListChecksIcon className="size-3.5" />{batchLabel(items[0])}（{items.length} 题）
                  </h4>
                  <div className="grid gap-2">
                    {items.map((item) => (
                      <label
                        key={item.revision_id}
                        className={cn(
                          "hover:bg-accent flex cursor-pointer items-start gap-3 rounded-xl border p-3",
                          selected.has(item.revision_id) && "border-primary/50 bg-primary/5",
                        )}
                      >
                        <input
                          type="checkbox"
                          className="mt-1 size-4 shrink-0"
                          checked={selected.has(item.revision_id)}
                          onChange={() => toggle(item.revision_id)}
                          aria-label={`选择题目 ${item.entity_id}`}
                        />
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-2 text-xs">
                            <span className="font-mono text-muted-foreground">{item.entity_id}</span>
                            {item.difficulty != null && <span>难度 {item.difficulty.toFixed(1)}</span>}
                            {item.question_type_name && <span>{item.question_type_name}</span>}
                            <span className="text-muted-foreground">v{item.revision_no}</span>
                          </span>
                          <span className="mt-1 block text-sm">
                            <MathText text={item.stem_preview || "（无题干）"} />
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
              {grouped.length === 0 && <Empty text="没有匹配的题目，换个关键词试试。" />}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={createPackage.isPending} onClick={close}>取消</Button>
          <Button
            type="button"
            disabled={createPackage.isPending || !title.trim() || selected.size === 0}
            onClick={() => createPackage.mutate()}
          >
            {createPackage.isPending && <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" />}
            保存练习包（{selected.size} 题）
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TeacherLibraryPage() {
  const { principal } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [pendingDelete, setPendingDelete] = useState<PackageSummary>();
  const [pendingCandidateDelete, setPendingCandidateDelete] = useState<CandidateSummary>();
  const [renameTarget, setRenameTarget] = useState<RenameTarget>();
  const [renameValue, setRenameValue] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const autoRequest = searchParams.get("paper") === "auto";
  useEffect(() => {
    if (autoRequest) setSearchParams({}, { replace: true });
  }, [autoRequest, setSearchParams]);
  const query = useQuery({
    queryKey: ["teacher", "library"],
    queryFn: () => libraryApi<LibraryView>("/teacher/library"),
    enabled: Boolean(principal?.roles.includes("teacher")),
    retry: 1,
  });
  const removePackage = useMutation({
    mutationFn: (packageId: string) => libraryApi<{ deleted: boolean }>(`/packages/${encodeURIComponent(packageId)}`, { method: "DELETE" }),
    onSuccess: async () => {
      setPendingDelete(undefined);
      await queryClient.invalidateQueries({ queryKey: ["teacher", "library"] });
    },
  });
  const removeCandidate = useMutation({
    mutationFn: (candidateSetId: string) => libraryApi<{ deleted: boolean }>(`/candidates/${encodeURIComponent(candidateSetId)}`, { method: "DELETE" }),
    onSuccess: async () => {
      setPendingCandidateDelete(undefined);
      await queryClient.invalidateQueries({ queryKey: ["teacher", "library"] });
    },
  });
  const renameItem = useMutation({
    mutationFn: async ({ kind, id, name }: { kind: "candidate" | "package"; id: string; name: string }) => {
      const path = kind === "candidate"
        ? `/candidates/${encodeURIComponent(id)}/display-name`
        : `/packages/${encodeURIComponent(id)}`;
      const body = kind === "candidate" ? { display_name: name } : { title: name };
      return libraryApi<{ renamed: boolean }>(path, { method: "PATCH", body: JSON.stringify(body) });
    },
    onSuccess: async () => {
      setRenameTarget(undefined);
      await queryClient.invalidateQueries({ queryKey: ["teacher", "library"] });
    },
  });

  const openRename = (target: RenameTarget) => {
    setRenameValue(target.initial);
    setRenameTarget(target);
  };
  const closeRename = () => {
    if (renameItem.isPending) return;
    setRenameTarget(undefined);
  };
  const submitRename = () => {
    if (!renameTarget) return;
    const name = renameValue.trim();
    if (!name) return;
    renameItem.mutate({ kind: renameTarget.kind, id: renameTarget.id, name });
  };

  if (!principal?.roles.includes("teacher")) {
    return <main className="mx-auto w-full max-w-5xl p-10"><p className="text-muted-foreground text-sm">教师专属页面，请用教师账号登录后查看。</p></main>;
  }

  const candidates = query.data?.candidates ?? [];
  const packages = (query.data?.packages ?? []).filter((item) => item.origin === "teacher");

  return (
    <main className="mx-auto w-full max-w-5xl p-5 md:p-10" aria-busy={query.isFetching}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">我的资料库</h1>
          <p className="text-muted-foreground mt-1 text-sm">上传资料后自动解析出的私有内容与练习包，只对你本人可见；发布到班级后学生才能在对话中作答。</p>
        </div>
        <Button variant="ghost" size="icon" onClick={() => void query.refetch()} aria-label="刷新">
          <RefreshCwIcon className={cn("size-4", query.isFetching && "animate-spin motion-reduce:animate-none")} />
        </Button>
      </div>

      {query.isPending && <Centered><Loader2Icon className="size-5 animate-spin motion-reduce:animate-none" />正在读取资料库</Centered>}
      {query.error && (
        <section className="mt-8 rounded-2xl border p-6 text-center">
          <p className="text-sm text-muted-foreground">{query.error.message}</p>
          <Button className="mt-4" variant="outline" onClick={() => void query.refetch()}>重试</Button>
        </section>
      )}

      <Section title="解析批次（候选集）" icon={<FolderOpenIcon className="size-4" />}>
        {candidates.length === 0 && <Empty text="还没有解析批次。在教师对话里上传 PDF/图片，系统会为你自动抽取并生成批次。" />}
        <div className="grid gap-3">
          {candidates.map((candidate) => (
            <article key={candidate.candidate_set_id} className="rounded-2xl border p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-medium">{candidate.display_name || `${phaseLabel(candidate.phase)}批次`}</h3>
                  <p className="text-muted-foreground mt-0.5 text-xs">{dateLabel(candidate.created_at)} · {candidate.item_count} 项</p>
                </div>
                <span className="bg-muted rounded-full px-2.5 py-1 text-xs">{candidateStatusLabel[candidate.status] ?? candidate.status}</span>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Link className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline" to={`/content/review/${encodeURIComponent(candidate.candidate_set_id)}`}>
                  查看与处理
                </Link>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => openRename({ kind: "candidate", id: candidate.candidate_set_id, initial: candidate.display_name || `${phaseLabel(candidate.phase)}批次` })}
                >
                  <PencilIcon className="size-3.5" />重命名
                </Button>
                <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setPendingCandidateDelete(candidate)}>
                  <TrashIcon className="size-3.5" />删除
                </Button>
              </div>
            </article>
          ))}
        </div>
      </Section>

      <Section
        title="练习包（可发布到班级）"
        icon={<ArchiveIcon className="size-4" />}
        action={
          <Button size="sm" variant="outline" onClick={() => setManualOpen(true)}>
            <PlusIcon className="size-3.5" />自选题新建
          </Button>
        }
      >
        {packages.length === 0 && <Empty text="还没有练习包。可以点右上角「自选题新建」，或等解析批次自动推进生成包。" />}
        <div className="grid gap-3">
          {packages.map((pkg) => (
            <article key={pkg.package_id} className="rounded-2xl border p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-medium">{pkg.title}</h3>
                  <p className="text-muted-foreground mt-0.5 text-xs">v{pkg.version_no} · {pkg.item_count} 项 · {dateLabel(pkg.created_at)}</p>
                </div>
                <span className="bg-muted rounded-full px-2.5 py-1 text-xs">{packageStatusLabel[pkg.status] ?? pkg.status}</span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => navigate(`/content/packages/${encodeURIComponent(pkg.package_id)}`)}>
                  <BookOpenCheckIcon className="size-3.5" />{pkg.status === "ready" ? "发布到班级" : "查看发布"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => openRename({ kind: "package", id: pkg.package_id, initial: pkg.title })}>
                  <PencilIcon className="size-3.5" />重命名
                </Button>
                {pkg.status === "ready" && (
                  <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setPendingDelete(pkg)}>
                    <TrashIcon className="size-3.5" />删除
                  </Button>
                )}
              </div>
            </article>
          ))}
        </div>
      </Section>

      <Section title="我的试卷" icon={<FileTextIcon className="size-4" />}>
        <PaperLibrarySection autoRequest={autoRequest ? 1 : 0} />
      </Section>

      <Dialog open={renameTarget !== undefined} onOpenChange={(open) => { if (!open) closeRename(); }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>重命名{renameTarget?.kind === "package" ? "练习包" : "批次"}</DialogTitle>
            <DialogDescription>输入新的名称，保存后会在资料库列表中显示。</DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              submitRename();
            }}
          >
            <Input
              autoFocus
              maxLength={120}
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              placeholder={renameTarget?.kind === "package" ? "练习包名称" : "批次名称"}
              aria-label="新名称"
            />
            <DialogFooter>
              <Button type="button" variant="outline" disabled={renameItem.isPending} onClick={closeRename}>取消</Button>
              <Button type="submit" disabled={renameItem.isPending || !renameValue.trim()}>
                {renameItem.isPending && <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" />}保存
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={pendingDelete !== undefined} onOpenChange={(open) => { if (!open && !removePackage.isPending) setPendingDelete(undefined); }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>删除练习包</DialogTitle>
            <DialogDescription>确定要删除「{pendingDelete?.title}」吗？仅未发布的包可删除，已发布内容不受影响。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={removePackage.isPending} onClick={() => setPendingDelete(undefined)}>取消</Button>
            <Button variant="destructive" disabled={removePackage.isPending} onClick={() => pendingDelete && removePackage.mutate(pendingDelete.package_id)}>
              {removePackage.isPending && <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" />}删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pendingCandidateDelete !== undefined} onOpenChange={(open) => { if (!open && !removeCandidate.isPending) setPendingCandidateDelete(undefined); }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>删除解析批次</DialogTitle>
            <DialogDescription>确定删除「{pendingCandidateDelete?.display_name || (pendingCandidateDelete ? `${phaseLabel(pendingCandidateDelete.phase)}批次` : "") }」吗？批次会从列表隐藏，已入题库的题目仍会保留。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={removeCandidate.isPending} onClick={() => setPendingCandidateDelete(undefined)}>取消</Button>
            <Button variant="destructive" disabled={removeCandidate.isPending} onClick={() => pendingCandidateDelete && removeCandidate.mutate(pendingCandidateDelete.candidate_set_id)}>
              {removeCandidate.isPending && <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" />}删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ManualPackageDialog open={manualOpen} onOpenChange={setManualOpen} onCreated={() => undefined} />
    </main>
  );
}

function Section({ title, icon, action, children }: { title: string; icon: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">{icon}{title}</h2>
        {action}
      </div>
      <div>{children}</div>
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="text-muted-foreground rounded-2xl border border-dashed p-6 text-center text-sm">{text}</div>;
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="text-muted-foreground flex min-h-40 items-center justify-center gap-2 text-sm" role="status">{children}</div>;
}
