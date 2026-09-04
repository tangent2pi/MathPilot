"use client";

// 「自我测评」居中模态：检测进行中轮次 → 选章/选点(1-3)/定难度 → 逐题作答
// → 判定反馈 → 完成汇总报告（报告由后端追加为当前对话的 assistant 消息）。
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronRightIcon,
  FlagIcon,
  Loader2Icon,
  PlusIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FC,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";

import { SelfTestMarkdown } from "@/components/assistant-ui/self-test/SelfTestMarkdown";
import { ReportDetail } from "@/components/assistant-ui/self-test/SelfTestReportView";
import { Button } from "@/components/ui/button";
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { learningKeys } from "@/learning/data/client";
import {
  SelfTestApiError,
  selfTestApi,
  type KnowledgePoint,
  type KnowledgeTreeView,
  type ReportPayload,
  type SelfTestProgress,
  type RunView,
  type SelfTestQuestion,
  type SubmitAnswerResult,
} from "@/learning/data/selfTestClient";
import { useLearningThreadId } from "@/learning/runtime/LearningThreadContext";
import { cn } from "@/lib/utils";

type View =
  | { kind: "loading" }
  | { kind: "pick" }
  | { kind: "answer"; run: RunView }
  | { kind: "report"; run?: RunView; report: string; payload?: ReportPayload };

interface LastJudgment {
  verdict: "correct" | "incorrect";
  expected: string[];
  analysis?: string;
  autoAudited?: boolean;
  questionRevisionId: string;
  questionEntityId: string;
  response: string;
}

const QUICK_DIFFICULTIES = [
  { key: "low", label: "基础", description: "概念起步题为主" },
  { key: "medium", label: "中等", description: "常规题型为主" },
  { key: "high", label: "挑战", description: "综合与变式为主" },
] as const;

