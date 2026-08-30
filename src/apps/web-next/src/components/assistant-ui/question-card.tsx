"use client";

import renderMathInElement from "katex/contrib/auto-render";
import "katex/dist/katex.min.css";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, MessageSquareTextIcon, SkipForwardIcon } from "lucide-react";
import { useAui, useAuiState } from "@assistant-ui/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type CardType = "single_choice" | "multiple_choice" | "fill_blank" | "true_false" | "short_answer";
type CardOption = { id: string; content: string };
type CardBlank = { name: string; expected_format?: "number" | "expression" | "text" };

export type QuestionCardArgs = {
  schema?: string;
  artifact_id?: string;
  card_id?: string;
  type?: CardType;
  prompt?: string;
  options?: CardOption[];
  blanks?: CardBlank[];
  answer_hint?: string;
  response_policy?: {
    required?: boolean;
    allow_skip?: boolean;
    allow_free_text_without_answer?: boolean;
  };
  evidence_policy?: "teaching_only" | "eligible_if_independent";
};

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

function MathContent({ children, className }: { children: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) renderMathInElement(ref.current, mathOptions);
  }, [children]);
  return <div ref={ref} className={className}>{children}</div>;
}

const optionLabel = (index: number) => String.fromCharCode(65 + index);

export function QuestionCard({
  args,
  running,
  toolCallId,
}: {
  args: QuestionCardArgs;
  running: boolean;
  toolCallId: string;
}) {
  const aui = useAui();
  const threadId = useAuiState((state) => state.threadListItem.remoteId);
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [blanks, setBlanks] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  const type = args.type ?? "short_answer";
  const options = useMemo<CardOption[]>(() => {
    if (type === "true_false" && !args.options?.length) {
      return [{ id: "true", content: "正确" }, { id: "false", content: "错误" }];
    }
    return Array.isArray(args.options) ? args.options : [];
  }, [args.options, type]);
  const blankItems = Array.isArray(args.blanks) && args.blanks.length > 0
    ? args.blanks
    : [{ name: "answer", expected_format: "text" as const }];
  const disabled = running || submitted || submitting;

  const answerReady = type === "fill_blank"
    ? blankItems.every((blank) => blanks[blank.name]?.trim())
    : options.length > 0
      ? selected.length > 0
      : text.trim().length > 0;

  const recordAuditEvent = async (
    response: "submitted" | "skipped" | "bypassed_free_text",
    payload: Record<string, unknown>,
  ) => {
    if (!threadId || !args.artifact_id || !args.card_id) {
      throw new Error("题卡仍在同步，请稍后再试。");
    }
    const audit = await fetch(`/api/pi/threads/${encodeURIComponent(threadId)}/card-events`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tool_call_id: toolCallId,
        artifact_id: args.artifact_id,
        card_id: args.card_id,
        response_type: response,
        payload,
      }),
    });
    if (!audit.ok) {
      const problem = await audit.json().catch(() => null) as { error?: unknown } | null;
      throw new Error(typeof problem?.error === "string" ? problem.error : "题卡事件未能写入学习审计");
    }
  };

  const appendResponse = async (response: "submitted" | "skipped") => {
    const cardId = args.card_id ?? "unknown";
    let answer: unknown;
    if (response === "submitted") {
      if (type === "multiple_choice") answer = { multiple: selected };
      else if (type === "single_choice") answer = { single: selected[0] };
      else if (type === "true_false") answer = { true_false: selected[0] };
      else if (type === "fill_blank") answer = { blanks };
      else answer = { text: text.trim() };
    }
    const payload = { schema: "mathpilot.card-response/v1", card_id: cardId, response_type: response, ...(answer ? { answer } : {}) };
    setSubmitting(true);
    setSubmitError("");
    try {
      await recordAuditEvent(response, payload);
      setSubmitted(true);
      const responseText = response === "submitted"
        ? `我提交了题卡 ${cardId} 的回答：\n\n${JSON.stringify(payload, null, 2)}`
        : `我跳过了题卡 ${cardId}，请继续当前教学对话。`;
      await aui.thread.append({
        role: "user",
        content: [{ type: "text", text: responseText }],
      });
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : "提交失败，请重试。");
    } finally {
      setSubmitting(false);
    }
  };

  const useFreeText = async () => {
    const prompt = args.prompt?.trim();
    setSubmitting(true);
    setSubmitError("");
    try {
      await recordAuditEvent("bypassed_free_text", {
        schema: "mathpilot.card-response/v1",
        card_id: args.card_id,
        response_type: "bypassed_free_text",
      });
      setSubmitted(true);
      aui.composer.setText(prompt ? `关于“${prompt}”，我的回答是：` : "我的回答是：");
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : "提交失败，请重试。");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="bg-card my-3 w-full max-w-2xl overflow-hidden rounded-2xl border shadow-sm" aria-label="教学题卡">
      <header className="border-b px-4 py-3">
        <p className="text-muted-foreground text-xs font-medium">{running ? "正在生成题卡…" : "教学互动"}</p>
        <MathContent className="mt-1 text-[15px] leading-7 font-medium whitespace-pre-wrap">
          {args.prompt || "正在准备题目…"}
        </MathContent>
      </header>

      <div className="space-y-3 p-4">
        {options.length > 0 && (
          <div className="grid gap-2">
            {options.map((option, index) => {
              const checked = selected.includes(option.id);
              return (
                <button
                  key={option.id || index}
                  type="button"
                  aria-pressed={checked}
                  disabled={disabled}
                  onClick={() => setSelected((current) => type === "multiple_choice"
                    ? checked ? current.filter((value) => value !== option.id) : [...current, option.id]
                    : [option.id])}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors",
                    checked ? "border-primary bg-primary/5" : "hover:bg-muted/60",
                    disabled && "cursor-default opacity-70",
                  )}
                >
                  <span className={cn("mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border text-[11px]", checked && "border-primary bg-primary text-primary-foreground")}>
                    {checked ? <CheckIcon className="size-3" /> : type === "true_false" ? "" : optionLabel(index)}
                  </span>
                  <MathContent className="min-w-0 flex-1 text-sm leading-6">{option.content}</MathContent>
                </button>
              );
            })}
          </div>
        )}

        {type === "fill_blank" && (
          <div className="grid gap-3 sm:grid-cols-2">
            {blankItems.map((blank) => (
              <label key={blank.name} className="grid gap-1.5 text-sm">
                <span className="text-muted-foreground text-xs">{blank.name}</span>
                <Input
                  disabled={disabled}
                  inputMode={blank.expected_format === "number" ? "decimal" : "text"}
                  value={blanks[blank.name] ?? ""}
                  onChange={(event) => setBlanks((current) => ({ ...current, [blank.name]: event.target.value }))}
                />
              </label>
            ))}
          </div>
        )}

        {type === "short_answer" && (
          <textarea
            rows={4}
            disabled={disabled}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={args.answer_hint || "写下你的思路或答案"}
            className="border-input bg-background placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 min-h-24 w-full resize-y rounded-xl border px-3 py-2 text-sm outline-none focus-visible:ring-[3px] disabled:opacity-60"
          />
        )}

        <footer className="flex flex-wrap items-center gap-2 pt-1">
          <Button type="button" size="sm" disabled={disabled || !answerReady} onClick={() => void appendResponse("submitted")}>
            <CheckIcon />{submitting ? "正在提交…" : "提交回答"}
          </Button>
          {args.response_policy?.allow_skip !== false && (
            <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => void appendResponse("skipped")}>
              <SkipForwardIcon />跳过
            </Button>
          )}
          {args.response_policy?.allow_free_text_without_answer !== false && (
            <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => void useFreeText()}>
              <MessageSquareTextIcon />改用文字回复
            </Button>
          )}
          {submitted && <span role="status" className="text-muted-foreground ml-auto text-xs">已记录到本线程</span>}
        </footer>
        {submitError && <p role="alert" className="text-destructive text-xs">{submitError}</p>}
      </div>
    </section>
  );
}
