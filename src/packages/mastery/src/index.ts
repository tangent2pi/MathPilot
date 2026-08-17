/**
 * 保守 BKT 内核（设计 §9.2）。
 * 只回答"按已确认逐题观测和固定公式，基准评价是多少"——不产出最终画像。
 * 学习转移 T 不在此处应用（纯诊断 T_resource=0）；资源驱动的转移在 WP-08 落地。
 */

export interface BktParams {
  readonly id: string;
  readonly pL0: number;
  readonly g: number;
  readonly s: number;
  readonly calibration: "prior_only" | "calibrated";
}

/** 首版统一保守先验；S/T 必须在报告标注未校准 */
export const BKT_PRIOR_V1: BktParams = {
  id: "bkt_prior_v1",
  pL0: 0.3,
  g: 0.2,
  s: 0.1,
  calibration: "prior_only",
};

export type BinaryOutcome = "success" | "failure";

export function bktUpdate(prior: number, outcome: BinaryOutcome, params: BktParams = BKT_PRIOR_V1): number {
  const { g, s } = params;
  return outcome === "success"
    ? (prior * (1 - s)) / (prior * (1 - s) + (1 - prior) * g)
    : (prior * s) / (prior * s + (1 - prior) * (1 - g));
}

/** 按时间序重放二值观测（无转移项） */
export function bktReplay(outcomes: readonly BinaryOutcome[], params: BktParams = BKT_PRIOR_V1): number {
  let p = params.pL0;
  for (const o of outcomes) p = bktUpdate(p, o, params);
  return p;
}

export type MasteryState =
  | "insufficient_evidence" | "weak" | "learning" | "possibly_mastered" | "mastered";

/** 状态门槛（设计 §9.5）；mastered 的迁移/延迟复测条件由调用方证据判定 */
export function masteryState(pProfile: number, independentCount: number, hasTransferEvidence = false): MasteryState {
  if (independentCount < 2) return "insufficient_evidence";
  if (pProfile < 0.4) return "weak";
  if (pProfile < 0.8) return "learning";
  if (pProfile < 0.95) return "possibly_mastered";
  return hasTransferEvidence ? "mastered" : "possibly_mastered";
}
