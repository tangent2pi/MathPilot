/**
 * BKT 内核性质测试（设计 §17.1）。
 * 运行：node test/bkt.test.ts
 */
import { bktUpdate, bktReplay, masteryState, BKT_PRIOR_V1 } from "../src/index.ts";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = Math.abs(Number(actual) - Number(expected)) < 1e-9;
  if (!ok) { failures++; console.error(`FAIL ${name}: got ${actual}, want ${expected}`); }
  else console.log(`ok   ${name}`);
}

// 公式对拍：P(L0)=0.3, G=0.2, S=0.1
check("success: 0.3*0.9/(0.3*0.9+0.7*0.2)", bktUpdate(0.3, "success"), 0.27 / 0.41);
check("failure: 0.3*0.1/(0.3*0.1+0.7*0.8)", bktUpdate(0.3, "failure"), 0.03 / 0.59);

// 单调性
const up = bktReplay(["success"]);
const down = bktReplay(["failure"]);
check("success 提升基准", up > BKT_PRIOR_V1.pL0 ? 1 : 0, 1);
check("failure 降低基准", down < BKT_PRIOR_V1.pL0 ? 1 : 0, 1);

// 全对序列应收敛到高值但仍 < 1
const p5 = bktReplay(["success", "success", "success", "success", "success"]);
check("5 连对后 0.9<p<1", p5 > 0.9 && p5 < 1 ? 1 : 0, 1);

// 状态门槛（设计 §9.5）
check("证据不足", masteryState(0.99, 1) === "insufficient_evidence" ? 1 : 0, 1);
check("薄弱", masteryState(0.39, 3) === "weak" ? 1 : 0, 1);
check("学习中", masteryState(0.5, 3) === "learning" ? 1 : 0, 1);
check("可能掌握", masteryState(0.9, 3) === "possibly_mastered" ? 1 : 0, 1);
check("已掌握需迁移证据", masteryState(0.96, 3) === "possibly_mastered" ? 1 : 0, 1);
check("已掌握+迁移", masteryState(0.96, 3, true) === "mastered" ? 1 : 0, 1);

if (failures > 0) process.exit(1);
console.log("BKT TESTS PASS");
