/**
 * 掌握内核契约测试（设计 §17.1；架构修订 v4 §3：OATutor 引擎移植 + pyBKT 数学对拍）。
 * 运行：node test/bkt.test.ts
 */
import { bktUpdate, bktReplay, masteryState, BKT_PRIOR_V1, type BktModel } from "../src/index.ts";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = Math.abs(Number(actual) - Number(expected)) < 1e-9;
  if (!ok) { failures++; console.error(`FAIL ${name}: got ${actual}, want ${expected}`); }
  else console.log(`ok   ${name}`);
}

// ── OATutor BKT-brain.js 移植对拍（标准贝叶斯后验，数学与 pyBKT 一致） ──
// P(L0)=0.3, G=0.2, S=0.1, T=0（BKT_PRIOR_V1）
const model: BktModel = { probMastery: BKT_PRIOR_V1.probMastery, params: BKT_PRIOR_V1 };
const afterSuccess = bktUpdate(model, "success");   // 0.3*0.9/(0.3*0.9+0.7*0.2)
const afterFailure = bktUpdate(model, "failure");   // 0.3*0.1/(0.3*0.1+0.7*0.8)
check("success 后验 = P(L)(1-S)/[P(L)(1-S)+(1-P(L))G]", afterSuccess, 0.27 / 0.41);
check("failure 后验 = P(L)S/[P(L)S+(1-P(L))(1-G)]", afterFailure, 0.03 / 0.59);

// 学习转移由参数集表达：T=0 时无转移；T>0 时按 P(L_next)=P(L|y)+(1-P(L|y))T（设计 §9.2）。
// 以 success 后验为先验再 success：先算新后验，再加 T=0.2 转移。
const withTransit = { ...BKT_PRIOR_V1, id: "bkt_test_t", probTransit: 0.2 };
const afterTransit = bktUpdate({ probMastery: afterSuccess, params: withTransit }, "success");
const newPosterior = (afterSuccess * 0.9) / (afterSuccess * 0.9 + (1 - afterSuccess) * 0.2);
check("T=0.2 转移后 = 新后验 + (1-新后验)*0.2", afterTransit, newPosterior + (1 - newPosterior) * 0.2);

// 重放与序列性质
const up = bktReplay(["success"]);
const down = bktReplay(["failure"]);
check("success 提升基准", up > BKT_PRIOR_V1.probMastery ? 1 : 0, 1);
check("failure 降低基准", down < BKT_PRIOR_V1.probMastery ? 1 : 0, 1);
const p5 = bktReplay(["success", "success", "success", "success", "success"]);
check("5 连对后 0.9<p<1", p5 > 0.9 && p5 < 1 ? 1 : 0, 1);

// 状态门槛（设计 §9.5；MASTERY_THRESHOLD=0.95 为 OATutor 项目约定）
check("证据不足", masteryState(0.99, 1) === "insufficient_evidence" ? 1 : 0, 1);
check("薄弱", masteryState(0.39, 3) === "weak" ? 1 : 0, 1);
check("学习中", masteryState(0.5, 3) === "learning" ? 1 : 0, 1);
check("可能掌握", masteryState(0.9, 3) === "possibly_mastered" ? 1 : 0, 1);
check("已掌握需迁移证据", masteryState(0.96, 3) === "possibly_mastered" ? 1 : 0, 1);
check("已掌握+迁移", masteryState(0.96, 3, true) === "mastered" ? 1 : 0, 1);

if (failures > 0) process.exit(1);
console.log("BKT TESTS PASS (OATutor 移植对拍 + 状态门槛)");
