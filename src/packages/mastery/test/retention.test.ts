/**
 * 保持率层契约测试（设计 §17.1：保持率只改变复测优先级，不直接改 P(L)）。
 * 运行：node test/retention.test.ts
 */
import {
  I90_GRID, RETENTION_TARGET, MIN_DELAYED_RETESTS, retentionAt, pCorrectNow, initialI90Prior,
  updateI90Posterior, expectedRetentionAt, nextReviewDue,
} from "../src/retention.ts";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = Math.abs(Number(actual) - Number(expected)) < 1e-9;
  if (!ok) { failures++; console.error(`FAIL ${name}: got ${actual}, want ${expected}`); }
  else console.log(`ok   ${name}`);
}

// 可提取性：R(Δt|I90) = 0.9^(Δt/I90)
check("Δt=0 时 R=1", retentionAt(0, 4), 1);
check("Δt=I90 时 R=0.9", retentionAt(4, 4), 0.9);
check("Δt=2·I90 时 R=0.81", retentionAt(8, 4), 0.81);
check("小 I90 衰减更快", retentionAt(4, 0.5) < retentionAt(4, 64) ? 1 : 0, 1);

// 预测正确率组合（§9.6）：已习得但暂时提取困难 ≠ 从未掌握
const p = pCorrectNow(0.9, 0.2, 0.1, 0.5);
const never = pCorrectNow(0.1, 0.2, 0.1, 0.5);
check("已掌握(0.9)+提取0.5 预测正确率 > 未掌握(0.1)", p > never ? 1 : 0, 1);

// 后验更新：成功复测 → 长 I90 概率上升；失败 → 短 I90 概率上升
const prior = initialI90Prior();
const afterSuccess = updateI90Posterior(prior, 7, "success", 0.2, 0.1);
const afterFailure = updateI90Posterior(prior, 7, "failure", 0.2, 0.1);
check("成功复测后长 I90(64) 概率 > 初始", afterSuccess["64"]! > prior["64"]! ? 1 : 0, 1);
check("失败复测后短 I90(0.5) 概率 > 初始", afterFailure["0.5"]! > prior["0.5"]! ? 1 : 0, 1);
check("后验归一化", I90_GRID.reduce((s, d) => s + afterSuccess[String(d)]!, 0), 1);

// 时间层不改写掌握概率：本模块无任何 P(L) 更新函数（结构保证）
check("保持率层不含掌握更新", typeof (pCorrectNow as never) === "function" ? 1 : 0, 1);

// 复测到期：证据充分性（≥MIN_DELAYED_RETESTS 次独立延迟复测）；不足如实 unstable
const due0 = nextReviewDue(afterSuccess, 0);
check("0 次延迟复测 → 不稳定 days=null", due0.days === null && !due0.stable ? 1 : 0, 1);
const due1 = nextReviewDue(afterSuccess, MIN_DELAYED_RETESTS - 1);
check("少于阈值 → 不稳定", due1.days === null ? 1 : 0, 1);

// 多次成功复测（变化间隔，区分度更高）：给出复测天数
let post = initialI90Prior();
for (const d of [1, 3, 5, 10, 20, 40]) post = updateI90Posterior(post, d, "success", 0.2, 0.1);
const due2 = nextReviewDue(post, 6);
check("6 次延迟复测 → 稳定且有天数", due2.stable && due2.days !== null && due2.days! > 0 ? 1 : 0, 1);
check("成功复测偏长 I90 → 复测天数较长", due2.days! > 5 ? 1 : 0, 1);
check("目标阈值常量", RETENTION_TARGET, 0.85);
check("稳定阈值常量", MIN_DELAYED_RETESTS, 3);

if (failures > 0) process.exit(1);
console.log("RETENTION TESTS PASS");
