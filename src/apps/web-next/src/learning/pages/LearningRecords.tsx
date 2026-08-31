"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  BookOpenCheckIcon,
  BrainCircuitIcon,
  CheckCircle2Icon,
  Clock3Icon,
  ExternalLinkIcon,
  HistoryIcon,
  Loader2Icon,
  MessageCircleMoreIcon,
  RefreshCwIcon,
  UsersIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, Outlet, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "@/auth";
import { Button } from "@/components/ui/button";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import type { CommandCapability, LearningView } from "../contracts";
import { LearningSidebar } from "../components/LearningSidebar";
import { learningApi, learningKeys } from "../data/client";

export function LearningRecordsLayout() {
  return (
    <SidebarProvider>
      <LearningSidebar />
      <SidebarInset className="min-h-dvh">
        <header className="bg-background/92 sticky top-0 z-20 flex h-14 items-center gap-2 border-b px-3 backdrop-blur md:px-6">
          <SidebarTrigger aria-label="打开导航" />
          <Link to="/" className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-sm">
            <ArrowLeftIcon className="size-4" />返回对话
          </Link>
        </header>
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}

type OwnPageKind = "overview" | "history" | "state" | "memory" | "review";

const ownPages: Record<OwnPageKind, { title: string; description: string; path: string }> = {
  overview: { title: "学习概览", description: "下一步建议与近期有依据的变化。", path: "/api/learning/me/overview" },
  history: { title: "学习历史", description: "按题目与判定事实回看学习过程。", path: "/api/learning/me/history" },
  state: { title: "科学状态", description: "掌握、保持与错因状态都可回到证据。", path: "/api/learning/me/state" },
  memory: { title: "学习记忆", description: "系统已发布、可反馈且可停用的学习观察。", path: "/api/learning/me/memories" },
  review: { title: "复习队列", description: "到期保持性复习与错因验证。", path: "/api/learning/me/reviews" },
};

export function OwnLearningPage({ kind }: { kind: OwnPageKind }) {
  const page = ownPages[kind];
  return <LearningViewPage title={page.title} description={page.description} url={page.path} />;
}

export function EvidencePage() {
  const { evidenceHandle = "" } = useParams();
  return (
    <LearningViewPage
      title="证据详情"
      description="这项状态如何由题目、作答、判定与规则产生。"
      url={`/api/learning/evidence/${encodeURIComponent(evidenceHandle)}`}
    />
  );
}

type StudentPageKind = "overview" | "history" | "state" | "memory" | "review";

export function TeacherStudentPage({ kind }: { kind: StudentPageKind }) {
  const { studentHandle = "" } = useParams();
  const suffix = kind === "memory" ? "memories" : kind === "review" ? "reviews" : kind;
  return (
    <LearningViewPage
      title={`学生 · ${ownPages[kind].title}`}
      description="教师视图只展示已授权、可追溯的学习事实。"
      url={`/api/learning/students/${encodeURIComponent(studentHandle)}/${suffix}`}
    />
  );
}

export function TeacherStudentsPage() {
  return (
    <LearningViewPage
      title="学生"
      description="当前教师可查看的学生与班级关系。"
      url="/api/learning/teacher/students"
    />
  );
}

function LearningViewPage({ title, description, url }: { title: string; description: string; url: string }) {
  const { principal, loading, requireAuth } = useAuth();
  const query = useQuery({
    queryKey: learningKeys.view(url),
    queryFn: () => learningApi.view(url),
    enabled: Boolean(principal),
    retry: 1,
  });

  if (loading && !principal) return <CenteredStatus><Loader2Icon className="size-5 animate-spin motion-reduce:animate-none" />正在读取账户</CenteredStatus>;
  if (!principal) {
    return (
      <main className="mx-auto w-full max-w-5xl p-6 md:p-10">
        <PageHeading title={title} description={description} />
        <section className="mt-8 rounded-2xl border p-6 text-center">
          <p className="text-muted-foreground text-sm">登录后才能读取正式学习记录。</p>
          <Button className="mt-4" onClick={() => requireAuth()}>登录</Button>
        </section>
      </main>
    );
  }
  return (
    <main className="mx-auto w-full max-w-5xl p-5 md:p-10">
      <div className="flex items-start justify-between gap-4">
        <PageHeading title={title} description={description} />
        <Button variant="ghost" size="icon" onClick={() => void query.refetch()} aria-label="刷新">
          <RefreshCwIcon className={cn("size-4", query.isFetching && "animate-spin motion-reduce:animate-none")} />
        </Button>
      </div>
      {query.isPending && <CenteredStatus><Loader2Icon className="size-5 animate-spin motion-reduce:animate-none" />正在读取学习记录</CenteredStatus>}
      {query.error && <ErrorPanel error={query.error} retry={() => void query.refetch()} />}
      {query.data && <LearningViewContent view={query.data} />}
    </main>
  );
}

function PageHeading({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-muted-foreground mt-1 text-sm">{description}</p>
    </div>
  );
}

function LearningViewContent({ view }: { view: LearningView }) {
  const data = objectValue(view.data);
  switch (view.view_kind) {
    case "learning_overview":
      return Object.hasOwn(data, "students") ? <StudentList data={data} /> : <Overview data={data} />;
    case "learning_history": return <History data={data} />;
    case "scientific_state":
    case "error_pattern_list": return <ScientificState data={data} />;
    case "memory_ledger": return <Memories data={data} />;
    case "review_queue": return <Reviews data={data} />;
    case "evidence_bundle": return <Evidence data={data} capabilities={view.command_capabilities} />;
    default: return <EmptyState text={stringValue(data.empty_state) ?? "这里暂时没有可展示的学习事实。"} />;
  }
}

function Overview({ data }: { data: Record<string, unknown> }) {
  const counts = objectValue(data.counts);
  const recommendation = objectValue(data.next_recommendation);
  const recent = arrayValue(data.recent_changes);
  return (
    <div className="mt-8 space-y-6">
      <LinkCard
        href={stringValue(recommendation.href) ?? "/"}
        title={stringValue(recommendation.title) ?? "开始学习"}
        summary={stringValue(recommendation.summary) ?? "告诉数学智元你现在想练什么。"}
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="题目会话" value={numberValue(counts.sessions)} />
        <Metric label="到期复习" value={numberValue(counts.due_reviews)} />
        <Metric label="待验证错因" value={numberValue(counts.error_verifications)} />
        <Metric label="学习记忆" value={numberValue(counts.memories)} />
      </div>
      <Section title="近期变化" icon={<HistoryIcon className="size-4" />}>
        {recent.length ? recent.map((entry, index) => {
          const item = objectValue(entry);
          return (
            <LinkCard
              key={stringValue(item.question_session_id) ?? index}
              compact
              href={`/c/${encodeURIComponent(stringValue(item.thread_id) ?? "")}`}
              title={stringValue(item.summary) ?? "学习记录"}
              summary={verdictLabel(stringValue(item.verdict))}
            />
          );
        }) : <EmptyState text={stringValue(data.empty_state) ?? "完成几次练习后，这里会出现学习记录。"} />}
      </Section>
    </div>
  );
}

function History({ data }: { data: Record<string, unknown> }) {
  const entries = arrayValue(data.entries);
  return (
    <Section className="mt-8" title="题目记录" icon={<HistoryIcon className="size-4" />}>
      {entries.length ? entries.map((entry, index) => {
        const item = objectValue(entry);
        const judgment = objectValue(item.judgment);
        return (
          <article key={stringValue(item.question_session_id) ?? index} className="rounded-2xl border p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="font-medium leading-6">{stringValue(item.question_summary) ?? "外部题目"}</h3>
                <p className="text-muted-foreground mt-1 text-xs">{dateLabel(stringValue(item.opened_at))} · {stringValue(item.scientific_impact) ?? "尚未形成正式判定"}</p>
              </div>
              <span className="bg-muted rounded-full px-2.5 py-1 text-xs">{verdictLabel(stringValue(judgment.verdict))}</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {stringValue(item.thread_href) && <TextLink href={stringValue(item.thread_href)!}>查看对话</TextLink>}
              {stringValue(judgment.evidence_href) && <TextLink href={stringValue(judgment.evidence_href)!}>查看依据</TextLink>}
            </div>
          </article>
        );
      }) : <EmptyState text="还没有学习历史。" />}
    </Section>
  );
}

function ScientificState({ data }: { data: Record<string, unknown> }) {
  const dimensions = arrayValue(data.dimensions);
  const patterns = arrayValue(data.patterns);
  const entries = dimensions.length ? dimensions : patterns;
  return (
    <Section className="mt-8" title={patterns.length ? "错因状态" : "掌握与保持"} icon={<BrainCircuitIcon className="size-4" />}>
      {entries.length ? entries.map((entry, index) => {
        const item = objectValue(entry);
        const dimension = objectValue(item.dimension);
        const mastery = objectValue(item.mastery);
        return (
          <article key={stringValue(dimension.id) ?? stringValue(item.error_cause_id) ?? index} className="rounded-2xl border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-medium">{stringValue(dimension.label) ?? stringValue(item.title) ?? "学习维度"}</h3>
              <span className="bg-muted rounded-full px-2.5 py-1 text-xs">{stateLabel(stringValue(mastery.state) ?? stringValue(item.state))}</span>
            </div>
            <p className="text-muted-foreground mt-2 text-sm leading-6">{stringValue(item.behavior) ?? masterySummary(mastery)}</p>
            {stringValue(item.evidence_href) && <div className="mt-3"><TextLink href={stringValue(item.evidence_href)!}>查看依据</TextLink></div>}
          </article>
        );
      }) : <EmptyState text={stringValue(data.empty_state) ?? "完成几次独立练习后，这里会显示有依据的状态。"} />}
    </Section>
  );
}

function Memories({ data }: { data: Record<string, unknown> }) {
  const entries = arrayValue(data.memories);
  return (
    <Section className="mt-8" title="学习观察" icon={<Clock3Icon className="size-4" />}>
      {entries.length ? entries.map((entry, index) => <MemoryCard key={stringValue(objectValue(entry).annotation_id) ?? index} entry={objectValue(entry)} />)
        : <EmptyState text={stringValue(data.empty_state) ?? "系统还没有发布可核对的学习观察。"} />}
    </Section>
  );
}

function MemoryCard({ entry }: { entry: Record<string, unknown> }) {
  const queryClient = useQueryClient();
  const commands = capabilityValues(entry.commands);
  const feedback = commands.find((command) => command.action === "annotation_feedback");
  const preference = commands.find((command) => command.action === "set_context_preference");
  const mutation = useMutation({
    mutationFn: ({ command, body, scope }: { command: CommandCapability; body: Record<string, unknown>; scope: string }) =>
      learningApi.command(command.href, command.expected_version, body, scope),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: learningKeys.all }); },
  });
  return (
    <article className="rounded-2xl border p-4">
      <h3 className="font-medium leading-6">{stringValue(entry.claim) ?? "学习观察"}</h3>
      <p className="text-muted-foreground mt-1 text-xs">{stringValue(entry.evidence_summary) ?? `可信度：${stringValue(entry.confidence) ?? "待积累"}`}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {feedback && <Button size="sm" variant="outline" disabled={mutation.isPending} onClick={() => mutation.mutate({ command: feedback, body: { feedback: "helpful" }, scope: "memory-feedback" })}><CheckCircle2Icon />有帮助</Button>}
        {feedback && <Button size="sm" variant="ghost" disabled={mutation.isPending} onClick={() => mutation.mutate({ command: feedback, body: { feedback: "inaccurate" }, scope: "memory-correction" })}><MessageCircleMoreIcon />不准确</Button>}
        {preference && <Button size="sm" variant="ghost" disabled={mutation.isPending} onClick={() => mutation.mutate({ command: preference, body: { annotation_id: stringValue(entry.annotation_id), personalization_enabled: false }, scope: "memory-mute" })}>停止用于个性化</Button>}
        {stringValue(objectValue(entry.support).href) && <TextLink href={stringValue(objectValue(entry.support).href)!}>查看依据</TextLink>}
      </div>
    </article>
  );
}

