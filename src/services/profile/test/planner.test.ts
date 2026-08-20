/**
 * 学习计划排布回归测试（P0-10：周界与每周预算）。
 * 运行：node test/planner.test.ts（Node 24 type stripping）
 */
import { planFromProfile, type PlannerInput } from "../src/planner.ts";

let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) console.log(`ok   ${msg}`);
  else { failed++; console.error(`FAIL ${msg}`); }
}

function input(over: Partial<PlannerInput> = {}): PlannerInput {
  return {
    horizon_weeks: 4,
    weekly_hours: "4-6", // 240min → 8 原子/周
    target_score: 120,
    current_score: 95,
    self_weak: [],
    mastery: {},
    ...over,
  };
}

// 10 个薄弱维度（review 复现：请求 horizon=1 时不得出现第 2/3/4 周任务）
{
  const mastery: PlannerInput["mastery"] = {};
  for (let i = 0; i < 10; i++) mastery[`K_WEAK_${String(i).padStart(2, "0")}`] = { state: "weak" };
  const t = planFromProfile(input({ horizon_weeks: 1, weekly_hours: "1-3", target_score: 100, current_score: 95, mastery }));
  ok(t.every((x) => x.week === 1), "horizon=1：所有任务都落在第 1 周");
  ok(t.length <= 4, `horizon=1 + 每周 1-3h（120min→4 原子）：任务数 ${t.length} ≤ 4`);
}

// 每周预算：4-6h（8 原子/周），10 薄弱维度 × 3 任务 = 30 需求，周 1-2 各 ≤8，且 week ≤ horizon
{
  const mastery: PlannerInput["mastery"] = {};
  for (let i = 0; i < 10; i++) mastery[`K_WEAK_${String(i).padStart(2, "0")}`] = { state: "weak" };
  const t = planFromProfile(input({ horizon_weeks: 2, mastery }));
  const byWeek = new Map<number, number>();
  for (const x of t) byWeek.set(x.week, (byWeek.get(x.week) ?? 0) + 1);
  ok(t.every((x) => x.week <= 2), "horizon=2：无第 3/4 周任务");
  ok(byWeek.size === 2 && [...byWeek.values()].every((n) => n <= 8), `每周任务数 ≤8（实际 ${JSON.stringify([...byWeek])}）`);
  ok(t.length <= 16, `总任务数 ≤ 周数×每周预算（实际 ${t.length}）`);
}

// 单薄弱维度 + 预算充足：week1 补讲+低档，week2 原难度（按首选周排布）
{
  const t = planFromProfile(input({ mastery: { K_SSA: { state: "learning" } }, target_score: 100, current_score: 95 }));
  const w1 = t.filter((x) => x.week === 1);
  const w2 = t.filter((x) => x.week === 2);
  ok(w1.some((x) => x.kind === "knowledge_review") && w1.some((x) => x.kind === "practice_easy"), "周1 含补讲与低档练习");
  ok(w2.some((x) => x.kind === "practice_normal"), "周2 含原难度练习");
}

// 无薄弱/无证据不足/无到期 → 空计划（不产生垃圾任务）
{
  const t = planFromProfile(input({ target_score: 100, current_score: 95, mastery: {} }));
  ok(t.length === 0, "无目标维度时计划为空");
}

if (failed > 0) { console.error(`${failed} FAILED`); process.exit(1); }
console.log("PLANNER TESTS PASS");