export const SelfTestDialog: FC<{ onClose?: () => void }> = ({ onClose }) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const threadId = useLearningThreadId();
  const [view, setView] = useState<View>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "info"; text: string } | null>(null);
  const [last, setLast] = useState<LastJudgment | null>(null);
  const [progress, setProgress] = useState<SelfTestProgress | null>(null);
  const [latestReport, setLatestReport] = useState<{ report: string; payload?: ReportPayload; round_no: number } | null>(null);

  const refreshThreads = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: learningKeys.all });
  }, [queryClient]);

  // 打开即探测进行中的轮（续测入口 / 单例提示）+ 轮进度（决定第 2 轮起是否锁选题）
  // + 最近整章报告（是否有可重开的报告详情）
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [{ run }, prog] = threadId
          ? await Promise.all([selfTestApi.currentRun(), selfTestApi.progress(threadId)])
          : [await selfTestApi.currentRun(), null];
        if (!alive) return;
        setProgress(prog);
        if (threadId) {
          selfTestApi.latestReport(threadId)
            .then((lr) => {
              if (alive) setLatestReport({ report: lr.report, payload: lr.report_payload, round_no: lr.round_no });
            })
            .catch(() => { if (alive) setLatestReport(null); }); // 404 等：无报告
        }
        setView(
          run && run.status === "active"
            ? { kind: "answer", run }
            : { kind: "pick" },
        );
      } catch (error) {
        if (!alive) return;
        setMessage({ tone: "error", text: errorMessage(error) });
        setView({ kind: "pick" });
      }
    })();
    return () => { alive = false; };
  }, [threadId]);

  const openLatestReport = useCallback(() => {
    if (!latestReport) return;
    setView({
      kind: "report",
      report: latestReport.report,
      payload: latestReport.payload,
    });
  }, [latestReport]);

  const startRun = useCallback(async (selection: {
    knowledge_ids: string[];
    chapter_name: string;
    quick?: "low" | "medium" | "high";
    difficulty_1_5?: number;
    goal_score?: number;
    daily_minutes?: number;
  }) => {
    setBusy(true);
    setMessage(null);
    try {
      const created = await selfTestApi.createRun({ thread_id: threadId, ...selection });
      if (created.thread_id && created.thread_id !== threadId) {
        navigate(`/c/${encodeURIComponent(created.thread_id)}`, { replace: true });
      }
      setView({ kind: "answer", run: created.run });
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }, [navigate, threadId]);

  const submitAnswer = useCallback(async (response: string) => {
    const current = view.kind === "answer" ? view.run : null;
    if (!current?.question || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await selfTestApi.submitAnswer(current.runId, { response });
      setLast({
        verdict: result.verdict,
        expected: result.expected,
        analysis: result.analysis,
        autoAudited: result.autoAudited,
        questionRevisionId: current.question.questionRevisionId,
        questionEntityId: current.question.questionEntityId,
        response,
      });
      if (result.run.status === "finished") {
        refreshThreads();
        setView({ kind: "report", run: result.run, report: result.report ?? fallbackReport(result), payload: result.report_payload });
      } else {
        setView({ kind: "answer", run: result.run });
      }
    } catch (error) {
      // 该轮已被服务端判为结束（题库抽尽自动完结 / 其它入口已 finish）：
      // 不给用户留卡死红框，提示后回到选题页即可重开。
      if (error instanceof SelfTestApiError && error.code === "run_not_active") {
        setMessage({ tone: "info", text: "本轮测评已结束，报告已写入对话消息流；可重新选题开始新一轮。" });
        setLast(null);
        setView({ kind: "pick" });
      } else {
        setMessage({ tone: "error", text: errorMessage(error) });
      }
    } finally {
      setBusy(false);
    }
  }, [busy, refreshThreads, view]);

  // 回到「选章节/知识点/难度」。若在 answer 放弃当前轮，先静默结束该轮
  // （归档 + 报告入消息流），否则单例锁会让新一轮建不起来。
  const resetToPick = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const current = view.kind === "answer" ? view.run : null;
      if (current && current.status === "active") {
        try {
          await selfTestApi.finishRun(current.runId);
          refreshThreads();
        } catch {
          // 该轮已被别处结束（finish 409 等）——忽略即可继续重选
        }
      }
      if (threadId) {
        try { setProgress(await selfTestApi.progress(threadId)); } catch { /* 保持旧值 */ }
      }
    } finally {
      setLast(null);
      setView({ kind: "pick" });
      setBusy(false);
    }
  }, [refreshThreads, threadId, view]);

  const finishEarly = useCallback(async (runId: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await selfTestApi.finishRun(runId);
      refreshThreads();
      setView({ kind: "report", run: result.run, report: result.report, payload: result.report_payload });
    } catch (error) {
      if (error instanceof SelfTestApiError && error.code === "run_not_active") {
        setMessage({ tone: "info", text: "该轮测评已结束，报告已在前面对话中生成；可重新选题开始新一轮。" });
        setLast(null);
        setView({ kind: "pick" });
      } else {
        setMessage({ tone: "error", text: errorMessage(error) });
      }
    } finally {
      setBusy(false);
    }
  }, [refreshThreads]);

  const reportSuspect = useCallback(async () => {
    if (!last) return;
    setBusy(true);
    try {
      await selfTestApi.reportSuspect({
        question_revision_id: last.questionRevisionId,
        question_entity_id: last.questionEntityId,
        response: last.response,
        context: { source: "student_flag" },
      });
      setMessage({ tone: "info", text: "已上报：该题将进入题库勘误队列，由教师人工复核。" });
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }, [last]);

  return (
    <DialogContent className="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>自我测评</DialogTitle>
        <DialogDescription>
          选择题 / 填空题自动判答，掌握度按 BKT 逐题更新，结束出复习报告。
        </DialogDescription>
      </DialogHeader>

      {message && (
        <div
          role="alert"
          className={cn(
            "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
            message.tone === "error"
              ? "border-destructive/30 bg-destructive/5 text-destructive"
              : "border-border bg-muted/50 text-foreground",
          )}
        >
          {message.tone === "error"
            ? <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
            : <CheckIcon className="mt-0.5 size-4 shrink-0" />}
          <span className="min-w-0 flex-1 break-words">{message.text}</span>
        </div>
      )}

      {view.kind === "loading" && (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
          正在读取测评状态…
        </div>
      )}

      {view.kind === "pick" && (
        <PickStep
          busy={busy}
          progress={progress}
          latestReport={latestReport}
          onStart={startRun}
          onOpenReport={openLatestReport}
        />
      )}

      {view.kind === "answer" && (
        <AnswerStep
          run={view.run}
          busy={busy}
          last={last}
          onSubmit={submitAnswer}
          onFinish={() => finishEarly(view.run.runId)}
          onSuspect={reportSuspect}
          onRestart={resetToPick}
        />
      )}

      {view.kind === "report" && (
        <ReportStep
          run={view.run}
          report={view.report}
          payload={view.payload}
          onRestart={resetToPick}
          onClose={onClose}
        />
      )}
    </DialogContent>
  );
};