function Reviews({ data }: { data: Record<string, unknown> }) {
  const items = arrayValue(data.items);
  return (
    <Section className="mt-8" title="待复习项目" icon={<BookOpenCheckIcon className="size-4" />}>
      {items.length ? items.map((entry, index) => <ReviewCard key={stringValue(objectValue(entry).review_item_ref) ?? index} entry={objectValue(entry)} />)
        : <EmptyState text={stringValue(data.empty_state) ?? "目前没有需要立即完成的复习。"} />}
    </Section>
  );
}

function ReviewCard({ entry }: { entry: Record<string, unknown> }) {
  const navigate = useNavigate();
  const command = capabilityValues(entry.commands).find((item) => item.action === "start_review");
  const mutation = useMutation({
    mutationFn: () => learningApi.command<{ thread?: { thread_id?: string } }>(command!.href, command!.expected_version, {}, "start-review"),
    onSuccess: (receipt) => {
      const threadId = receipt.thread?.thread_id;
      if (threadId) navigate(`/c/${encodeURIComponent(threadId)}`);
    },
  });
  return (
    <article className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border p-4">
      <div>
        <h3 className="font-medium">{stringValue(entry.label) ?? "复习项目"}</h3>
        <p className="text-muted-foreground mt-1 text-xs">{stringValue(entry.status) === "due" ? "已到期" : `计划于 ${dateLabel(stringValue(entry.due_at))}`}</p>
      </div>
      {command && <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? "正在开始…" : "开始复习"}</Button>}
    </article>
  );
}

