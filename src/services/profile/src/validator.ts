/**
 * Dream 确定性 Validator（设计 §9.4）：只校验（引用/区间/算术/双 Session/基准/覆盖/状态一致），
 * 不得修改 Decision。独立模块供 /dream/run、/dream/validate 与回归测试共用。
 *
 * P0-8 收紧项：
 * - baseline_matches_program：p_baseline 必须等于 pyBKT Roster 程序基准（Dream 不得自报基准）；
 * - all_pending_dimensions_covered：dimension_updates 必须恰好覆盖全部待处理维度
 *   （空数组/遗漏维度均拒绝，不得静默丢弃）；
 * - state_matches_probability：state_final 必须与 masteryState(p_final, 观测数) 一致（§9.5）；
 * - min_two_distinct_sessions：数值调整的证据必须来自 ≥2 个不同且属于本窗口的 Session。
 */
import { masteryState } from "@mathpilot/mastery";

/** 版本化证据码 LR 区间（设计 §9.4，首版 prior_only 专家先验） */
const EVIDENCE_CODE_LR: Record<string, [number, number]> = {
  TRANSFER_SUCCESS_DISTINCT_CONTEXT: [2.0, 4.0],
  SELF_CORRECTION_RECURS: [1.3, 2.0],
  METHOD_STABLE_ACROSS_CONTEXTS: [1.3, 2.0],
  HINT_DEPENDENCY_DECLINES: [1.1, 1.5],
  REPEATED_MISCONCEPTION: [0.25, 0.5],
  TRANSFER_FAILURE_DISTINCT_CONTEXT: [0.25, 0.5],
  METHOD_INSTABILITY: [0.5, 0.8],
};

export const VALIDATOR_VERSION = "profile-validator-0.2.0";

export interface DimensionUpdate {
  dimension_id: string;
  p_baseline: number;
  p_final: number;
  state_final: string;
  evidence_ledger: {
    code: string;
    rubric_bin: string;
    lr_used: number;
    session_refs: string[];
    evidence_refs: string[];
    counterevidence_refs?: string[];
    explanation: string;
  }[];
  alternatives?: string[];
  uncertainty: "low" | "medium" | "high";
}

export interface PudPayload {
  decision_id: string;
  student_id: string;
  evidence_bundle_id?: string;
  prior_snapshot_id: string | null;
  supersedes?: string | null;
  baseline_report_refs: string[];
  teaching_summary_refs: string[];
  dimension_updates: DimensionUpdate[];
  semantic_profile_updates: unknown[];
  review_required: boolean;
  model_id: string;
  prompt_version: string;
  skill_version: string;
  created_at: string;
}

export interface ValidationCheck {
  check: string;
  passed: boolean;
  failures?: string[];
}

function logit(p: number): number {
  const c = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  return Math.log(c / (1 - c));
}

/**
 * 确定性 Validator：只校验（引用/区间/算术/双 Session/基准/覆盖/状态一致），
 * 不得修改 Decision（设计 §9.4；P0-8 收紧）。
 * programBaselines / obsCounts / windowSessionIds 由调用方（/dream/run 的 Roster 与窗口）提供。
 */
