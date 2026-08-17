/**
 * 掌握内核（架构修订 v4 §3：成品复用，不手写算法）。
 *
 * - 逐观测更新移植自 OATutor `src/models/BKT/BKT-brain.js`（标准贝叶斯后验 +
 *   学习转移；数学与 pyBKT 一致，见 contract 对拍测试）；
 * - 参数形状采用 OATutor `defaultBKTParams.json` 的
 *   { probMastery, probTransit, probSlip, probGuess } schema，按资源类版本化；
 * - MASTERY_THRESHOLD=0.95 采用 OATutor 项目约定（设计 §9.5）；
 * - 学习转移语义（设计 §9.2）：probTransit 只在该资源类有明确学习机会时 >0，
 *   纯诊断 T=0——由参数集表达，不由代码特判；
 * - 只回答"按已确认逐题观测和固定公式，基准评价是多少"——不产出最终画像；
 *   `calibration_status=prior_only` 的数值不得伪装成真实概率。
 */

export interface BktParams {
  /** 参数集 ID（parameter_set_id，全链路审计字段，设计 §14.3） */
  readonly id: string;
  /** P(L0)：先验掌握概率（OATutor probMastery） */
  readonly probMastery: number;
  /** 学习转移（OATutor probTransit）：该资源类一次明确学习机会后的转移；纯诊断=0 */
  readonly probTransit: number;
  /** 滑移（答对但未掌握，OATutor probSlip） */
  readonly probSlip: number;
  /** 猜测（未掌握但答对，OATutor probGuess） */
  readonly probGuess: number;
  readonly calibration: "prior_only" | "calibrated";
}

/** 首版统一保守先验（prior_only，未校准）；probTransit=0：纯诊断无学习转移（设计 §9.2） */
export const BKT_PRIOR_V1: BktParams = {
  id: "bkt_prior_v1",
  probMastery: 0.3,
  probTransit: 0,
  probSlip: 0.1,
  probGuess: 0.2,
  calibration: "prior_only",
};

/** 掌握状态模型（OATutor BKT-brain.js 的 model 形状） */
export interface BktModel {
  probMastery: number;
  params: BktParams;
}

export type BinaryOutcome = "success" | "failure";

/**
 * 单次观测的贝叶斯更新——OATutor BKT-brain.js 移植（数学与 pyBKT 相同）：
 *   P(L|y) = P(L)(1-S)/[P(L)(1-S)+(1-P(L))G]   成功
 *   P(L|y) = P(L)S/[P(L)S+(1-P(L))(1-G)]       失败
 *   P(L_next) = P(L|y) + (1-P(L|y))·T          学习转移（T 由参数集表达）
 */
export function bktUpdate(model: BktModel, outcome: BinaryOutcome): number {
  // 演化概率在 model.probMastery；params.probMastery 只是先验（不参与迭代）
  const { probMastery } = model;
  const { probSlip, probGuess, probTransit } = model.params;
  const numerator = outcome === "success"
    ? probMastery * (1 - probSlip)
    : probMastery * probSlip;
  const denominator = outcome === "success"
    ? numerator + (1 - probMastery) * probGuess
    : numerator + (1 - probMastery) * (1 - probGuess);
  const posterior = numerator / denominator;
  return posterior + (1 - posterior) * probTransit;
}

/** 按时间序重放二值观测（supersede 排除的旧观测不进入序列，由调用方保证） */
export function bktReplay(outcomes: readonly BinaryOutcome[], params: BktParams = BKT_PRIOR_V1): number {
  let probMastery = params.probMastery;
  for (const o of outcomes) {
    probMastery = bktUpdate({ probMastery, params }, o);
  }
  return probMastery;
}

/** 掌握阈值约定（OATutor MASTERY_THRESHOLD，设计 §9.5）：不是普适定律，运营阈值待校准 */
export const MASTERY_THRESHOLD = 0.95;

export type MasteryState =
  | "insufficient_evidence" | "weak" | "learning" | "possibly_mastered" | "mastered";

/** 状态门槛（设计 §9.5）；mastered 的迁移/延迟复测条件由调用方证据判定 */
export function masteryState(pProfile: number, independentCount: number, hasTransferEvidence = false): MasteryState {
  if (independentCount < 2) return "insufficient_evidence";
  if (pProfile < 0.4) return "weak";
  if (pProfile < 0.8) return "learning";
  if (pProfile < MASTERY_THRESHOLD) return "possibly_mastered";
  return hasTransferEvidence ? "mastered" : "possibly_mastered";
}