function Evidence({ data, capabilities }: { data: Record<string, unknown>; capabilities: CommandCapability[] }) {
  const subject = objectValue(data.subject);
  const question = objectValue(data.question);
  const judgment = objectValue(data.judgment);
  const replacement = objectValue(judgment.replacement);
  const relations = arrayValue(data.scientific_relations);
  const correction = capabilities.find((command) => command.action === "teacher_supersede_fact");
  return (
    <div className="mt-8 space-y-5">
      {stringValue(replacement.id) && (
        <section className="border-primary/30 bg-primary/5 rounded-2xl border p-5">
          <div className="text-primary text-xs font-medium">此判定后来已更正</div>
          <h2 className="mt-2 text-lg font-semibold">{verdictLabel(stringValue(replacement.verdict))}</h2>
          <p className="text-muted-foreground mt-2 text-sm leading-6">{stringValue(replacement.summary) ?? "请以替代判定为准。"}</p>
        </section>
      )}
      <section className="rounded-2xl border p-5">
        <div className="text-muted-foreground text-xs font-medium">{stringValue(replacement.id) ? "历史结论" : "当前结论"}</div>
        <h2 className="mt-2 text-lg font-semibold">{stringValue(subject.label) ?? "学习依据"}</h2>
        <p className="text-muted-foreground mt-3 text-sm leading-6">{stringValue(question.prompt_summary) ?? "跨题学习观察"}</p>
        {stringValue(judgment.verdict) && (
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <span className="bg-muted rounded-full px-2.5 py-1">{verdictLabel(stringValue(judgment.verdict))}</span>
            <span className="bg-muted rounded-full px-2.5 py-1">不确定性：{stringValue(judgment.uncertainty) ?? "未标注"}</span>
            <span className="bg-muted rounded-full px-2.5 py-1">事实版本：{numberValue(judgment.fact_version)}</span>
          </div>
        )}
      </section>
      <Section title="科学关系" icon={<BrainCircuitIcon className="size-4" />}>
        {relations.length ? relations.map((relation, index) => {
          const item = objectValue(relation);
          return <div key={index} className="rounded-xl border p-3 text-sm"><span className="font-medium">{stringValue(item.relation) ?? "关系"}</span><p className="text-muted-foreground mt-1 leading-6">{stringValue(item.explanation) ?? "—"}</p></div>;
        }) : <EmptyState text="没有额外关系说明。" />}
      </Section>
      {correction && <TeacherCorrectionForm data={data} capability={correction} />}
      {stringValue(data.thread_href) && <TextLink href={stringValue(data.thread_href)!}>返回相关对话</TextLink>}
    </div>
  );
}

