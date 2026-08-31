"use client";

import renderMathInElement from "katex/contrib/auto-render";
import "katex/dist/katex.min.css";
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  ClipboardCheckIcon,
  LightbulbIcon,
  MemoryStickIcon,
  SkipForwardIcon,
  SparklesIcon,
} from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CommandCapability, DomainUIPart } from "../contracts";
import { learningApi, learningKeys } from "../data/client";

const mathOptions = {
  delimiters: [
    { left: "$$", right: "$$", display: true },
    { left: "\\[", right: "\\]", display: true },
    { left: "\\(", right: "\\)", display: false },
    { left: "$", right: "$", display: false },
  ],
  ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "option"],
  throwOnError: false,
  strict: "warn" as const,
  trust: false,
};

export function DomainMessagePart({ name, data }: { name: string; data: unknown }) {
  if (name === "mathpilot-domain-ui" && isDomainUIPart(data)) {
    return data.view_kind === "question" ? <QuestionCard part={data} /> : <DomainReceiptCard part={data} />;
  }
  if (name === "mathpilot-teaching-artifact" && data && typeof data === "object") {
    const artifact = data as { summary?: unknown; artifact_ref?: unknown };
    return (
      <section className="bg-card my-3 rounded-2xl border p-4 shadow-sm">
        <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium"><SparklesIcon className="size-4" />教学材料</div>
        <p className="mt-2 text-sm leading-6">{typeof artifact.summary === "string" ? artifact.summary : "已生成一份经过校验的教学材料。"}</p>
        {typeof artifact.artifact_ref === "string" && <p className="text-muted-foreground mt-2 font-mono text-xs">{artifact.artifact_ref}</p>}
      </section>
    );
  }
  return null;
}

function isDomainUIPart(value: unknown): value is DomainUIPart {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DomainUIPart>;
  return candidate.schema === "mathpilot.message-part/domain-ui/v1"
    && typeof candidate.part_id === "string"
    && typeof candidate.view_kind === "string"
    && Boolean(candidate.snapshot && typeof candidate.snapshot === "object");
}

function MathContent({ children, className }: { children: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) renderMathInElement(ref.current, mathOptions);
  }, [children]);
  return <div ref={ref} className={className}>{children}</div>;
}

type QuestionOption = { id: string; text: string };

