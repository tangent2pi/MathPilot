"use client";

import { useQuery } from "@tanstack/react-query";
import {
  BookOpenIcon,
  BrainCircuitIcon,
  Clock3Icon,
  HistoryIcon,
  Loader2Icon,
  PanelRightIcon,
  RefreshCwIcon,
  SparklesIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { learningApi, learningKeys } from "../data/client";

export function LearningContextPanel({ threadId }: { threadId?: string }) {
  const url = threadId ? `/api/learning/threads/${encodeURIComponent(threadId)}/context` : "";
  const query = useQuery({
    queryKey: threadId ? learningKeys.view(url) : ["learning", "context", "new"],
    queryFn: () => learningApi.view(url),
    enabled: Boolean(threadId),
    retry: 1,
  });
  if (!threadId) return null;

  const content = (
    <ContextContent
      data={objectValue(query.data?.data)}
      loading={query.isPending}
      error={query.error}
      fetching={query.isFetching}
      refresh={() => void query.refetch()}
    />
  );

  return (
    <>
      <aside className="bg-background hidden h-full w-72 shrink-0 border-s min-[1180px]:flex" aria-label="学习上下文">
        {content}
      </aside>
      <Sheet>
        <SheetTrigger
          render={<Button variant="outline" size="icon" className="absolute end-2 top-2 z-20 min-[1180px]:hidden" />}
        >
          <PanelRightIcon />
          <span className="sr-only">打开学习上下文</span>
        </SheetTrigger>
        <SheetContent side="right" className="w-[min(92vw,22rem)] gap-0 p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>学习上下文</SheetTitle>
            <SheetDescription>当前题目、目标、学习观察和本轮参考内容。</SheetDescription>
          </SheetHeader>
          {content}
        </SheetContent>
      </Sheet>
    </>
  );
}

function ContextContent({
  data,
  loading,
  error,
  fetching,
  refresh,
}: {
  data: Record<string, unknown>;
  loading: boolean;
  error: Error | null;
  fetching: boolean;
  refresh: () => void;
}) {
  const question = objectValue(data.current_question);
  const intent = objectValue(data.current_intent);
  const activity = objectValue(data.current_activity);
  const manifest = objectValue(data.agent_context_manifest);
  const memories = arrayValue(data.relevant_memories);
  const operations = arrayValue(data.operations).filter((entry) => {
    const status = stringValue(objectValue(entry).status);
    return status === "accepted" || status === "running" || status === "needs_input";
  });

  return (
    <div className="soft-scrollbar flex h-full min-h-0 w-full flex-col overflow-y-auto">
      <header className="bg-background/92 sticky top-0 z-10 flex min-h-14 items-center justify-between border-b px-4 backdrop-blur">
        <div>
          <h2 className="text-sm font-semibold">学习上下文</h2>
          <p className="text-muted-foreground mt-0.5 text-xs">当前可见、实际生效的内容</p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={refresh} aria-label="刷新学习上下文">
          <RefreshCwIcon className={cn("size-3.5", fetching && "animate-spin motion-reduce:animate-none")} />
        </Button>
      </header>
      <div className="grid gap-5 p-4">
        {loading && (
          <div className="text-muted-foreground flex min-h-36 items-center justify-center gap-2 text-xs" role="status">
            <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" />正在读取上下文
          </div>
        )}
        {error && (
          <section role="alert" className="border-destructive/30 bg-destructive/5 rounded-xl border p-3 text-xs">
            <p className="font-medium">上下文暂时不可用</p>
            <p className="text-muted-foreground mt-1 leading-5">{error.message}</p>
          </section>
        )}
        {!loading && !error && (
          <>
            <ContextSection title="当前题" icon={<BookOpenIcon />}>
              {Object.keys(question).length ? (
                <ContextItem
                  title={stringValue(question.prompt_summary) ?? "当前题目"}
                  meta={questionStatus(stringValue(question.status))}
                />
              ) : <EmptyText>当前没有活动题目。</EmptyText>}
            </ContextSection>

            {(Object.keys(intent).length > 0 || Object.keys(activity).length > 0) && (
              <ContextSection title="本轮目标" icon={<SparklesIcon />}>
                {Object.keys(intent).length > 0 && <ContextItem title={stringValue(intent.summary) ?? "当前学习要求"} meta="选题要求" />}
                {Object.keys(activity).length > 0 && <ContextItem title={stringValue(activity.goal) ?? "正在进行的学习活动"} meta={stringValue(activity.status) ?? "进行中"} />}
              </ContextSection>
            )}

            <ContextSection title="相关学习观察" icon={<BrainCircuitIcon />}>
              {memories.length ? memories.map((entry, index) => {
                const item = objectValue(entry);
                return (
                  <Link
                    key={stringValue(item.annotation_id) ?? index}
                    to={stringValue(item.href) ?? "/learning/memory"}
                    className="hover:bg-muted/55 block rounded-xl border p-3 transition-colors"
                  >
                    <p className="text-sm leading-5">{stringValue(item.claim) ?? "学习观察"}</p>
                    <p className="text-muted-foreground mt-1 text-xs">查看范围与依据</p>
                  </Link>
                );
              }) : <EmptyText>本轮没有装入学习观察。</EmptyText>}
            </ContextSection>

            <ContextSection title="本轮参考内容" icon={<HistoryIcon />}>
              {Object.keys(manifest).length ? (
                <div className="rounded-xl border p-3">
                  <ul className="grid gap-1.5 text-xs">
                    {arrayValue(manifest.includes).map((entry, index) => <li key={`${String(entry)}:${index}`}>· {String(entry)}</li>)}
                  </ul>
                  <p className="text-muted-foreground mt-2 text-[11px]">生成于 {dateLabel(stringValue(manifest.generated_at))}</p>
                </div>
              ) : <EmptyText>发送消息后，这里会显示本轮实际参考的内容。</EmptyText>}
            </ContextSection>

            {operations.length > 0 && (
              <ContextSection title="正在处理" icon={<Clock3Icon />}>
                {operations.map((entry, index) => {
                  const item = objectValue(entry);
                  return <ContextItem key={stringValue(item.operation_id) ?? index} title={stringValue(item.user_message) ?? "正在处理学习任务"} meta={stringValue(item.status) ?? "运行中"} />;
                })}
              </ContextSection>
            )}

            <Link to="/learning" className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline">
              查看全部学习记录
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

function ContextSection({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs font-medium [&_svg]:size-3.5">{icon}{title}</h3>
      <div className="grid gap-2">{children}</div>
    </section>
  );
}

function ContextItem({ title, meta }: { title: string; meta: string }) {
  return <div className="rounded-xl border p-3"><p className="line-clamp-4 text-sm leading-5">{title}</p><p className="text-muted-foreground mt-1 text-xs">{meta}</p></div>;
}

function EmptyText({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground rounded-xl border border-dashed p-3 text-xs leading-5">{children}</p>;
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

function dateLabel(value: string | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function questionStatus(value: string | undefined): string {
  const labels: Record<string, string> = { active: "作答中", finalizing: "正在判定", closed: "已结束" };
  return value ? labels[value] ?? value : "当前题";
}