function TeacherCorrectionForm({ data, capability }: { data: Record<string, unknown>; capability: CommandCapability }) {
  const judgment = objectValue(data.judgment);
  const [verdict, setVerdict] = useState(stringValue(judgment.verdict) ?? "unresolved");
  const [summary, setSummary] = useState(stringValue(judgment.summary) ?? "");
  const [reason, setReason] = useState("");
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => learningApi.command(
      capability.href,
      capability.expected_version,
      { verdict, decision_summary: summary.trim(), reason: reason.trim() },
      "teacher-correction",
    ),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: learningKeys.all }); },
  });
  const ready = Boolean(summary.trim() && reason.trim());
  return (
    <section className="rounded-2xl border p-5">
      <h2 className="text-sm font-semibold">提交教师纠正</h2>
      <p className="text-muted-foreground mt-1 text-xs leading-5">会追加替代判定并重放科学状态，历史判定不会被覆盖。</p>
      <div className="mt-4 grid gap-3">
        <label className="grid gap-1.5 text-sm">
          <span className="font-medium">替代结论</span>
          <select
            value={verdict}
            disabled={mutation.isPending || mutation.isSuccess}
            onChange={(event) => setVerdict(event.target.value)}
            className="border-input bg-background focus-visible:ring-ring min-h-10 rounded-lg border px-3 outline-none focus-visible:ring-2"
          >
            <option value="correct">正确</option>
            <option value="partially_correct">部分正确</option>
            <option value="incorrect">需要调整</option>
            <option value="unresolved">尚不能判定</option>
          </select>
        </label>
        <label className="grid gap-1.5 text-sm">
          <span className="font-medium">判定说明</span>
          <textarea
            rows={3}
            maxLength={2000}
            value={summary}
            disabled={mutation.isPending || mutation.isSuccess}
            onChange={(event) => setSummary(event.target.value)}
            className="border-input bg-background focus-visible:ring-ring min-h-20 resize-y rounded-lg border px-3 py-2 outline-none focus-visible:ring-2"
          />
        </label>
        <label className="grid gap-1.5 text-sm">
          <span className="font-medium">更正原因</span>
          <textarea
            rows={3}
            maxLength={2000}
            required
            value={reason}
            disabled={mutation.isPending || mutation.isSuccess}
            onChange={(event) => setReason(event.target.value)}
            placeholder="说明为什么需要替代原判定"
            className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring min-h-20 resize-y rounded-lg border px-3 py-2 outline-none focus-visible:ring-2"
          />
        </label>
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={!ready || mutation.isPending || mutation.isSuccess} onClick={() => mutation.mutate()}>
            {mutation.isPending ? "正在提交…" : mutation.isSuccess ? "纠正已记录" : "提交纠正"}
          </Button>
          {mutation.isSuccess && <span className="text-muted-foreground text-xs">科学状态正在重放</span>}
        </div>
        {mutation.error && <p role="alert" className="text-destructive text-xs">{mutation.error.message}</p>}
      </div>
    </section>
  );
}

