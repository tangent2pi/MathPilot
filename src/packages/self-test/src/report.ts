// self-test 域：终版报告 + 轮小结生成（#31）。
// 数据由 service 注入（跨 run 聚合后的 answers + 配置 + 知识树），本模块为纯函数，
// 输出两级叙事：聊天 markdown + 结构化 payload（供前端渲染雷达/学习计划等）。
import {
  replayDimension,
  STATE_THRESHOLDS, BKT_PARAMETERS,
  type MasteryState,
} from "./core.ts";
import type { KnowledgePointRow } from "./content.ts";

// ---------------------------------------------------------------------------
// 输入契约（service 构造）
// ---------------------------------------------------------------------------

export interface ActivityAnswer {
  independent?: boolean;
  runId: string;
  roundNo: number;
  sequence: number;
  questionRevisionId: string;
  dimensionId: string;
  stemFormat: string;
  responseText: string;
  verdict: "correct" | "incorrect";
  difficultyServed: number;
}

export interface ActivityRun {
  runId: string;
  roundNo: number;
  status: string;
  config: {
    knowledge_ids: string[];
    chapter_name?: string;
    goal_score?: number;
    daily_minutes?: number;
    selected_by?: "user" | "system";
  };
}

export interface ReportContext {
  /** 一次"整章测评活动"内全部 finished run（含本轮），按 round_no 升序。 */
  runs: ActivityRun[];
  /** 该活动全部作答，按 (run.created_at, sequence) 升序。 */
  answers: ActivityAnswer[];
  /** 最新知识树（含可抽点 / 未测点由调用方计算）。 */
  tree: KnowledgePointRow[];
  /** 知识树点总数（覆盖广度分母）。 */
  totalPoints: number;
  /** 目标分（0–100，可选；未填则目标差距维显示"—"）。 */
  goalScore?: number;
  /** 每天投入分钟（可选，学习计划题量用）。 */
  dailyMinutes?: number;
}

// ---------------------------------------------------------------------------
// 工具：BKT 掌握度 / 分档
// ---------------------------------------------------------------------------

export interface RecognizedPoint {
  id: string;
  name: string;
  moduleName: string | null;
  answered: number;
  correct: number;
  pMastery: number;
  state: MasteryState;
  transferEvidence: number;
  goalDiff: number | null; // 目标分 − 当前 pMastery*100
}

const stateLabelZh: Record<MasteryState, string> = {
  mastered: "已掌握",
  possibly_mastered: "可能掌握",
  learning: "学习中",
  weak: "薄弱",
  insufficient_evidence: "证据不足",
};

const stateFlag: Record<MasteryState, string> = {
  mastered: "✅", possibly_mastered: "🟢", learning: "🔵", weak: "⚠️", insufficient_evidence: "✦",
};

/** 证据充分性：independentCount<2 视为待复测。 */
function evidenceSufficient(p: RecognizedPoint): boolean {
  return p.answered >= STATE_THRESHOLDS.minimumIndependentCount;
}

/** 按 (run.createdAt, sequence) 升序 稳定排序。 */
function sortAnswers(answers: ActivityAnswer[], runs: ActivityRun[]): ActivityAnswer[] {
  const idx = new Map(runs.map((r, i) => [r.runId, i]));
  return [...answers].sort((a, b) => {
    const ra = idx.get(a.runId) ?? 0, rb = idx.get(b.runId) ?? 0;
    if (ra !== rb) return ra - rb;
    return a.sequence - b.sequence;
  });
}

/** 聚合测过点：对所有出现过的 dimension，按 BKT 重放口径。 */
export function computePoints(ctx: ReportContext): RecognizedPoint[] {
  const globalObs = sortAnswers(ctx.answers, ctx.runs).filter((answer) => answer.independent !== false);
  const map = new Map<string, { id: string; correct: number; answered: number }>();
  for (const ans of globalObs) {
    const rec = map.get(ans.dimensionId) ?? { id: ans.dimensionId, correct: 0, answered: 0 };
    rec.answered += 1;
    if (ans.verdict === "correct") rec.correct += 1;
    map.set(ans.dimensionId, rec);
  }
  const treeById = new Map(ctx.tree.map((row) => [row.knowledgeId, row]));
  const goal = ctx.goalScore;
  const points: RecognizedPoint[] = [];
  for (const rec of map.values()) {
    const replay = replayDimension(
      globalObs.map((a) => ({ dimensionId: a.dimensionId, correct: a.verdict === "correct", format: a.stemFormat })),
      rec.id,
    );
    const node = treeById.get(rec.id);
    points.push({
      id: rec.id,
      name: node?.name ?? rec.id,
      moduleName: node?.moduleName ?? null,
      answered: rec.answered,
      correct: rec.correct,
      pMastery: replay.p,
      state: replay.state,
      transferEvidence: replay.transferEvidence,
      goalDiff: goal === undefined ? null : Math.round((goal - replay.p * 100) * 10) / 10,
    });
  }
  return points;
}