// ---------------------------------------------------------------------------
// 选点 / 定难度（第 1 轮自选；第 2 轮起系统自动选题 + 目标/时长 carry-over）
// ---------------------------------------------------------------------------
const PickStep: FC<{
  busy: boolean;
  progress: SelfTestProgress | null;
  latestReport: { report: string; payload?: ReportPayload; round_no: number } | null;
  onStart: (selection: {
    knowledge_ids: string[];
    chapter_name: string;
    quick?: "low" | "medium" | "high";
    difficulty_1_5?: number;
    goal_score?: number;
    daily_minutes?: number;
  }) => void;
  onOpenReport: () => void;
}> = ({ busy, progress, latestReport, onStart, onOpenReport }) => {
  const [tree, setTree] = useState<KnowledgeTreeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chapterName, setChapterName] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [quick, setQuick] = useState<"low" | "medium" | "high">("medium");
  const [scale, setScale] = useState<number | null>(null);
  const [goal, setGoal] = useState<string>(progress?.goal_score != null ? String(progress.goal_score) : "");
  const [minutes, setMinutes] = useState<string>(progress?.daily_minutes != null ? String(progress.daily_minutes) : "");

  const nextRound = progress?.next_round_no ?? 1;
  const autoSelect = nextRound >= 2; // 第 2 轮起系统自动选题

  // 第 2 轮起 carry-over：回填/锁定第 1 轮录入的目标分与每天时长
  useEffect(() => {
    if (progress?.goal_score != null && Number(goal) !== progress.goal_score) setGoal(String(progress.goal_score));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress?.goal_score]);
  useEffect(() => {
    if (progress?.daily_minutes != null && Number(minutes) !== progress.daily_minutes) setMinutes(String(progress.daily_minutes));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress?.daily_minutes]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const view = await selfTestApi.knowledgeTree();
        if (!alive) return;
        setTree(view);
        if (view.chapters.length > 0) setChapterName(view.chapters[0]?.chapterName ?? null);
      } catch (caught) {
        if (alive) setError(errorMessage(caught));
      }
    })();
    return () => { alive = false; };
  }, []);

  const chapter = useMemo(
    () => tree?.chapters.find((item) => item.chapterName === chapterName) ?? null,
    [chapterName, tree],
  );
  const points = useMemo(
    () => (chapter?.modules ?? []).flatMap((module) => module.knowledgePoints),
    [chapter],
  );
  const firstDrawable = useMemo(
    () => points.find((point) => point.drawable > 0) ?? null,
    [points],
  );

  // 默认勾选第一个可抽知识点（规格：默认 1 个）
  useEffect(() => {
    if (selected.length === 0 && firstDrawable) setSelected([firstDrawable.knowledgeId]);
  }, [firstDrawable, selected.length]);

  const togglePoint = (knowledgeId: string) => {
    setSelected((current) => {
      if (current.includes(knowledgeId)) return current.filter((id) => id !== knowledgeId);
      if (current.length >= 3) return current; // 上限 3
      return [...current, knowledgeId];
    });
  };

  const goalNum = Number(goal);
  const minutesNum = Number(minutes);
  const goalValid = Number.isFinite(goalNum) && goalNum >= 0 && goalNum <= 100;
  const minutesValid = Number.isFinite(minutesNum) && minutesNum >= 1 && minutesNum <= 600;
  const canStart = goalValid && minutesValid && !busy && (autoSelect || (selected.length >= 1 && selected.length <= 3));

  const isLocked = autoSelect;

  return (
    <div className="flex flex-col gap-4 overflow-y-auto">
      {error && <InlineError text={error} />}

      {!tree && !error && (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
          正在加载题库…
        </div>
      )}

      {tree && tree.chapters.length === 0 && (
        <div className="py-6 text-center text-sm text-muted-foreground">
          当前还没有可抽取的选择题 / 填空题，请稍后再来。
        </div>
      )}

      {tree && tree.chapters.length > 0 && (
        <>
          {/* 查看最近整章报告入口 */}
          {latestReport && (
            <button
              type="button"
              onClick={onOpenReport}
              className="flex w-full items-center gap-2 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2.5 text-left text-sm transition-colors hover:bg-primary/10"
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
                <FlagIcon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">查看前 {latestReport.round_no} 轮的整章测评汇总报告</span>
                <span className="text-muted-foreground text-xs">含六维画像、知识点掌握表格与学习计划</span>
              </span>
              <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
            </button>
          )}

          {/* 轮次提示 */}
          <div className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-foreground">
            <FlagIcon className="size-4 shrink-0 text-primary" />
            <span>
              第 {nextRound} 轮测评
              {isLocked
                ? progress
                  ? ` —— 本轮由系统自动选取，优先补测剩余 ${progress.untested_count}/${progress.total_points} 个未测知识点。`
                  : " —— 本轮由系统自动选取「未测 / 薄弱」知识点，无需手动选题。"
                : "（共 ≥3 轮，第 3 轮出具整章测评报告）"}
            </span>
          </div>

          {/* 目标分 / 每天投入时长 —— 强制填写 */}
          <Field label="① 目标分（0–100，整章测评要达到的目标）">
            <Input
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              inputMode="numeric"
              placeholder="如 80"
              disabled={busy || isLocked}
              aria-invalid={goal.length > 0 && !goalValid}
              className={cn(isLocked && "opacity-80")}
            />
            {isLocked && goal && (
              <span className="text-muted-foreground text-xs">沿用第 1 轮设置</span>
            )}
          </Field>

          <Field label="② 每天可投入时长（分钟）">
            <Input
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              inputMode="numeric"
              placeholder="如 40"
              disabled={busy || isLocked}
              aria-invalid={minutes.length > 0 && !minutesValid}
              className={cn(isLocked && "opacity-80")}
            />
            {isLocked && minutes && (
              <span className="text-muted-foreground text-xs">沿用第 1 轮设置</span>
            )}
          </Field>

          {!isLocked && (
            <>
              {/* 章节 */}
              <Field label="③ 选择章节">
                <div className="flex flex-wrap gap-1.5">
                  {tree.chapters.map((item) => (
                    <button
                      key={item.chapterName}
                      type="button"
                      onClick={() => setChapterName(item.chapterName)}
                      className={cn(
                        "rounded-full border px-3 py-1 text-sm transition-colors",
                        chapterName === item.chapterName
                          ? "border-primary/40 bg-primary/10 text-primary font-medium"
                          : "hover:bg-muted border-transparent text-muted-foreground",
                      )}
                    >
                      {item.chapterName}
                    </button>
                  ))}
                </div>
              </Field>

              {/* 知识点（1-3 个） */}
              <Field label={`④ 选择知识点（${selected.length}/3，每题只测所选点）`}>
                <div className="flex flex-wrap gap-1.5">
                  {points.map((point) => (
                    <KnowledgeChip
                      key={point.knowledgeId}
                      point={point}
                      checked={selected.includes(point.knowledgeId)}
                      disabled={busy || (!selected.includes(point.knowledgeId) && selected.length >= 3)}
                      onToggle={() => togglePoint(point.knowledgeId)}
                    />
                  ))}
                  {points.length === 0 && (
                    <span className="text-sm text-muted-foreground">该章节暂无可抽知识点。</span>
                  )}
                </div>
              </Field>

              {/* 难度 */}
              <Field label="⑤ 起点难度">
                <div className="flex items-center gap-1.5">
                  {QUICK_DIFFICULTIES.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      title={item.description}
                      onClick={() => { setQuick(item.key); setScale(null); }}
                      className={cn(
                        "rounded-lg border px-3 py-1.5 text-sm transition-colors",
                        quick === item.key && scale === null
                          ? "border-primary/40 bg-primary/10 text-primary font-medium"
                          : "hover:bg-muted border-transparent text-muted-foreground",
                      )}
                    >
                      {item.label}
                    </button>
                  ))}
                  <span className="text-muted-foreground mx-1.5 text-xs">或微调</span>
                  <div className="flex items-center gap-1">
                    {[1, 2, 3, 4, 5].map((level) => (
                      <button
                        key={level}
                        type="button"
                        aria-label={`难度 ${level}`}
                        onClick={() => { setScale(level); setQuick("medium"); }}
                        className={cn(
                          "size-7 rounded-md border text-xs transition-colors",
                          scale === level
                            ? "border-primary/40 bg-primary/10 text-primary font-semibold"
                            : "hover:bg-muted border-transparent text-muted-foreground",
                        )}
                      >
                        {level}
                      </button>
                    ))}
                  </div>
                  <span className="text-muted-foreground text-xs">1 最易 · 5 最难</span>
                </div>
              </Field>
            </>
          )}

          <DialogFooter className="pt-1">
            <Button
              disabled={!canStart}
              onClick={() => {
                if (!chapter || goalNum === null || minutesNum === null) return;
                const chapter_name = chapter.chapterName;
                const base: {
                  knowledge_ids: string[];
                  chapter_name: string;
                  goal_score: number;
                  daily_minutes: number;
                } = {
                  knowledge_ids: autoSelect ? [] : selected,
                  chapter_name,
                  goal_score: goalNum,
                  daily_minutes: minutesNum,
                };
                if (!autoSelect) {
                  if (scale !== null) {
                    onStart({ ...base, difficulty_1_5: scale });
                  } else {
                    onStart({ ...base, quick });
                  }
                } else {
                  onStart(base);
                }
              }}
            >
              {busy ? (
                <><Loader2Icon className="size-4 animate-spin" /> 正在开始…</>
              ) : (
                <><ChevronRightIcon className="size-4" /> {autoSelect ? "开始下一轮" : "开始测评"}</>
              )}
            </Button>
          </DialogFooter>
        </>
      )}
    </div>
  );
};

