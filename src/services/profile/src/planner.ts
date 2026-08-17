/**
 * 学习计划确定性排布器（设计 §10.3、§7.3：计划 = 画像子集，独立于 Dream 生成）。
 *
 * 输入：目标分、每周可投入时间、薄弱/待观察状态、复测到期日、自认薄弱。
 * 输出：1-4 周任务原子（知识补讲/低一档练习/原难度练习/迁移题/延迟复测），
 * 每项含达成判据与复测条件；LLM 只负责"为什么先做这个"的解释（plan skill），
 * 不自行增加任务（§10.3-5）。
 */

export type PlanTaskKind = "knowledge_review" | "practice_easy" | "practice_normal" | "transfer" | "delayed_review";

export interface PlanTask {
  week: number;
  kind: PlanTaskKind;
  dimension_ids: string[];
  criterion: string;
  review_condition: string;
  minutes: number;
  why?: string;
}

export interface PlannerInput {
  horizon_weeks: number;             // 1-4
  weekly_hours: string;              // 1-3 | 4-6 | 7-10 | 10+
  target_score?: number | null;
  current_score?: number | null;
  self_weak: string[];
  mastery: Record<string, { state?: string; next_review_due_days?: number | null }>;
  /** 章节包题型权重（维度 → 权重；首版可空） */
  type_weights?: Record<string, number>;
}

const HOURS_TO_MINUTES: Record<string, number> = { "1-3": 120, "4-6": 240, "7-10": 420, "10+": 600 };
const SESSION_MINUTES = 30;

/** 每周计划分钟数（按可投入时间档位） */
export function weeklyMinutes(input: PlannerInput): number {
  return HOURS_TO_MINUTES[input.weekly_hours] ?? 240;
}

/** 薄弱维度（掌握状态 weak/learning + 自认薄弱；证据不足单独处理） */
export function weakDims(input: PlannerInput): string[] {
  const byState = Object.entries(input.mastery)
    .filter(([, m]) => m.state === "weak" || m.state === "learning")
    .map(([dim]) => dim);
  return [...new Set([...byState, ...input.self_weak])];
}

export function insufficientDims(input: PlannerInput): string[] {
  return Object.entries(input.mastery)
    .filter(([, m]) => m.state === "insufficient_evidence")
    .map(([dim]) => dim);
}

export function dueReviewDims(input: PlannerInput): string[] {
  return Object.entries(input.mastery)
    .filter(([, m]) => m.next_review_due_days !== null && m.next_review_due_days !== undefined && m.next_review_due_days <= 14)
    .map(([dim]) => dim);
}

/** 确定性排布（首版规则）：薄弱→先补讲+低档；证据不足→覆盖练习；复测到期→对应周复测 */
export function planFromProfile(input: PlannerInput): PlanTask[] {
  const horizon = Math.min(Math.max(input.horizon_weeks, 1), 4);
  const budget = weeklyMinutes(input) / SESSION_MINUTES; // 每周可排原子数
  const tasks: PlanTask[] = [];

  const weak = weakDims(input);
  const insufficient = insufficientDims(input);
  const due = dueReviewDims(input);

  // 周 1-2：薄弱维度补讲 + 低一档练习
  for (const dim of weak) {
    if (tasks.length >= budget * horizon) break;
    tasks.push({
      week: 1, kind: "knowledge_review", dimension_ids: [dim],
      criterion: "能独立复述该维度核心方法与适用条件",
      review_condition: "下周低档练习正确率 ≥0.7",
      minutes: SESSION_MINUTES,
    });
    tasks.push({
      week: 1, kind: "practice_easy", dimension_ids: [dim],
      criterion: "低一档练习正确率 ≥0.7",
      review_condition: "达标后进入原难度练习",
      minutes: SESSION_MINUTES,
    });
    tasks.push({
      week: 2, kind: "practice_normal", dimension_ids: [dim],
      criterion: "原难度练习正确率 ≥0.7 且无提示",
      review_condition: "独立复测到期后验证",
      minutes: SESSION_MINUTES,
    });
  }

  // 周 1-3：证据不足维度覆盖练习
  for (const dim of insufficient) {
    if (tasks.length >= budget * horizon) break;
    tasks.push({
      week: 1, kind: "practice_easy", dimension_ids: [dim],
      criterion: "覆盖练习 ≥3 题且正确率 ≥0.7",
      review_condition: "后续会话纳入覆盖测评",
      minutes: SESSION_MINUTES,
    });
  }

  // 复测到期 → 对应周延迟复测（按到期紧迫度）
  for (const dim of due) {
    if (tasks.length >= budget * horizon) break;
    tasks.push({
      week: 1, kind: "delayed_review", dimension_ids: [dim],
      criterion: "独立延迟复测（无提示）",
      review_condition: "复测结果更新保持率后验",
      minutes: SESSION_MINUTES,
    });
  }

  // 目标分差距：差距大 → 周 3-4 增加原难度/迁移练习密度
  const gap = (input.target_score ?? 0) - (input.current_score ?? 0);
  if (gap >= 20) {
    for (const dim of [...new Set([...weak, ...insufficient])]) {
      if (tasks.length >= budget * horizon) break;
      tasks.push({
        week: 3, kind: "practice_normal", dimension_ids: [dim],
        criterion: "原难度综合题正确率 ≥0.7",
        review_condition: "周 4 迁移题验证",
        minutes: SESSION_MINUTES,
      });
      tasks.push({
        week: 4, kind: "transfer", dimension_ids: [dim],
        criterion: "跨表征/题型独立迁移成功",
        review_condition: "迁移成功进入画像证据账本",
        minutes: SESSION_MINUTES,
      });
    }
  }

  return tasks;
}