// ---------------------------------------------------------------------------
// 整章掌握度 / 六维 / 风险分
// ---------------------------------------------------------------------------

/** 整章掌握度 = 测过点 BKT p 按题量加权平均（0–1）。 */
export function chapterMastery(points: RecognizedPoint[]): number | null {
  const measured = points.filter((p) => p.answered > 0);
  if (!measured.length) return null;
  const total = measured.reduce((s, p) => s + p.answered, 0);
  return measured.reduce((s, p) => s + p.pMastery * p.answered, 0) / total;
}

/** 判定依据（设计 §6.1：加权 p + 阈值）。 */
export function masteryVerdict(mastery: number | null): "mastered" | "developing" | "insufficient" {
  if (mastery === null) return "insufficient";
  if (mastery >= 0.8) return "mastered";
  return "developing";
}

/** 覆盖广度 = 已测点数 / totalPoints。 */
export function coverage(points: RecognizedPoint[], totalPoints: number): number {
  if (!totalPoints) return 0;
  return points.filter((p) => p.answered > 0).length / totalPoints;
}

/** 薄弱集中度 = weak 点占已测点比例（设计 §6.2）。 */
export function weaknessConcentration(points: RecognizedPoint[]): number {
  const measured = points.filter((p) => p.answered > 0);
  if (!measured.length) return 0;
  return measured.filter((p) => p.state === "weak").length / measured.length;
}

/** 多轮趋势：末轮掌握度 − 首轮（>0 上升 / <0 下降）。 */
export function multiRoundTrend(_runs: ActivityRun[], masteryByRound: number[]): number {
  if (masteryByRound.length < 2) return 0;
  return masteryByRound[masteryByRound.length - 1]! - masteryByRound[0]!;
}

/** 目标差距 = 目标分 − 当前掌握度（0–100 分制，<0 则已达目标）。 */
export function goalGap(goal: number | undefined, mastery: number | null): number | null {
  if (goal === undefined || mastery === null) return null;
  return Math.round((goal - mastery * 100) * 10) / 10;
}

/** 风险分 = 薄弱集中度×0.5 + (1−覆盖广度)×0.3 + 近期下降趋势×0.2（设计 §6.3）。 */
export function riskScore(points: RecognizedPoint[], totalPoints: number, trend: number): number {
  const c = coverage(points, totalPoints);
  const w = weaknessConcentration(points);
  const fl = Math.max(0, -trend); // 仅下降不利
  return Math.min(1, Math.max(0, w * 0.5 + (1 - c) * 0.3 + fl * 0.2));
}

export function riskLabel(score: number): "高" | "中" | "低" {
  if (score >= 0.7) return "高";
  if (score >= 0.45) return "中";
  return "低";
}

// ---------------------------------------------------------------------------
// 学习计划
// ---------------------------------------------------------------------------

export interface LearningWeek {
  week: number;
  theme: string;
  dailyTasks: string[];
  passLine: string;
}

/** 周数 = 目标差距分档（设计 §6.4：差距 → 1–4 周）。 */
export function planWeeks(goalDiff: number | null, mastery: number | null): number {
  if (goalDiff === null) return 2; // 未填目标给保守默认
  if (goalDiff <= 10) return 1;
  if (goalDiff <= 25) return 2;
  if (goalDiff <= 40) return 3;
  return 4;
}

/** 每天题量：min(15, ceil(40 / minutes) * 3)，大致 40 分钟 ≈ 20 题节奏。 */
export function dailyQuestionTarget(dailyMinutes: number | undefined): number {
  if (!dailyMinutes) return 6;
  return Math.max(3, Math.min(15, Math.round((dailyMinutes / 40) * 20)));
}