const KnowledgeChip: FC<{
  point: KnowledgePoint;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}> = ({ point, checked, disabled, onToggle }) => {
  const formats = useMemo(() => {
    const hasChoice = point.formats.includes("single_choice");
    const hasBlank = point.formats.includes("fill_blank");
    return [hasChoice ? "选择" : null, hasBlank ? "填空" : null]
      .filter(Boolean).join("·") || "题";
  }, [point.formats]);
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={checked}
      className={cn(
        "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        checked
          ? "border-primary/50 bg-primary/10 text-primary font-medium"
          : "hover:bg-muted border-border/60 text-foreground",
      )}
    >
      {checked
        ? <CheckIcon className="size-3.5 shrink-0" />
        : <PlusIcon className="size-3.5 shrink-0" />}
      <span>{point.name}</span>
      <span className="text-muted-foreground text-xs">
        {point.drawable} 题 · {formats}
      </span>
    </button>
  );
};

// ---------------------------------------------------------------------------
// 逐题作答
// ---------------------------------------------------------------------------
const AnswerStep: FC<{
  run: RunView;
  busy: boolean;
  last: LastJudgment | null;
  onSubmit: (response: string) => void;
  onFinish: () => void;
  onSuspect: () => void;
  onRestart: () => void;
}> = ({ run, busy, last, onSubmit, onFinish, onSuspect, onRestart }) => {
  const question = run.question;
  const dimensionName = useMemo(() => {
    const id = question?.knowledgeIds[0];
    if (!id) return null;
    return run.dimensions.find((dim) => dim.knowledgeId === id)?.name ?? null;
  }, [question, run.dimensions]);

  return (
    <div className="flex flex-col gap-3 overflow-y-auto">
      {last && question && (
        <JudgmentBanner last={last} onSuspect={onSuspect} busy={busy} />
      )}

      {!question ? (
        <div className="py-6 text-center text-sm text-muted-foreground">
          本轮题目已出完，点击下方按钮查看报告。
          <div className="mt-3 flex items-center justify-center gap-2">
            <Button variant="outline" onClick={onRestart} disabled={busy}>
              <RotateCcwIcon className="size-3.5" /> 重新选题
            </Button>
            <Button onClick={onFinish} disabled={busy}>查看报告</Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground text-xs">
              第 {question.index}/{run.questionCap} 题 · 已答 {run.answeredTotal} 题
              {dimensionName ? ` · ${dimensionName}` : ""}
            </span>
            <span className="text-muted-foreground text-xs">
              当前难度：{difficultyLabel(question.difficulty)}
            </span>
          </div>
          <QuestionPanel
            key={question.questionRevisionId}
            question={question}
            busy={busy}
            onSubmit={onSubmit}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={onRestart} disabled={busy}>
              <RotateCcwIcon className="size-3.5" /> 重新选题
            </Button>
            <Button variant="outline" onClick={onFinish} disabled={busy}>
              提前结束并出报告
            </Button>
          </DialogFooter>
        </>
      )}
    </div>
  );
};

