/**
 * 选题器契约测试（设计 §17.1：硬过滤、评分方向、目标驱动）。
 * 运行：node test/selector.test.ts
 */
import { hardFilter, selectNext, type QuestionCandidate, type SelectorContext } from "../src/index.ts";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) { failures++; console.error(`FAIL ${name}: got ${actual}, want ${expected}`); }
  else console.log(`ok   ${name}`);
}

const q = (id: string, dims: string[], roles: Array<"primary" | "secondary" | "prerequisite"> = ["primary"], verifiable = true, difficulty = 0.5): QuestionCandidate => ({
  question_id: id, tags: dims, measurement_dims: dims,
  measurement_targets: dims.map((dim, i) => ({ dim, role: roles[i] ?? "primary" })),
  answer_verifiable: verifiable,
  difficulty,
});

const base: SelectorContext = {
  goal: "coverage",
  candidates: [
    q("Q_1", ["K_SSA"]),
    q("Q_2", ["K_SINE_RULE", "K_SSA"], ["primary", "secondary"]),
    q("Q_3", ["K_SSA"]),
    q("Q_4", ["K_UNKNOWN"], ["primary"], false), // 不可验证
  ],
  mastery: { K_SINE_RULE: { p_profile: 0.9, state: "possibly_mastered", next_review_due_days: null } },
  seen: new Set(["Q_3"]),
  self_weak: [],
};

// 硬过滤：排除已见、不可验证；保留有测量目标
const filtered = hardFilter(base);
check("硬过滤排除已见题", filtered.some((x) => x.question_id === "Q_3") ? 1 : 0, 0);
check("硬过滤排除不可验证题", filtered.some((x) => x.question_id === "Q_4") ? 1 : 0, 0);
check("硬过滤保留候选", filtered.length === 2 ? 1 : 0, 1);

// 覆盖模式：未覆盖维度的 primary 优先（Q_1 的 K_SSA 无掌握记录 > Q_2）
const cov = selectNext(base);
check("覆盖模式选未覆盖维度题", cov?.question_id === "Q_1" ? 1 : 0, 1);

// 训练模式：自认薄弱维度优先
const train: SelectorContext = { ...base, goal: "training", self_weak: ["K_SINE_RULE"] };
const tr = selectNext(train);
check("训练模式选薄弱维度题", tr?.question_id === "Q_2" ? 1 : 0, 1);

const lower = selectNext({ ...base, goal: "training", self_weak: ["K_SSA"], mastery: {}, seen: new Set(), candidates: [
  q("Q_EASY", ["K_SSA"], ["primary"], true, 0.4),
  q("Q_HARD", ["K_SSA"], ["primary"], true, 0.9),
] });
check("专项巩固优先低一档题", lower?.question_id === "Q_EASY" ? 1 : 0, 1);

// 复测模式：到期维度优先
const review: SelectorContext = {
  ...base, goal: "review",
  mastery: {
    K_SINE_RULE: { p_profile: 0.9, state: "possibly_mastered", next_review_due_days: 3 },
    K_SSA: { p_profile: 0.7, state: "learning", next_review_due_days: null },
  },
  seen: new Set(),
};
const rv = selectNext(review);
check("复测模式选到期维度题", rv?.question_id === "Q_2" ? 1 : 0, 1);

// 无合适题 → null
const none = selectNext({ ...base, candidates: [q("Q_9", ["K_SSA"])], seen: new Set(["Q_9"]) });
check("无候选返回 null", none === null ? 1 : 0, 1);

if (failures > 0) process.exit(1);
console.log("SELECTOR TESTS PASS");
