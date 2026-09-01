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
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CommandCapability, DomainUIPart } from "../contracts";
import { learningApi, learningKeys } from "../data/client";
import { HttpProblemError } from "../../lib/http-problem";
import { TeachingArtifactMessage } from "./teachingArtifactRegistry";

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
    switch (data.view_kind) {
      case "question": return <QuestionCard part={data} />;
      case "answer_receipt": return <AnswerReceiptCard part={data} />;
      case "judgment": return <JudgmentCard part={data} />;
      case "question_closure": return <QuestionClosureCard part={data} />;
      default: return <DomainUpdateCard part={data} />;
    }
  }
  if (name === "mathpilot-teaching-artifact") return <TeachingArtifactMessage data={data} />;
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
  const canSkip = Boolean(cutCommand) && !alreadySubmitted;
  const canComplete = Boolean(cutCommand) && alreadySubmitted;
  const interactionStatus = interaction.data?.data.question_session?.status;

  const runCommand = async (kind: "submit" | "cut") => {
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
          { reason: alreadySubmitted ? "completed" : "skipped" },
          alreadySubmitted ? "complete-question" : "skip",
        );
      }
      setSubmitted(true);
      await queryClient.invalidateQueries({ queryKey: learningKeys.all });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "提交失败，请重试");
      if (cause instanceof HttpProblemError && cause.status === 409) {
        await queryClient.invalidateQueries({ queryKey: learningKeys.all });
        await interaction.refetch();
      }
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
        {interaction.isPending && (
          <p role="status" className="text-muted-foreground text-xs">正在核对这道题的最新状态…</p>
        )}
        {interaction.error && (
          <div role="alert" className="border-destructive/30 bg-destructive/5 rounded-xl border p-3 text-sm">
            <p className="font-medium">暂时无法核对题目状态</p>
            <p className="text-muted-foreground mt-1 text-xs">{interaction.error.message}</p>
            <Button className="mt-2" size="sm" variant="outline" onClick={() => void interaction.refetch()}>重试</Button>
          </div>
        )}
        {interactionStatus === "finalizing" && (
          <p role="status" className="border-primary/20 bg-primary/5 rounded-xl border p-3 text-xs">回答已经收下，正在形成本题结论。</p>
        )}
        {interactionStatus === "closed" && (
          <p className="text-muted-foreground rounded-xl border p-3 text-xs">本题已经结束，下面保留当时的题目内容供回看。</p>
        )}
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
            <Button size="sm" variant="ghost" disabled={submitting} onClick={() => void runCommand("cut")}>
              <SkipForwardIcon />跳过本题
            </Button>
          )}
          {canComplete && (
            <Button size="sm" variant="outline" disabled={submitting} onClick={() => void runCommand("cut")}>
              <ClipboardCheckIcon />{submitting ? "正在完成…" : "完成本题"}
            </Button>
          )}
          {submitted && canComplete && <span className="text-muted-foreground text-xs">回答已提交，完成本题后进入判定</span>}
        </footer>
        {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
        <SelectionContext data={data} />
        <p className="text-muted-foreground border-t pt-3 text-xs">
          {stringValue(data.measurement_eligibility) === "formal"
            ? "独立作答且判定可靠时，可形成正式学习证据。"
            : "本题用于教学；是否形成正式证据由服务端规则决定。"}
        </p>
      </div>
    </section>
  );
}

function AnswerReceiptCard({ part }: { part: DomainUIPart }) {
  const response = arrayValue(part.snapshot.data.response_parts)
    .map((entry) => stringValue(objectValue(entry).text))
    .filter((entry): entry is string => Boolean(entry))
    .join("\n");
  return (
    <section className="bg-card my-3 rounded-2xl border p-4 shadow-sm" role="status" aria-label="回答提交回执">
      <div className="flex items-start gap-3">
        <span className="bg-muted mt-0.5 grid size-8 shrink-0 place-items-center rounded-full"><ClipboardCheckIcon className="size-4" /></span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{part.snapshot.title || "你的回答"}</h3>
          {response && <MathContent className="mt-1 whitespace-pre-wrap text-sm leading-6">{response}</MathContent>}
          <p className="text-muted-foreground mt-1 text-xs leading-5">已由服务端保存；刷新或换设备后仍会保留。</p>
        </div>
      </div>
    </section>
  );
}

