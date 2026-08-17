/**
 * 保持率层（设计 §9.6，架构修订 v4 §3：无成品需自建）。
 *
 * 艾宾浩斯式可提取性 R(Δt|I90)，与掌握概率 M 严格分离——时间层不执行
 * P(L) ← P(L)·R（§9.6）。I90 在固定稳定度网格上做可解释贝叶斯更新，
 * 只有独立延迟复测更新后验；复测时间 = 平均保持率首降 < 目标阈值的时刻。
 * 数据不足时如实输出 unstable，不伪造精确日期。
 */

export const I90_GRID = [0.5, 1, 2, 4, 8, 16, 32, 64] as const;
export type I90Days = (typeof I90_GRID)[number];

/** 复测目标保持率（实验参数，§20 待校准） */
export const RETENTION_TARGET = 0.85;

/** 保持率后验：I90 天数 → 后验概率（和为 1） */
export type I90Posterior = Record<string, number>;

/** 均匀先验（首版；校准后以真实复测序列更新） */
export function initialI90Prior(): I90Posterior {
  const prior: I90Posterior = {};
  for (const d of I90_GRID) prior[String(d)] = 1 / I90_GRID.length;
  return prior;
}

/** 可提取性：R(Δt | I90) = 0.9^(Δt / I90)（§9.6） */
export function retentionAt(days: number, i90: number): number {
  if (days <= 0) return 1;
  return Math.pow(0.9, days / i90);
}

/** 预测当前答题成功率：P(correct_now) = P_profile·[G+(1-G-S)·E(R)] + (1-P_profile)·G（§9.6） */
export function pCorrectNow(pProfile: number, guess: number, slip: number, expectedRetention: number): number {
  const mastered = guess + (1 - guess - slip) * expectedRetention;
  return pProfile * mastered + (1 - pProfile) * guess;
}

/**
 * I90 后验更新：posterior(I90_i) ∝ prior(I90_i)·P(y | I90_i, Δt, q)（§9.6）。
 * 只由独立延迟复测调用；outcome 为复测对错。
 */
export function updateI90Posterior(
  prior: I90Posterior,
  daysSinceReview: number,
  outcome: "success" | "failure",
  guess: number,
  slip: number,
): I90Posterior {
  const posterior: I90Posterior = {};
  let sum = 0;
  for (const d of I90_GRID) {
    const r = retentionAt(daysSinceReview, d);
    // P(y=1|I90,Δt,q) = G + (1-G-S)·R；失败即 1 - P(y=1)
    const pCorrect = guess + (1 - guess - slip) * r;
    const likelihood = outcome === "success" ? pCorrect : 1 - pCorrect;
    const w = (prior[String(d)] ?? 0) * likelihood;
    posterior[String(d)] = w;
    sum += w;
  }
  for (const d of I90_GRID) posterior[String(d)] = sum > 0 ? posterior[String(d)]! / sum : 0;
  return posterior;
}

/** 平均保持率：E[R(Δt)] = Σ posterior(I90_i)·R(Δt|I90_i) */
export function expectedRetentionAt(days: number, posterior: I90Posterior): number {
  let sum = 0;
  for (const d of I90_GRID) sum += (posterior[String(d)] ?? 0) * retentionAt(days, d);
  return sum;
}

/** 稳定所需的最小独立延迟复测次数（实验参数，§20） */
export const MIN_DELAYED_RETESTS = 3;

export interface ReviewDue {
  /** 平均保持率首次低于目标的延迟天数（最近整数）；不稳定时为 null */
  days: number | null;
  /** 是否已有足够独立延迟复测（证据充分性，不伪造精确日期，§9.6） */
  stable: boolean;
}

/**
 * 下一次复测时间：平均保持率首降 < RETENTION_TARGET 的时刻。
 * 独立延迟复测 < MIN_DELAYED_RETESTS 时 days=null 并标注 unstable。
 */
export function nextReviewDue(posterior: I90Posterior, delayedRetestCount: number): ReviewDue {
  if (delayedRetestCount < MIN_DELAYED_RETESTS) return { days: null, stable: false };
  for (let d = 1; d <= 365; d++) {
    if (expectedRetentionAt(d, posterior) < RETENTION_TARGET) return { days: d, stable: true };
  }
  return { days: 365, stable: true };
}