/** 1–4 周计划：按差距分档周数；前置知识点优先排序；每天由 dailyMinutes 定题量。 */
export function buildLearningPlan(
  points: RecognizedPoint[],
  ctx: { goalScore?: number; dailyMinutes?: number },
): LearningWeek[] {
  const measured = points.filter((p) => p.answered > 0);
  const mastery = chapterMastery(points);
  const goalDiff = goalGap(ctx.goalScore, mastery);
  const weeks = planWeeks(goalDiff, mastery);
  const perDay = dailyQuestionTarget(ctx.dailyMinutes);

  // 排序：薄弱在前，其次学习/可能掌握；证据不足忽略
  const order: Record<MasteryState, number> = { weak: 0, learning: 1, possibly_mastered: 2, insufficient_evidence: 3, mastered: 4 };
  const focus = measured
    .filter((p) => p.id && p.state !== "mastered")
    .sort((a, b) => order[a.state] - order[b.state] || a.pMastery - b.pMastery)
    .slice(0, Math.min(measured.length, 4));

  const themes = [
    "基础清算：回归薄弱点概念与公式",
    "限时突破：薄弱点针对性刷题",
    "综合应用：跨知识点整合训练",
    "临考冲刺：限时套卷 + 查漏补缺",
  ];

  const plans: LearningWeek[] = [];
  for (let w = 1; w <= weeks; w++) {
    const weekPoints = focus.slice(0, 1 + ((w - 1) % Math.max(1, focus.length)));
    const names = weekPoints.map((p) => p.name).join("、") || "保持当前掌握度";
    plans.push({
      week: w,
      theme: `${themes[w - 1] ?? themes[themes.length - 1]}`,
      dailyTasks: [
        `每日完成 ${perDay} 道题（重点：${names}）`,
        w === 1 ? "先复习相关知识点公式与例题，再动手练习" : `按周主题整理错题，重做上周薄弱题`,
      ],
      passLine: `周末重测目标点掌握度 ≥ ${Math.round(STATE_THRESHOLDS.learning * 100)}%（巩固达标）`,
    });
  }
  return plans;
}

// ---------------------------------------------------------------------------
// 轮小结（round 1–2）
// ---------------------------------------------------------------------------

export function roundSummaryLines(ctx: ReportContext): string[] {
  const points = computePoints(ctx);
  const mastery = chapterMastery(points);
  const weakest = [...points].sort((a, b) => a.pMastery - b.pMastery)[0];
  const mText = mastery === null
    ? "本轮暂无足够作答"
    : `本轮章节掌握度约 ${Math.round(mastery * 100)}%`;
  const wText = weakest && weakest.answered > 0
    ? `本薄弱点：${weakest.name}（${stateLabelZh[weakest.state]}）`
    : "暂无明显薄弱点，继续巩固";
  // 趋势：与上一轮掌握度比较（ctx.runs 含当前轮）
  const roundMasteries = ctx.runs.map((run) => {
    const runAnswers = ctx.answers.filter((a) => a.runId === run.runId);
    return chapterMastery(computePoints({ ...ctx, runs: ctx.runs, answers: runAnswers }));
  }).filter((m): m is number => m !== null);
  const direction = roundMasteries.length >= 2 && roundMasteries[roundMasteries.length - 1]! >= roundMasteries[roundMasteries.length - 2]!
    ? "保持/上升" : "略有波动";
  return [
    `${mText}，较上一轮${direction}。`,
    `${wText}。`,
  ];
}

// ---------------------------------------------------------------------------
// 终版报告
// ---------------------------------------------------------------------------

export interface FinalReportPayload {
  chapter: { chapterName: string; mastery: number | null; verdict: string; risk: string; riskScore: number; weakest: string | null; coveragePct: number; weaknessPct: number; goalScore?: number; gap?: number | null; rounds: number; totalAnswered: number; totalPoints: number };
  round_no: number;
  radar: { dimension: string; score: number | null }[]; // 六维(0–100 或 null)
  points: ({ id: string; name: string; state: MasteryState; pMastery: number; answered: number; tested: boolean })[];
  risks: string[];
  plan: LearningWeek[];
  trend: { round: number; mastery: number | null }[];
}

export interface FinalReport {
  markdown: string;
  payload: FinalReportPayload;
}

