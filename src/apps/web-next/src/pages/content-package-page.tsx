"use client";

import { ArrowLeftIcon, BookOpenCheckIcon, LoaderCircleIcon, SendIcon, Undo2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/auth";
import { contentApi, type ContentPackageDetail } from "@/lib/content-api";
import { responseJson } from "@/lib/http-problem";

type Classroom = { class_id: string; name: string; student_count?: number };

export function ContentPackagePage({ packageId }: { packageId: string }) {
  const { principal, loading, requireAuth } = useAuth();
  const [detail, setDetail] = useState<ContentPackageDetail>();
  const [classes, setClasses] = useState<Classroom[]>([]);
  const [error, setError] = useState("");
  const [busyClass, setBusyClass] = useState<string>();
  const isTeacher = principal?.roles.includes("teacher") ?? false;

  const load = useCallback(async (signal?: AbortSignal) => {
    setError("");
    try {
      const [packageValue, classValue] = await Promise.all([
        contentApi<ContentPackageDetail>(`/packages/${encodeURIComponent(packageId)}`, { signal }),
        isTeacher ? fetch("/api/classes", { credentials: "include", signal }).then(async (response) => {
          const body = await responseJson<{ classes?: Classroom[] }>(response, "无法读取班级");
          return body.classes ?? [];
        }) : Promise.resolve([]),
      ]);
      setDetail(packageValue); setClasses(classValue);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : "无法读取内容包");
    }
  }, [isTeacher, packageId]);

  useEffect(() => {
    if (!principal) return;
    const controller = new AbortController(); void load(controller.signal);
    return () => controller.abort();
  }, [load, principal]);

  const activeReleases = useMemo(() => new Set(detail?.releases.filter((release) => !release.withdrawn_at).map((release) => release.class_id)), [detail]);
  const toggleRelease = async (classId: string, released: boolean) => {
    setBusyClass(classId); setError("");
    try {
      await contentApi(`/packages/${encodeURIComponent(packageId)}/releases${released ? `/${encodeURIComponent(classId)}` : ""}`, released
        ? { method: "DELETE" }
        : { method: "POST", body: JSON.stringify({ class_id: classId }) });
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "发布操作失败"); }
    finally { setBusyClass(undefined); }
  };

  if (loading) return <PackageState text="正在读取账户…" busy />;
  if (!principal) return <PackageState text="登录后才能查看内容包。" action={<Button className="min-h-11" onClick={() => requireAuth(undefined, "login")}>登录</Button>} />;
  if (!detail && !error) return <PackageState text="正在加载内容包…" busy />;
  if (!detail) return <PackageState text={error || "内容包不存在"} />;

  return (
    <main className="min-h-dvh bg-muted/25">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3 sm:px-6">
          <Button aria-label="返回首页" className="min-h-11" variant="ghost" onClick={() => window.location.assign("/")}><ArrowLeftIcon aria-hidden="true" />返回</Button>
          <div className="min-w-0"><h1 className="truncate font-semibold">{detail.package.title}</h1><p className="text-xs text-muted-foreground">版本 {detail.package.version_no} · {detail.items.length} 项</p></div>
          <span className="ms-auto rounded-full border bg-card px-2.5 py-1 text-xs font-medium">{detail.package.status === "published" ? "已发布" : "待发布"}</span>
        </div>
      </header>
      <div className="mx-auto grid max-w-5xl gap-5 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <section className="space-y-3" aria-labelledby="package-items-heading">
          <div><h2 id="package-items-heading" className="font-semibold">固定修订</h2><p className="mt-1 text-sm text-muted-foreground">发布始终引用以下修订，后续编辑不会改变本内容包。</p></div>
          {detail.items.map((item) => <article className="flex items-start gap-3 rounded-2xl border bg-card p-4 shadow-sm" key={item.revision_id}><BookOpenCheckIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" /><div className="min-w-0"><div className="font-medium">{item.entity_id}</div><div className="mt-1 text-xs text-muted-foreground">{item.entity_kind} · 修订 {item.revision_no}</div></div></article>)}
        </section>
        {isTeacher && detail.package.origin === "teacher" && (
          <aside className="rounded-2xl border bg-card p-4 shadow-sm lg:sticky lg:top-20 lg:self-start">
            <h2 className="font-semibold">发布到班级</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">只有所选班级中的学生能看到教师内容包。</p>
            <div className="mt-4 space-y-2">
              {classes.length === 0 ? <p className="rounded-xl bg-muted/60 p-3 text-sm text-muted-foreground">请先在账户设置中创建班级。</p> : classes.map((classroom) => {
                const released = activeReleases.has(classroom.class_id);
                return <div className="rounded-xl border p-3" key={classroom.class_id}><div className="font-medium">{classroom.name}</div><p className="mt-1 text-xs text-muted-foreground">{classroom.student_count ?? 0} 名学生</p><Button className="mt-3 min-h-11 w-full" disabled={busyClass === classroom.class_id} variant={released ? "outline" : "default"} onClick={() => void toggleRelease(classroom.class_id, released)}>{released ? <Undo2Icon aria-hidden="true" /> : <SendIcon aria-hidden="true" />}{busyClass === classroom.class_id ? "处理中…" : released ? "撤下" : "发布"}</Button></div>;
              })}
            </div>
            {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}
          </aside>
        )}
      </div>
    </main>
  );
}

function PackageState({ text, busy, action }: { text: string; busy?: boolean; action?: ReactNode }) {
  return <main className="grid min-h-dvh place-items-center bg-muted/25 p-6"><div className="flex max-w-md flex-col items-center gap-4 text-center text-muted-foreground">{busy && <LoaderCircleIcon className="size-6 animate-spin motion-reduce:animate-none" aria-hidden="true" />}<p>{text}</p>{action}<Button className="min-h-11" variant="ghost" onClick={() => window.location.assign("/")}>返回首页</Button></div></main>;
}