const JudgmentBanner: FC<{
  last: LastJudgment;
  busy: boolean;
  onSuspect: () => void;
}> = ({ last, busy, onSuspect }) => {
  const correct = last.verdict === "correct";
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border px-3 py-2 text-sm",
        correct
          ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
          : "border-rose-500/30 bg-rose-500/5 text-rose-700 dark:text-rose-300",
      )}
    >
      <div className="flex items-center gap-2 font-medium">
        {correct ? <CheckIcon className="size-4" /> : <XIcon className="size-4" />}
        {correct ? "回答正确" : "回答错误"}
        {last.autoAudited && (
          <span className="text-muted-foreground text-xs font-normal">
            已自动上报题库勘误
          </span>
        )}
      </div>
      {!correct && last.expected.length > 0 && (
        <div className="text-muted-foreground">
          参考答案：<span className="font-medium text-foreground">{last.expected.join(" 或 ")}</span>
        </div>
      )}
      {!correct && last.analysis && (
        <SelfTestMarkdown text={last.analysis} />
      )}
      {!correct && (
        <button
          type="button"
          disabled={busy}
          onClick={onSuspect}
          className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1 text-xs underline-offset-2 hover:underline disabled:opacity-50"
        >
          <FlagIcon className="size-3" />
          我认为题库答案有误，提交勘误
        </button>
      )}
    </div>
  );
};