function JudgmentCard({ part }: { part: DomainUIPart }) {
  const data = part.snapshot.data;
  const rubric = arrayValue(data.rubric_results).map(objectValue);
  const judgmentId = stringValue(data.judgment_id) ?? part.resource_ref.replace(/^judgment:/, "");
  const superseded = stringValue(data.superseded_by_judgment_id);
  const correction = stringValue(data.supersedes_judgment_id);
  return (
    <section
      className={cn(
        "bg-card my-3 rounded-2xl border p-4 shadow-sm",
        superseded ? "border-muted-foreground/25 opacity-75" : "border-primary/25",
      )}
      aria-label="判定结果"
    >
      {superseded && <p className="text-muted-foreground mb-2 text-xs font-medium">此结论后来已被更正，请以下方新结论为准。</p>}
      {correction && <p className="text-primary mb-2 text-xs font-medium">教师更正后的结论</p>}
      <div className="flex items-start gap-3">
        <span className="bg-muted mt-0.5 grid size-8 shrink-0 place-items-center rounded-full"><CheckCircle2Icon className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{part.snapshot.title || "判定结果"}</h3>
          <p className="text-muted-foreground mt-1 text-sm leading-6">{part.snapshot.summary}</p>
          {rubric.length > 0 && (
            <ul className="mt-3 grid gap-1.5 text-xs">
              {rubric.map((item, index) => (
                <li key={stringValue(item.rubric_item_id) ?? index} className="flex items-center gap-2">
                  <span aria-hidden="true">{rubricStatusIcon(stringValue(item.status))}</span>
                  <span>评分要点 {index + 1}：{rubricStatusLabel(stringValue(item.status))}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="text-muted-foreground">结论把握：{uncertaintyLabel(stringValue(data.uncertainty))}</span>
            <Link className="text-muted-foreground hover:text-foreground underline-offset-4 hover:underline" to={`/learning/history#judgment-${encodeURIComponent(judgmentId)}`}>查看依据</Link>
          </div>
        </div>
      </div>
    </section>
  );
}

function QuestionClosureCard({ part }: { part: DomainUIPart }) {
  const data = part.snapshot.data;
  const questionSessionId = stringValue(data.question_session_id);
  return (
    <section className="bg-card my-3 rounded-2xl border p-4 shadow-sm" aria-label="本题结束状态">
      <div className="flex items-start gap-3">
        <span className="bg-muted mt-0.5 grid size-8 shrink-0 place-items-center rounded-full"><CheckCircle2Icon className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{part.snapshot.title || "本题已结束"}</h3>
          <p className="text-muted-foreground mt-1 text-sm leading-6">{part.snapshot.summary}</p>
          <p className="text-muted-foreground mt-2 text-xs">{closureStatusLabel(stringValue(data.diagnostic_status))}</p>
          {questionSessionId && <Link className="text-muted-foreground hover:text-foreground mt-2 inline-block text-xs underline-offset-4 hover:underline" to={`/learning/history#question-${encodeURIComponent(questionSessionId)}`}>在学习历史中查看</Link>}
        </div>
      </div>
    </section>
  );
}

function DomainUpdateCard({ part }: { part: DomainUIPart }) {
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

function SelectionContext({ data }: { data: Record<string, unknown> }) {
  const satisfied = arrayValue(data.satisfied_requirements).map(String);
  const compromises = arrayValue(data.unsatisfied_preferences).map(String);
  if (!satisfied.length && !compromises.length) return null;
  return (
    <details className="rounded-xl border px-3 py-2 text-xs">
      <summary className="cursor-pointer font-medium">为什么选择这道题</summary>
      {satisfied.length > 0 && <p className="text-muted-foreground mt-2 leading-5">已满足：{satisfied.join("、")}</p>}
      {compromises.length > 0 && <p className="text-muted-foreground mt-1 leading-5">本次取舍：{compromises.join("、")}</p>}
    </details>
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

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function rubricStatusLabel(value: string | undefined): string {
  return ({ met: "已达到", not_met: "仍需调整", unclear: "证据不足" } as Record<string, string>)[value ?? ""] ?? "待核对";
}

function rubricStatusIcon(value: string | undefined): string {
  return value === "met" ? "✓" : value === "not_met" ? "○" : "?";
}

function uncertaintyLabel(value: string | undefined): string {
  return ({ low: "较明确", medium: "仍有少量不确定", high: "证据不足" } as Record<string, string>)[value ?? ""] ?? "未标注";
}

function closureStatusLabel(value: string | undefined): string {
  return ({
    concluded: "本题已形成可追溯的诊断结论。",
    inconclusive: "现有证据不足，未强行形成诊断结论。",
    skipped: "本题未进入诊断。",
    unclassified: "本题诊断记录仍在整理。",
  } as Record<string, string>)[value ?? ""] ?? "本题事实已保存。";
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
