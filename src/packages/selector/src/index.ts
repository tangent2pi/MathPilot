/**
 * 自适应选题确定性内核（设计 §10 两阶段）。
 *
 * 阶段 A（目标选择）由教学主模型在会话结束时判定（policies/tasks/session-decision.md）；
 * 本包实现阶段 B：硬过滤 + 评分（§10.2 公式）。
 *
 * score = coverage_gain + diagnostic_information_gain + review_urgency
 *       + goal_relevance + prerequisite_value - repetition_cost - fatigue_cost - leakage_risk
 *
 * 诊断模式提高信息增益与覆盖；练习模式把预测正确率控制在可学习区间；
 * 复测模式提高 1-E(R)。辅助模型只在完全并列时裁决，不能绕过硬约束（§10.1）。
 */

export type SelectionGoal =
  | "coverage"        // 新维度覆盖
  | "disambiguation"  // 候选错因消歧
  | "prerequisite"    // 前置知识下探
  | "review"          // 延迟复测
  | "training"        // 当前薄弱项训练
  | "transfer";       // 迁移验证

export type TargetRole = "primary" | "secondary" | "prerequisite";

export interface QuestionCandidate {
  question_id: string;
  tags: string[];
  measurement_dims: string[];
  measurement_targets: { dim: string; role: TargetRole }[];
  /** 有评分点 = 答案可验证（硬过滤项） */
  answer_verifiable: boolean;
  difficulty?: number;
}

export interface MasteryView {
  /** 维度 → 画像掌握度（来自快照/mastery_state） */
  p_profile?: number;
  state?: "insufficient_evidence" | "weak" | "learning" | "possibly_mastered" | "mastered";
  /** 复测到期剩余天数；无估计为 null */
  next_review_due_days: number | null;
}

export interface SelectorContext {
  goal: SelectionGoal;
  candidates: QuestionCandidate[];
  mastery: Record<string, MasteryView>;
  /** 学生已见/已做题（会话进行中与已完成）——硬过滤项 */
  seen: Set<string>;
  /** 自认薄弱维度（画像采集） */
  self_weak: string[];
  /** 消歧目标维度（P1）：本会话错因候选 E 的 related_dims，由会话结束判定写入 run */
  disambiguation_dims?: string[];
  /** 预测正确率目标区间（练习模式） */
  target_success_band?: [number, number];
  p_correct_now?: (dim: string) => number | null;
}

/** 硬过滤（§10.2）：未见、答案可验证、有测量目标；目标相关（无目标维度则保留） */
export function hardFilter(ctx: SelectorContext): QuestionCandidate[] {
  return ctx.candidates.filter((q) => {
    if (ctx.seen.has(q.question_id)) return false;
    if (!q.answer_verifiable) return false;
    if (q.measurement_targets.length === 0) return false;
    return true;
  });
}

/** 目标维度集合（按 goal 解释；P1：disambiguation/transfer 有专门目标维度） */
function goalDims(ctx: SelectorContext): string[] {
  const { goal } = ctx;
  if (goal === "review") {
    return Object.entries(ctx.mastery)
      .filter(([, m]) => m.next_review_due_days !== null && m.next_review_due_days <= 7)
      .map(([dim]) => dim);
  }
  if (goal === "training") return [...new Set([
    ...ctx.self_weak,
    ...Object.entries(ctx.mastery).filter(([, m]) => m.state === "weak" || m.state === "learning").map(([dim]) => dim),
  ])];
  if (goal === "prerequisite") {
    return Object.entries(ctx.mastery)
      .filter(([, m]) => m.state === "insufficient_evidence" || m.p_profile === undefined)
      .map(([dim]) => dim);
  }
  if (goal === "disambiguation") return ctx.disambiguation_dims ?? [];
  if (goal === "transfer") {
    // 迁移验证针对薄弱/学习中维度（§10.1 目标"迁移验证"）
    return Object.entries(ctx.mastery)
      .filter(([, m]) => m.state === "weak" || m.state === "learning")
      .map(([dim]) => dim);
  }
  return []; // coverage：由测量目标与信息增益驱动
}

/** 评分（§10.2）：返回 ≥0 的分数；0 表示无合适题 */
export function scoreCandidate(q: QuestionCandidate, ctx: SelectorContext): number {
  const gdims = goalDims(ctx);
  let score = 0;

  // coverage_gain：目标维度中无掌握记录的 primary 维数
  const uncovered = q.measurement_targets.filter((t) =>
    t.role === "primary" && (ctx.mastery[t.dim]?.p_profile === undefined));
  score += uncovered.length * 2;

  // diagnostic_information_gain：接近 0.5 的维度不确定性最高
  for (const t of q.measurement_targets) {
    const m = ctx.mastery[t.dim];
    if (!m?.p_profile) continue;
    score += (1 - Math.abs(2 * m.p_profile - 1)) * 0.8; // 0.5 → +0.8
  }

  // review_urgency：goal=review 且到期在即
  if (ctx.goal === "review") {
    for (const dim of q.measurement_dims) {
      const due = ctx.mastery[dim]?.next_review_due_days;
      if (due !== null && due !== undefined) score += Math.max(0, 2 - due / 3.5); // 到期越近越高
    }
  }

  // goal_relevance：命中目标维度（目标驱动选择的主导项；覆盖/信息增益只作补充）
  score += q.measurement_dims.filter((d) => gdims.includes(d)).length * 3;

  // prerequisite_value：目标维度含前置角色
  score += q.measurement_targets.filter((t) => t.role === "prerequisite").length * 0.5;

  // 练习模式：预测正确率落在可学习区间（0.4-0.85）
  if (ctx.goal === "training" && ctx.p_correct_now) {
    let best = 0;
    for (const dim of q.measurement_dims) {
      const p = ctx.p_correct_now(dim);
      if (p !== null && p >= 0.4 && p <= 0.85) best = 1;
    }
    score += best * 1.2;
  }

  if (ctx.goal === "training") {
    const difficulty = q.difficulty ?? 0.5;
    // 巩固优先低一档/中低难度；不改编题目，只在已发布同维度题中选择。
    score += difficulty <= 0.6 ? 1.4 : difficulty <= 0.75 ? 0.5 : 0;
  }
  if (ctx.goal === "transfer") score += (q.difficulty ?? 0.5) >= 0.65 ? 1.2 : 0;

  // fatigue_cost / leakage_risk：骨架期取 0（后续按会话内题量/泄露风险接入）
  return score;
}

/** 选择下一题：硬过滤 → 评分 → 最高分；并列时取第一个（确定性；辅助模型裁决在宿主侧）。
 *  零分候选（P1）视为"无合适题"返回 null（避免选中与目标无关的题目）。 */
export function selectNext(ctx: SelectorContext): { question_id: string; score: number } | null {
  const filtered = hardFilter(ctx);
  if (filtered.length === 0) return null;
  let best: { question_id: string; score: number } | null = null;
  for (const q of filtered) {
    const s = scoreCandidate(q, ctx);
    if (s <= 0) continue;
    if (best === null || s > best.score) best = { question_id: q.question_id, score: s };
  }
  return best;
}
