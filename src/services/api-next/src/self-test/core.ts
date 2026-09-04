// self-test 域：纯函数核心（BKT / 状态判定 / 分层抽题计划）。
// 判定口径与产品 bkt-oatutor-prior-v1 + scientific-core 同构：
//   prior=0.30, slip=0.10, guess=0.20, learn=0.0（τ=0 不叠加转移）
//   更新 = 论文式(8)(9)(10)：答对 P←P(1-s)/[P(1-s)+(1-P)g]；答错 P←Ps/[Ps+(1-P)(1-g)]
//   结果 Math.round(p*1000)/1000
//   阈值 { minimum_independent_count:2, weak:0.4, learning:0.8, mastered:0.95 }
//   mastered 需要 p>=0.95 且存在迁移证据（换题型后答对）
export const BKT_PARAMETERS = { prior: 0.3, slip: 0.1, guess: 0.2 } as const;

export const STATE_THRESHOLDS = {
  minimumIndependentCount: 2,
  weak: 0.4,
  learning: 0.8,
  mastered: 0.95,
} as const;

export type MasteryState =
  | "insufficient_evidence"
  | "weak"
  | "learning"
  | "possibly_mastered"
  | "mastered";

export function bktUpdate(prior: number, correct: boolean): number {
  const { slip, guess } = BKT_PARAMETERS;
  let next: number;
  if (correct) {
    const numerator = prior * (1 - slip);
    const denominator = prior * (1 - slip) + (1 - prior) * guess;
    next = denominator === 0 ? 0 : numerator / denominator;
  } else {
    const numerator = prior * slip;
    const denominator = prior * slip + (1 - prior) * (1 - guess);
    next = denominator === 0 ? 0 : numerator / denominator;
  }
  return Math.round(next * 1000) / 1000;
}

export interface DimensionObservation {
  dimensionId: string;
  correct: boolean;
  format: string;
}

/** 迁移证据口径（self-test 自洽版）：同一知识点维度内，换题型（与上一次作答题型不同）后答对 +1。 */
export function replayDimension(observations: readonly DimensionObservation[], dimensionId: string) {
  let p: number = BKT_PARAMETERS.prior;
  let independentCount = 0;
  let transferEvidence = 0;
  let lastFormat: string | null = null;
  for (const obs of observations) {
    if (obs.dimensionId !== dimensionId) continue;
    independentCount += 1;
    if (obs.correct) {
      if (lastFormat !== null && lastFormat !== obs.format) transferEvidence += 1;
      lastFormat = obs.format;
    }
    p = bktUpdate(p, obs.correct);
  }
  return {
    p,
    independentCount,
    transferEvidence,
    state: masteryState(p, independentCount, transferEvidence),
  };
}

export function masteryState(p: number, independentCount: number, transferEvidence: number): MasteryState {
  const { minimumIndependentCount, weak, learning, mastered } = STATE_THRESHOLDS;
  if (independentCount < minimumIndependentCount) return "insufficient_evidence";
  if (p < weak) return "weak";
  if (p < learning) return "learning";
  if (p < mastered) return "possibly_mastered";
  return transferEvidence > 0 ? "mastered" : "possibly_mastered";
}

export const STATE_LABEL: Record<MasteryState, string> = {
  insufficient_evidence: "证据不足",
  weak: "薄弱",
  learning: "学习中",
  possibly_mastered: "可能掌握",
  mastered: "已掌握",
};

// ---------------------------------------------------------------------------
// v2 分层出题：一轮 15 题，按知识点二级模块（入门/进阶/综合）× 难度双层配额。
// ---------------------------------------------------------------------------

/** 目标模块层（对应知识点 description 第二段：入门题型/进阶题型/综合应用）。 */
export type ModuleBucket = "entry" | "advance" | "synthesis";

export const BUCKET_LABEL: Record<ModuleBucket, string> = {
  entry: "入门",
  advance: "进阶",
  synthesis: "综合",
};

/** 二级模块名（description 第二段）→ 目标模块层。未知/空回退入门。 */
export function moduleToBucket(moduleName: string | null | undefined): ModuleBucket {
  const m = moduleName ?? "";
  if (m.includes("进阶")) return "advance";
  if (m.includes("综合")) return "synthesis";
  return "entry";
}