function StudentList({ data }: { data: Record<string, unknown> }) {
  const students = arrayValue(data.students);
  return (
    <Section className="mt-8" title="已授权学生" icon={<UsersIcon className="size-4" />}>
      {students.length ? students.map((student, index) => {
        const item = objectValue(student);
        const handle = stringValue(item.student_handle) ?? "";
        return <LinkCard key={handle || index} href={`/teacher/students/${encodeURIComponent(handle)}`} title={stringValue(item.display_name) ?? "学生"} summary={arrayValue(item.class_names).map(String).join("、") || "已建立教师关系"} />;
      }) : <EmptyState text="当前没有已授权学生。" />}
    </Section>
  );
}

function Section({ title, icon, className, children }: { title: string; icon: ReactNode; className?: string; children: ReactNode }) {
  return <section className={className}><h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">{icon}{title}</h2><div className="grid gap-3">{children}</div></section>;
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div className="rounded-2xl border p-4"><div className="text-2xl font-semibold tabular-nums">{value}</div><div className="text-muted-foreground mt-1 text-xs">{label}</div></div>;
}

function LinkCard({ href, title, summary, compact = false }: { href: string; title: string; summary: string; compact?: boolean }) {
  return <Link to={href} className={cn("hover:bg-muted/45 group flex items-start justify-between gap-3 rounded-2xl border transition-colors", compact ? "p-3" : "p-5")}><div><h3 className="font-medium">{title}</h3><p className="text-muted-foreground mt-1 text-sm leading-6">{summary}</p></div><ExternalLinkIcon className="text-muted-foreground mt-0.5 size-4 shrink-0 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" /></Link>;
}