/** 构建终版报告：输入已含本轮 finished run 的聚合视图。 */
export function buildFinalReport(ctx: ReportContext): FinalReport {
  const measured = ctx.answers.length > 0;
  const points = computePoints(ctx);
  const mastery = chapterMastery(points);
  const verdict = masteryVerdict(mastery);
  const coverageRatio = coverage(points, ctx.totalPoints);
  const weakness = weaknessConcentration(points);
  const trend = multiRoundTrend(ctx.runs, ctx.runs.map((r) => {
    const runAnswers = ctx.answers.filter((a) => a.runId === r.runId);
    const runPoints = computePoints({ ...ctx, runs: ctx.runs, answers: runAnswers });
    return chapterMastery(runPoints) ?? 0;
  }));
  const risk = riskScore(points, ctx.totalPoints, trend);
  const riskL = riskLabel(risk);
  const gap = goalGap(ctx.goalScore, mastery);
  const weakest = [...points].sort((a, b) => a.pMastery - b.pMastery)[0] ?? null;

  // 六维（0–100）
  const radar: FinalReportPayload["radar"] = [
    { dimension: "章节掌握度", score: mastery === null ? null : Math.round(mastery * 100) },
    { dimension: "覆盖广度", score: Math.round(coverageRatio * 100) },
    { dimension: "薄弱集中度", score: Math.round((1 - weakness) * 100) }, // 反向：越低越代表集中
    { dimension: "多轮趋势", score: Math.round((0.5 + trend) * 100) },
    { dimension: "目标差距", score: gap === null ? null : Math.max(0, Math.round(100 - gap)) },
    { dimension: "证据充分性", score: measured ? Math.min(100, Math.round((points.filter((p) => evidenceSufficient(p)).length / Math.max(1, points.length)) * 100)) : 0 },
  ];

  const riskHits: string[] = [];
  if (weakness >= 0.7) riskHits.push("高危：薄弱点集中度过高");
  else if (weakness >= 0.4) riskHits.push("中危：存在成片薄弱点");
  if (coverageRatio < 0.3) riskHits.push(`中危：覆盖广度不足（${Math.round(coverageRatio * 100)}%）`);
  if (riskL === "高") riskHits.push("高危：需优先干预");
  if (riskLabel(risk) === "中" && !riskHits.length) riskHits.push("中危：存在一定知识缺口");

  const plan = buildLearningPlan(points, {
    ...(ctx.goalScore !== undefined ? { goalScore: ctx.goalScore } : {}),
    ...(ctx.dailyMinutes !== undefined ? { dailyMinutes: ctx.dailyMinutes } : {}),
  });

  // markdown
  const lines: string[] = [];
  const chapterName = ctx.runs[0]?.config.chapter_name ?? "解三角形";
  const measuredCount = points.filter((p) => p.answered > 0).length;
  const totalAnswered = points.reduce((s, p) => s + p.answered, 0);
  const covPct = Math.round(coverageRatio * 100);
  const gapText = gap === null
    ? "未设置目标分，暂不评估差距"
    : gap > 0
      ? `仍差 ${gap} 分（目标 ${ctx.goalScore} 分 − 当前掌握度 ${Math.round((mastery ?? 0) * 100)}%）`
      : `已达目标（当前 ${Math.round((mastery ?? 0) * 100)}% ≥ 目标 ${ctx.goalScore} 分）`;
  const trendText = ctx.runs.length >= 2
    ? (() => {
        const delta = trend;
        return Math.abs(delta) < 0.02
          ? "基本持平"
          : delta > 0 ? `上升 ${Math.round(Math.abs(delta) * 100)}%` : `下降 ${Math.round(Math.abs(delta) * 100)}%`;
      })()
    : "仅一轮，暂无趋势";

  lines.push(`## ${chapterName}整章测评报告（汇总前 ${ctx.runs.length} 轮）`);
  lines.push(`**测评活动**：${chapterName} · 已累计 ${ctx.runs.length} 轮测评，共作答 ${totalAnswered} 题，覆盖 ${measuredCount}/${ctx.totalPoints} 个知识点`);
  lines.push("");
  lines.push("**📊 核心指标**");
  lines.push(`- **整章掌握度**：${mastery === null ? "—（证据不足）" : `${Math.round(mastery * 100)}%`} · 判定：${verdict === "mastered" ? "已掌握" : verdict === "developing" ? "待巩固" : "证据不足"}`);
  lines.push(`- **知识覆盖广度**：${covPct}%（已测 ${measuredCount} / 知识点总数 ${ctx.totalPoints}）`);
  lines.push(`- **薄弱集中度**：${Math.round(weakness * 100)}%（已测点中薄弱占比）`);
  lines.push(`- **多轮趋势**：${trendText}`);
  lines.push(`- **风险等级**：${riskL}（风险分 ${Math.round(risk * 100)}）`);
  lines.push(`- **最弱项**：${weakest && weakest.answered > 0 ? `${weakest.name}（掌握度 ${weakest.pMastery.toFixed(2)}）` : "暂无明确薄弱点"}`);
  lines.push(`- **目标差距**：${gapText}`);
  lines.push("");
  lines.push("> **目标差距怎么算**：目标差距 = 你设置的目标分 − 当前整章掌握度 × 100。例：目标 80 分、当前掌握度 6.1%，则还差 80 − 6.1 ≈ 73.9 分。差距越大，下方学习计划周数越长。");
  lines.push("");

  lines.push("### 知识点掌握情况");
  const ranked = [...points].sort((a, b) => a.pMastery - b.pMastery);
  if (ranked.length) {
    lines.push("| 知识点 | 掌握度 | 作答 | 状态 |");
    lines.push("| --- | --- | --- | --- |");
    for (const p of ranked) {
      const stateZh = `${stateLabelZh[p.state]}` + (evidenceSufficient(p) ? "" : " · 待复测");
      lines.push(`| ${p.name} | ${p.pMastery.toFixed(2)} | 答 ${p.answered}（对 ${p.correct}） | ${stateFlag[p.state]} ${stateZh} |`);
    }
  } else {
    lines.push("本轮没有任何已测知识点作答记录，建议重新开启测评。");
  }
  lines.push("");
  lines.push("### 学习计划");
lines.push(`按目标差距（${gap === null ? "未设置目标" : `${gap > 0 ? `还差 ${gap} 分` : "已达标"}`}）生成 **${plan.length} 周**计划，每日约 ${plan[0]?.dailyTasks[0]?.match(/每日完成 (\d+) 道题/)?.[1] ?? "—"} 道题。`);
lines.push("");
  for (const w of plan) {
    lines.push(`**第${w.week}周 · ${w.theme}**`);
    lines.push(`1. **本周重点知识点**：${w.dailyTasks[0]!.replace(/^每日完成 \d+ 道题（重点：|）$/, "") || "保持当前掌握度"}`);
    lines.push(`2. **每日训练**：${w.dailyTasks[0]!}`);
    lines.push(`3. **复习巩固**：${w.dailyTasks[1]!}`);
    lines.push(`4. **阶段检验**：${w.passLine}`);
    lines.push("");
  }

  lines.push("> 掌握度根据逐题作答情况动态更新；风险分 = 薄弱集中度×0.5 + (1−覆盖广度)×0.3 + 近期下降×0.2。");
  lines.push("> 如需继续检测更多知识点，可点击“继续一轮”，历史作答将持续累积更新本报告。");

  // payload 供前端渲染
  const payload: FinalReportPayload = {
    chapter: {
      chapterName,
      mastery,
      verdict: verdict === "mastered" ? "mastered" : verdict === "developing" ? "developing" : "insufficient",
      risk: riskL,
      riskScore: Math.round(risk * 100),
      weakest: weakest && weakest.answered > 0 ? weakest.name : null,
      coveragePct: Math.round(coverageRatio * 100),
      weaknessPct: Math.round(weakness * 100),
      ...(ctx.goalScore !== undefined ? { goalScore: ctx.goalScore } : {}),
      ...(ctx.goalScore !== undefined ? { gap } : {}),
      rounds: ctx.runs.length,
      totalAnswered,
      totalPoints: ctx.totalPoints,
    },
    round_no: Math.max(...ctx.runs.map((r) => r.roundNo), 3),
    radar,
    points: ranked.map((p) => ({
      id: p.id, name: p.name, state: p.state, pMastery: p.pMastery, answered: p.answered, tested: p.answered > 0,
    })),
    risks: riskHits,
    plan,
    trend: ctx.runs.map((r) => {
      const runAnswers = ctx.answers.filter((a) => a.runId === r.runId);
      const runMastery = chapterMastery(computePoints({ ...ctx, runs: ctx.runs, answers: runAnswers }));
      return { round: r.roundNo, mastery: runMastery };
    }),
  };

  return { markdown: lines.join("\n"), payload };
}

// 导出未使用项给外部可能引用（防止 tree-shake 混淆）
export { BKT_PARAMETERS, STATE_THRESHOLDS };
