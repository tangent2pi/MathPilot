"use client";

import { AlertCircleIcon, CheckCircle2Icon, ClipboardCheckIcon, ExternalLinkIcon, LoaderCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ContentRespondResult = {
  kind?: "ktq" | "er";
  itemCount?: number;
  candidate_set_id?: string;
  candidateSetId?: string;
};

export function ContentReviewCard({
  args,
  result,
  running,
  failed,
}: {
  args: { result_file?: string; validation_file?: string };
  result?: ContentRespondResult;
  running: boolean;
  failed: boolean;
}) {
  const kind = result?.kind === "er" ? "ER" : "KTQ";
  const candidateSetId = result?.candidate_set_id ?? result?.candidateSetId;
  const count = typeof result?.itemCount === "number" ? result.itemCount : undefined;

  return (
    <section className="w-full max-w-md rounded-2xl border border-border/70 bg-card p-4 shadow-sm" aria-live="polite">
      <div className="flex items-start gap-3">
        <span className={cn("mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl", running ? "bg-primary/10 text-primary" : failed ? "bg-destructive/10 text-destructive" : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400")}>
          {running ? <LoaderCircleIcon className="size-4 animate-spin motion-reduce:animate-none" /> : failed ? <AlertCircleIcon className="size-4" /> : <CheckCircle2Icon className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{running ? "正在验证内容候选" : failed ? `${kind} 候选校验未通过` : `${kind} 候选已验证`}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {running ? "宿主正在核对文件、哈希与结构。" : failed ? "请根据工具错误修正结果文件和校验回执后重新提交。" : `${count === undefined ? "候选结果" : `${count} 项候选`} 已通过校验，等待内容服务登记。`}
          </p>
        </div>
      </div>
      {!running && !failed && candidateSetId ? (
        <Button
          className="mt-4 w-full justify-between"
          variant="outline"
          onClick={() => { window.location.assign(`/content/review/${encodeURIComponent(candidateSetId)}`); }}
        >
          打开复核工作台
          <ExternalLinkIcon className="size-3.5" />
        </Button>
      ) : !running && !failed ? (
        <div className="mt-3 flex items-center gap-2 rounded-xl bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          <ClipboardCheckIcon className="size-3.5 shrink-0" />
          结果已保存在当前线程；候选集登记后可从此处打开复核工作台。
        </div>
      ) : null}
      <p className="mt-3 truncate font-mono text-[11px] text-muted-foreground/70" title={args.result_file}>
        {args.result_file ?? "output/result.json"}
      </p>
    </section>
  );
}