function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return <Link to={href} className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline">{children}<ExternalLinkIcon className="size-3" /></Link>;
}

function EmptyState({ text }: { text: string }) {
  return <div className="text-muted-foreground rounded-2xl border border-dashed p-6 text-center text-sm">{text}</div>;
}

function CenteredStatus({ children }: { children: ReactNode }) {
  return <div className="text-muted-foreground flex min-h-56 items-center justify-center gap-2 text-sm" role="status">{children}</div>;
}

function ErrorPanel({ error, retry }: { error: Error; retry: () => void }) {
  return <section role="alert" className="border-destructive/30 bg-destructive/5 mt-8 rounded-2xl border p-5"><h2 className="font-medium">学习记录暂时无法读取</h2><p className="text-muted-foreground mt-1 text-sm">{error.message}</p><Button className="mt-4" size="sm" variant="outline" onClick={retry}>重试</Button></section>;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function capabilityValues(value: unknown): CommandCapability[] {
  return arrayValue(value).filter((item): item is CommandCapability => {
    const candidate = objectValue(item);
    return typeof candidate.action === "string" && typeof candidate.href === "string" && typeof candidate.expected_version === "number";
  });
}

function dateLabel(value: string | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "时间待同步";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function verdictLabel(value: string | undefined): string {
  const labels: Record<string, string> = { correct: "回答正确", incorrect: "需要改进", partial: "部分正确", inconclusive: "暂不确定" };
  return value ? labels[value] ?? value : "尚未判定";
}

function stateLabel(value: string | undefined): string {
  const labels: Record<string, string> = { emerging: "正在形成", developing: "发展中", stable: "较稳定", mastered: "已掌握", suspected: "待确认", confirmed: "已确认", improving: "正在改善", resolved: "近期已验证" };
  return value ? labels[value] ?? value : "待积累";
}

function masterySummary(mastery: Record<string, unknown>): string {
  const probability = typeof mastery.p_mastery === "number" ? `${Math.round(mastery.p_mastery * 100)}%` : "待积累";
  return `当前估计 ${probability}；独立证据 ${numberValue(mastery.independent_count)} 次。`;
}