function QuestionCard({ part }: { part: DomainUIPart }) {
  const queryClient = useQueryClient();
  const [selectedOptions, setSelectedOptions] = useState<string[]>([]);
  const [answer, setAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const data = part.snapshot.data;
  const sessionId = stringValue(data.question_session_id) ?? part.resource_ref.replace(/^question-session:/, "");
  const interactionUrl = `/api/learning/question-sessions/${encodeURIComponent(sessionId)}`;
  const interaction = useQuery({
    queryKey: learningKeys.view(interactionUrl),
    queryFn: () => learningApi.view<{
      question_session?: { status?: string; version?: number };
      submitted_attempt_ref?: string;
      commands?: CommandCapability[];
    }>(interactionUrl),
    retry: 1,
  });
  const prompt = stringValue(data.stem_markdown) ?? part.snapshot.summary;
  const format = stringValue(data.stem_format) ?? "short_answer";
  const multiple = format === "multiple_choice";
  const options = useMemo(() => optionValues(data.options), [data.options]);
  const response = options.length > 0
    ? selectedOptions.map((id) => `${id}. ${options.find((option) => option.id === id)?.text ?? ""}`).join("；")
    : answer.trim();
  const commands = interaction.data?.data.commands ?? interaction.data?.command_capabilities ?? [];
  const submitCommand = commands.find((command) => command.action === "submit_attempt");
  const cutCommand = commands.find((command) => command.action === "request_cut");
  const alreadySubmitted = submitted || Boolean(interaction.data?.data.submitted_attempt_ref)
    || (interaction.data?.data.question_session?.status !== undefined && interaction.data.data.question_session.status !== "open");
  const canSubmit = Boolean(submitCommand) && !alreadySubmitted;
  const canSkip = Boolean(cutCommand) && part.action_slots.includes("skip_question") && !alreadySubmitted;

  const runCommand = async (kind: "submit" | "skip") => {
    setSubmitting(true);
    setError("");
    try {
      if (kind === "submit") {
        await learningApi.command(
          submitCommand!.href,
          submitCommand!.expected_version,
          { attempt_kind: "answer", response_parts: [{ type: "text", text: response }] },
          "attempt",
        );
      } else {
        await learningApi.command(
          cutCommand!.href,
          cutCommand!.expected_version,
          { reason: "skipped" },
          "skip",
        );
      }
      setSubmitted(true);
      await queryClient.invalidateQueries({ queryKey: learningKeys.all });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "提交失败，请重试");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section id={`question-${sessionId}`} className="bg-card my-3 w-full overflow-hidden rounded-2xl border shadow-sm" aria-label="正式题目">
      <header className="border-b px-4 py-3">
        <div className="text-muted-foreground flex items-center justify-between gap-3 text-xs font-medium">
          <span>正式练习</span>
          <span>{formatLabel(format)}</span>
        </div>
        <MathContent className="mt-2 text-[15px] leading-7 font-medium whitespace-pre-wrap">{prompt}</MathContent>
      </header>
      <div className="space-y-3 p-4">
        {options.length > 0 ? (
          <div className="grid gap-2">
            {options.map((option, index) => {
              const checked = selectedOptions.includes(option.id);
              return (
                <label
                  key={option.id}
                  className={cn(
                    "flex w-full cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 text-start transition-colors",
                    checked ? "border-primary bg-primary/5" : "hover:bg-muted/60",
                    (!canSubmit || submitting) && "cursor-default opacity-65",
                  )}
                >
                  <input
                    type={multiple ? "checkbox" : "radio"}
                    name={`question-${sessionId}`}
                    value={option.id}
                    checked={checked}
                    disabled={!canSubmit || submitting}
                    onChange={() => setSelectedOptions((current) => multiple
                      ? current.includes(option.id) ? current.filter((id) => id !== option.id) : [...current, option.id]
                      : [option.id])}
                    className="border-input text-primary focus-visible:ring-ring mt-1 size-4 shrink-0 accent-current focus-visible:ring-2"
                  />
                  <span className="text-muted-foreground mt-0.5 text-xs font-medium">{String.fromCharCode(65 + index)}</span>
                  <MathContent className="min-w-0 flex-1 text-sm leading-6">{option.text}</MathContent>
                </label>
              );
            })}
          </div>
        ) : (
          <textarea
            rows={4}
            disabled={!canSubmit || submitting}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder="写下你的答案与思路"
            className="border-input bg-background placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 min-h-24 w-full resize-y rounded-xl border px-3 py-2 text-sm outline-none focus-visible:ring-[3px] disabled:opacity-60"
          />
        )}
        <footer className="flex flex-wrap items-center gap-2">
          {canSubmit && (
            <Button size="sm" disabled={!response || submitting} onClick={() => void runCommand("submit")}>
              <ClipboardCheckIcon />{submitting ? "正在提交…" : "提交回答"}
            </Button>
          )}
          {canSkip && (
            <Button size="sm" variant="ghost" disabled={submitting} onClick={() => void runCommand("skip")}>
              <SkipForwardIcon />跳过本题
            </Button>
          )}
          {submitted && <span className="text-muted-foreground text-xs">已提交，状态将自动更新</span>}
        </footer>
        {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
        <p className="text-muted-foreground border-t pt-3 text-xs">
          {stringValue(data.measurement_eligibility) === "formal"
            ? "独立作答且判定可靠时，可形成正式学习证据。"
            : "本题用于教学；是否形成正式证据由服务端规则决定。"}
        </p>
      </div>
    </section>
  );
}

function DomainReceiptCard({ part }: { part: DomainUIPart }) {
  const meta = receiptMeta(part.view_kind);
  const Icon = meta.icon;
  return (
    <section className={cn("bg-card my-3 rounded-2xl border p-4 shadow-sm", meta.className)}>
      <div className="flex items-start gap-3">
        <span className="bg-muted mt-0.5 grid size-8 shrink-0 place-items-center rounded-full"><Icon className="size-4" /></span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{part.snapshot.title || meta.label}</h3>
          <p className="text-muted-foreground mt-1 text-sm leading-6">{part.snapshot.summary}</p>
        </div>
      </div>
    </section>
  );
}

function receiptMeta(kind: DomainUIPart["view_kind"]) {
  switch (kind) {
    case "answer_receipt": return { label: "回答已接收", icon: ClipboardCheckIcon, className: "" };
    case "judgment": return { label: "判定结果", icon: CheckCircle2Icon, className: "border-primary/25" };
    case "probe": return { label: "补充问题", icon: LightbulbIcon, className: "" };
    case "question_closure": return { label: "本题已结束", icon: CheckCircle2Icon, className: "" };
    case "learning_update": return { label: "学习状态更新", icon: SparklesIcon, className: "" };
    case "memory_update": return { label: "学习记忆更新", icon: MemoryStickIcon, className: "" };
    case "review_due": return { label: "复习提醒", icon: CircleAlertIcon, className: "border-amber-500/30" };
    case "activity_milestone": return { label: "学习里程碑", icon: SparklesIcon, className: "border-primary/25" };
    default: return { label: "学习更新", icon: SparklesIcon, className: "" };
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionValues(value: unknown): QuestionOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const item = candidate as Record<string, unknown>;
    const id = stringValue(item.option_key) ?? stringValue(item.id);
    const text = stringValue(item.option_text) ?? stringValue(item.content);
    return id && text ? [{ id, text }] : [];
  });
}

function formatLabel(format: string): string {
  const labels: Record<string, string> = {
    single_choice: "单选题",
    multiple_choice: "多选题",
    true_false: "判断题",
    fill_blank: "填空题",
    open_solution: "解答题",
    short_answer: "简答题",
  };
  return labels[format] ?? "数学题";
}