const QuestionPanel: FC<{
  question: SelfTestQuestion;
  busy: boolean;
  onSubmit: (response: string) => void;
}> = ({ question, busy, onSubmit }) => {
  const [answer, setAnswer] = useState("");
  const isChoice = question.stemFormat === "single_choice";

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl border p-3.5">
        <SelfTestMarkdown text={question.stemMarkdown} />
      </div>

      {isChoice ? (
        <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="选项">
          {question.options.map((option) => {
            const active = answer === option.key;
            return (
              <button
                key={option.key}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={busy}
                onClick={() => setAnswer(option.key)}
                className={cn(
                  "flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                  active
                    ? "border-primary/60 bg-primary/8 text-foreground"
                    : "hover:bg-muted border-border/70",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-xs font-medium",
                    active
                      ? "border-primary/60 bg-primary/10 text-primary"
                      : "border-border text-muted-foreground",
                  )}
                >
                  {option.key}
                </span>
                <SelfTestMarkdown text={option.text} />
              </button>
            );
          })}
        </div>
      ) : (
        <Input
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && answer.trim() && !busy) onSubmit(answer.trim());
          }}
          placeholder="输入答案（如：√2 / 60° / 3）"
          disabled={busy}
          aria-label="答案输入"
        />
      )}

      <DialogFooter>
        <Button
          disabled={!answer.trim() || busy}
          onClick={() => onSubmit(isChoice ? answer : answer.trim())}
        >
          {busy ? (
            <><Loader2Icon className="size-4 animate-spin" /> 判定中…</>
          ) : (
            "提交答案"
          )}
        </Button>
      </DialogFooter>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 汇总报告