/** DB difficulty（0–1）→ 1–5 档。 */
export function difficultyTo1to5(difficulty01: number): number {
  const n = Math.round(difficulty01 * 5);
  return Math.min(5, Math.max(1, n));
}

/** 一个待抽题位：指定目标模块层 + 难度档（1–5）。 */
export interface QuestionSlot {
  bucket: ModuleBucket;
  difficulty1to5: number;
}

/**
 * 一轮 15 题分层配额（难度从低到高爬升）：
 *   入门 8 = 难1×3 + 难2×3 + 难3×2
 *   进阶 5 = 难3×2 + 难4×3
 *   综合 2 = 难5×2
 * 合计难度分布 3/3/4/3/2。
 */
export const ROUND_PLAN: QuestionSlot[] = [
  { bucket: "entry", difficulty1to5: 1 },
  { bucket: "entry", difficulty1to5: 1 },
  { bucket: "entry", difficulty1to5: 1 },
  { bucket: "entry", difficulty1to5: 2 },
  { bucket: "entry", difficulty1to5: 2 },
  { bucket: "entry", difficulty1to5: 2 },
  { bucket: "entry", difficulty1to5: 3 },
  { bucket: "entry", difficulty1to5: 3 },
  { bucket: "advance", difficulty1to5: 3 },
  { bucket: "advance", difficulty1to5: 3 },
  { bucket: "advance", difficulty1to5: 4 },
  { bucket: "advance", difficulty1to5: 4 },
  { bucket: "advance", difficulty1to5: 4 },
  { bucket: "synthesis", difficulty1to5: 5 },
  { bucket: "synthesis", difficulty1to5: 5 },
];

export const ROUND_SIZE = ROUND_PLAN.length; // 15

/** 单知识点每轮最多命中的题数：防止重点点垄断整层、饿死同层其余点。 */
export const MAX_Q_PER_DIM = 3;

// ---------------------------------------------------------------------------
// 一轮测评的运行状态机（分层抽题）
// ---------------------------------------------------------------------------

export interface DimensionRuntime {
  answered: number;
  correct: number;
  transfer: number;
  lastFormat: string | null;
}

export interface RuntimeState {
  /** 本轮抽题计划（默认 ROUND_PLAN，15 题位，有序）。 */
  plan: QuestionSlot[];
  /** 已答过的题 revision，抽题时排除。 */
  usedRevisions: string[];
  /** 每个知识点已命中的题数（本轮配额控制，防重点点垄断整层）。 */
  dimServed: Record<string, number>;
  /** 已答题数（= 下一个题位的索引）。 */
  answeredTotal: number;
  /** 每个知识点维度的答题统计（BKT 重放用）。 */
  perDim: Record<string, DimensionRuntime>;
}

export function initialRuntime(plan: QuestionSlot[] = ROUND_PLAN): RuntimeState {
  return {
    plan: [...plan],
    usedRevisions: [],
    dimServed: {},
    answeredTotal: 0,
    perDim: {},
  };
}

/** 当前待抽题位（answeredTotal 即下一个题位的下标）。 */
export function currentSlot(runtime: RuntimeState): QuestionSlot | null {
  return runtime.plan[runtime.answeredTotal] ?? null;
}

export type RoundStepResult =
  | { kind: "continue"; nextSlot: QuestionSlot }
  | { kind: "finished"; reason: "question_cap" };

/**
 * 应用一次作答：记录维度统计 → 推进题位。
 * 分层配额是固定计划，不再做答对升档/答错降档的自适应；
 * 抽到 15 题上限即结束。下一题位交给 service 层按「分层优先 + 重点点填充」从 DB 抽。
 */
export function applyAnswerStep(
  runtime: RuntimeState,
  event: { dimensionId: string; correct: boolean; format: string },
): RoundStepResult {
  const dim = (runtime.perDim[event.dimensionId] ??= {
    answered: 0, correct: 0, transfer: 0, lastFormat: null,
  });
  dim.answered += 1;
  if (event.correct) dim.correct += 1;
  if (event.correct && dim.lastFormat !== null && dim.lastFormat !== event.format) dim.transfer += 1;
  dim.lastFormat = event.format;
  runtime.answeredTotal += 1;

  if (runtime.answeredTotal >= runtime.plan.length) {
    return { kind: "finished", reason: "question_cap" };
  }
  return { kind: "continue", nextSlot: runtime.plan[runtime.answeredTotal]! };
}
