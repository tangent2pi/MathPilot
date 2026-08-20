/**
 * Dream Validator 回归测试（P0-8 收紧项）：
 * 基准一致、维度覆盖、空更新拒绝、状态一致、双 Session 去重与窗口授权。
 * 运行：node test/validator.test.ts（Node 24 type stripping）
 */
import { validatePud, type PudPayload, type DimensionUpdate } from "../src/validator.ts";

let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) console.log(`ok   ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
}

function passed(checks: { check: string; passed: boolean }[]): boolean {
  return checks.every((c) => c.passed);
}
function check(checks: { check: string; passed: boolean }[], name: string): boolean {
  return checks.find((c) => c.check === name)?.passed ?? false;
}

const REFS = new Set(["ser_1", "ser_2", "tss_1", "tss_2"]);
const BASELINES = new Map<string, number>([["K_SSA", 0.42]]);
const COUNTS = new Map<string, number>([["K_SSA", 3]]);
const WINDOW = new Set(["s_1", "s_2"]);

function pud(over: Partial<PudPayload> = {}): PudPayload {
  return {
    decision_id: "pud_test",
    student_id: "usr_test",
    prior_snapshot_id: null,
    baseline_report_refs: ["ser_1", "ser_2"],
    teaching_summary_refs: ["tss_1", "tss_2"],
    dimension_updates: [update()],
    semantic_profile_updates: [],
    review_required: false,
    model_id: "test.model",
    prompt_version: "test@1",
    skill_version: "test-skill@1",
    created_at: "2026-08-18T00:00:00Z",
    ...over,
  };
}

/** 合法更新：p_final 由 p_baseline + LR 重算（0.42 → 约 0.666） */
function update(over: Partial<DimensionUpdate> = {}): DimensionUpdate {
  const pBaseline = 0.42;
  const lr = 2.7;
  const pFinal = 1 / (1 + Math.exp(-(Math.log(pBaseline / (1 - pBaseline)) + Math.log(lr))));
  return {
    dimension_id: "K_SSA",
    p_baseline: pBaseline,
    p_final: pFinal,
    state_final: "learning", // masteryState(0.666, 3) = learning
    evidence_ledger: [{
      code: "TRANSFER_SUCCESS_DISTINCT_CONTEXT",
      rubric_bin: "clear",
      lr_used: lr,
      session_refs: ["s_1", "s_2"],
      evidence_refs: ["obs_1", "obs_2"],
      explanation: "两题独立迁移成功",
    }],
    uncertainty: "medium",
    ...over,
  };
}

// 1. 合法 PUD → 全部通过
{
  const c = validatePud(pud(), REFS, BASELINES, COUNTS, WINDOW);
  ok(passed(c), "合法 PUD 全部检查通过");
}

// 2. p_baseline 与 Roster 不一致 → baseline_matches_program 失败（P0-8 核心漏洞）
{
  const c = validatePud(pud({ dimension_updates: [update({ p_baseline: 0.7 })] }), REFS, BASELINES, COUNTS, WINDOW);
  ok(!check(c, "baseline_matches_program"), "模型自报 p_baseline≠Roster → 拒绝");
}

// 3. 空 dimension_updates → 覆盖失败（P0-8：空更新不得通过）
{
  const c = validatePud(pud({ dimension_updates: [] }), REFS, BASELINES, COUNTS, WINDOW);
  ok(!check(c, "all_pending_dimensions_covered"), "空 dimension_updates → 覆盖检查失败");
  ok(!passed(c), "空 dimension_updates → 整体拒绝");
}

// 4. 漏掉待处理维度 → 覆盖失败
{
  const more = new Map(BASELINES); more.set("K_SINE_RULE", 0.85);
  const c = validatePud(pud(), REFS, more, COUNTS, WINDOW);
  ok(!check(c, "all_pending_dimensions_covered"), "遗漏待处理维度 → 覆盖检查失败");
}

// 5. state_final 与 masteryState(p_final, count) 不一致 → 拒绝
{
  const c = validatePud(pud({ dimension_updates: [update({ state_final: "mastered" })] }), REFS, BASELINES, COUNTS, WINDOW);
  ok(!check(c, "state_matches_probability"), "state_final 与概率门槛不符 → 拒绝");
}

// 6. 数值调整引用同一 Session（去重后 <2）→ 拒绝
{
  const c = validatePud(pud({ dimension_updates: [update({ evidence_ledger: [{
    code: "TRANSFER_SUCCESS_DISTINCT_CONTEXT", rubric_bin: "clear", lr_used: 2.7,
    session_refs: ["s_1", "s_1"], evidence_refs: ["obs_1", "obs_2"], explanation: "同一会话双证据",
  }] })] }), REFS, BASELINES, COUNTS, WINDOW);
  ok(!check(c, "min_two_sessions_per_numeric_update"), "同一 Session 重复引用 → 拒绝");
}

// 7. 数值调整引用窗口外 Session → 拒绝（授权）
{
  const c = validatePud(pud({ dimension_updates: [update({ evidence_ledger: [{
    code: "TRANSFER_SUCCESS_DISTINCT_CONTEXT", rubric_bin: "clear", lr_used: 2.7,
    session_refs: ["s_1", "s_3"], evidence_refs: ["obs_1", "obs_3"], explanation: "含窗口外会话",
  }] })] }), REFS, BASELINES, COUNTS, WINDOW);
  ok(!check(c, "min_two_sessions_per_numeric_update"), "窗口外 Session 引用 → 拒绝");
}

// 8. 未越界但重复证据码 → 双计数拒绝
{
  const c = validatePud(pud({ dimension_updates: [update({ evidence_ledger: [
    { code: "TRANSFER_SUCCESS_DISTINCT_CONTEXT", rubric_bin: "clear", lr_used: 2.0, session_refs: ["s_1", "s_2"], evidence_refs: [], explanation: "a" },
    { code: "TRANSFER_SUCCESS_DISTINCT_CONTEXT", rubric_bin: "clear", lr_used: 2.0, session_refs: ["s_1", "s_2"], evidence_refs: [], explanation: "b" },
  ] })] }), REFS, BASELINES, COUNTS, WINDOW);
  ok(!check(c, "no_double_counting"), "同族证据重复计数 → 拒绝");
}

if (failed > 0) { console.error(`${failed} FAILED`); process.exit(1); }
console.log("VALIDATOR TESTS PASS");