// ---------------------------------------------------------------------------
const ReportStep: FC<{
  run?: RunView;
  report: string;
  payload?: ReportPayload;
  onRestart: () => void;
  onClose?: () => void;
}> = ({ run, report, payload, onRestart, onClose }) => {
  const answeredTotal = run?.answeredTotal ?? (payload ? payload.points.reduce((s, p) => s + p.answered, 0) : 0);
  const roundNo = run?.roundNo ?? payload?.round_no ?? 3;
  const [tab, setTab] = useState<"overview" | "detail">(payload ? "overview" : "overview");
  return (
    <div className="flex max-h-[52dvh] flex-col gap-3 overflow-y-auto">
      <div className="flex flex-wrap gap-1 rounded-lg border bg-muted/30 px-2 py-1 text-xs">
        <button
          type="button"
          onClick={() => setTab("overview")}
          className={cn("rounded-md px-2.5 py-1 transition-colors", tab === "overview" ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:text-foreground")}
        >
          文字摘要
        </button>
        {payload && (
          <button
            type="button"
            onClick={() => setTab("detail")}
            className={cn("rounded-md px-2.5 py-1 transition-colors", tab === "detail" ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:text-foreground")}
          >
            六维画像 / 计划
          </button>
        )}
      </div>

      {tab === "overview" || !payload ? (
        <>
          <div className="rounded-xl border bg-muted/30 px-3.5 py-2.5">
            <SelfTestMarkdown text={report} />
          </div>
          <p className="text-muted-foreground text-xs">
            {answeredTotal > 0
              ? `本轮共作答 ${answeredTotal} 题。报告已写入对话消息流；复习路径按 BKT 掌握度从薄弱到已掌握排序。`
              : "本轮没有作答记录，报告仅供留档。"}
          </p>
        </>
      ) : (
        <ReportDetail payload={payload} />
      )}

      <DialogFooter className="pt-1">
        <Button variant="outline" onClick={onRestart}>
          <RotateCcwIcon className="size-3.5" /> {roundNo < 3 ? "再来一轮" : "继续一轮"}
        </Button>
        {onClose && (
          <Button onClick={onClose}>完成</Button>
        )}
      </DialogFooter>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 小组件
// ---------------------------------------------------------------------------
const Field: FC<{ label: string; children: ReactNode }> = ({ label, children }) => (
  <div className="flex flex-col gap-1.5">
    <span className="text-foreground/80 text-sm font-medium">{label}</span>
    {children}
  </div>
);

const InlineError: FC<{ text: string }> = ({ text }) => (
  <div
    role="alert"
    className="border-destructive/30 bg-destructive/5 text-destructive flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
  >
    <AlertCircleIcon className="size-4 shrink-0" />
    <span className="min-w-0 flex-1 break-words">{text}</span>
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={() => window.location.reload()}
      aria-label="重试"
    >
      <RotateCcwIcon className="size-4" />
    </Button>
  </div>
);

function fallbackReport(result: SubmitAnswerResult): string {
  return `## 自我测评报告\n\n本轮共作答 ${result.run.answeredTotal} 题。`;
}

function difficultyLabel(difficulty: number): string {
  if (difficulty <= 0.33) return "基础";
  if (difficulty >= 0.67) return "挑战";
  return "中等";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