export function validatePud(
  pud: PudPayload,
  existingRefs: Set<string>,
  programBaselines: Map<string, number>,
  obsCounts: Map<string, number>,
  windowSessionIds: Set<string>,
): ValidationCheck[] {
  const refFailures: string[] = [];
  for (const r of [...pud.baseline_report_refs, ...pud.teaching_summary_refs]) {
    if (!existingRefs.has(r)) refFailures.push(r);
  }

  const lrFailures: string[] = [];
  const arithFailures: string[] = [];
  const sessionFailures: string[] = [];
  const codeSeen = new Set<string>();
  const dupFailures: string[] = [];
  const baselineFailures: string[] = [];
  const coverageFailures: string[] = [];
  const stateFailures: string[] = [];

  const updatedDims = new Set(pud.dimension_updates.map((d) => d.dimension_id));
  // 覆盖（P0-8）：待处理维度必须全部出现在 dimension_updates 中（含 evidence_ledger 为空的保守更新）
  for (const dim of programBaselines.keys()) {
    if (!updatedDims.has(dim)) coverageFailures.push(`missing update for pending dimension ${dim}`);
  }
  for (const dim of updatedDims) {
    if (!programBaselines.has(dim)) coverageFailures.push(`update for non-pending dimension ${dim}`);
  }

  for (const du of pud.dimension_updates) {
    // 基准（P0-8）：p_baseline 必须与程序基准一致（容差 0.001），不得接受模型自报值
    const base = programBaselines.get(du.dimension_id);
    if (base !== undefined && Math.abs(du.p_baseline - base) > 0.001) {
      baselineFailures.push(`${du.dimension_id}: p_baseline ${du.p_baseline} != roster ${base.toFixed(4)}`);
    }
    // 状态一致性（P0-8）：state_final 必须等于确定性门槛推导值
    const count = obsCounts.get(du.dimension_id) ?? 0;
    const expectedState = masteryState(du.p_final, count);
    if (du.state_final !== expectedState) {
      stateFailures.push(`${du.dimension_id}: state_final ${du.state_final} != masteryState(${du.p_final}, ${count}) = ${expectedState}`);
    }

    let sumLogLr = 0;
    for (const e of du.evidence_ledger) {
      const range = EVIDENCE_CODE_LR[e.code];
      if (!range) lrFailures.push(`${e.code}: unknown evidence code`);
      else if (e.lr_used < range[0] || e.lr_used > range[1]) {
        lrFailures.push(`${e.code}: lr ${e.lr_used} outside [${range[0]}, ${range[1]}]`);
      }
      if (codeSeen.has(`${du.dimension_id}:${e.code}`)) {
        dupFailures.push(`${du.dimension_id}:${e.code} double counted`);
      }
      codeSeen.add(`${du.dimension_id}:${e.code}`);
      sumLogLr += Math.log(e.lr_used);
      // 数值调整必须引用 ≥2 个不同 Session 的有效证据（§9.3）；引用必须属于本窗口（授权）
      const distinctSessions = new Set(e.session_refs ?? []);
      if (Math.abs(du.p_final - du.p_baseline) > 1e-9) {
        if (distinctSessions.size < 2) {
          sessionFailures.push(`${du.dimension_id}: numeric update requires >=2 distinct sessions, got ${distinctSessions.size}`);
        }
        for (const s of distinctSessions) {
          if (!windowSessionIds.has(s)) {
            sessionFailures.push(`${du.dimension_id}: session_ref ${s} outside Dream window (unauthorized)`);
          }
        }
      }
    }
    const expected = 1 / (1 + Math.exp(-(logit(du.p_baseline) + sumLogLr)));
    if (Math.abs(expected - du.p_final) > 0.01) {
      arithFailures.push(`${du.dimension_id}: p_final ${du.p_final} != recomputed ${expected.toFixed(4)}`);
    }
  }

  return [
    { check: "refs_exist_and_authorized", passed: refFailures.length === 0, ...(refFailures.length ? { failures: refFailures } : {}) },
    { check: "provenance_complete", passed: Boolean(pud.model_id && pud.prompt_version && pud.skill_version) },
    { check: "baseline_matches_program", passed: baselineFailures.length === 0, ...(baselineFailures.length ? { failures: baselineFailures } : {}) },
    { check: "all_pending_dimensions_covered", passed: coverageFailures.length === 0, ...(coverageFailures.length ? { failures: coverageFailures } : {}) },
    { check: "state_matches_probability", passed: stateFailures.length === 0, ...(stateFailures.length ? { failures: stateFailures } : {}) },
    { check: "lr_within_allowed_range", passed: lrFailures.length === 0, ...(lrFailures.length ? { failures: lrFailures } : {}) },
    { check: "arithmetic_recomputable", passed: arithFailures.length === 0, ...(arithFailures.length ? { failures: arithFailures } : {}) },
    { check: "no_double_counting", passed: dupFailures.length === 0, ...(dupFailures.length ? { failures: dupFailures } : {}) },
    { check: "min_two_sessions_per_numeric_update", passed: sessionFailures.length === 0, ...(sessionFailures.length ? { failures: sessionFailures } : {}) },
    { check: "update_magnitude_review_threshold", passed: pud.dimension_updates.every((d) => Math.abs(d.p_final - d.p_baseline) < 0.5) || pud.review_required },
  ];
}
