// self-test 域：编排服务（建轮/续测视图/判答推进/结束报告/错答案审计）。
// BKT 与策略口径见 core.ts；content 只读查询见 content.ts。
import type pg from "pg";
import { withPrincipal, newId } from "../lib.ts";
import { resolveLearningSubject } from "../learning-read/acl.ts";
import {
  replayDimension, initialRuntime, applyAnswerStep, currentSlot, type MasteryState,
  type RuntimeState, type QuestionSlot, moduleToBucket, difficultyTo1to5, ROUND_PLAN, ROUND_SIZE, MAX_Q_PER_DIM,
} from "./core.ts";
import { buildFinalReport, roundSummaryLines, type ReportContext } from "./report.ts";
import {
  loadKnowledgeTree, loadDrawablePool, loadQuestionMaterial, loadGradeBasis,
  type QuestionMaterial, type KnowledgePointRow,
} from "./content.ts";

export class SelfTestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly currentVersion?: number,
  ) {
    super(message);
  }
}

export interface PrincipalLike {
  tenantId: string;
  userId: string;
  roles: readonly string[];
}

type Client = pg.PoolClient;

// ---------------------------------------------------------------------------
// 出题：分层优先 + 重点点填充 + 题型轮换 + 排除已用
// ---------------------------------------------------------------------------

interface SlotCandidate {
  questionRevisionId: string;
  dimensionId: string; // 题归属的知识点（BKT 观测维度）
  stemFormat: string;
}

/**
 * 按题位抽题：从属于 slot.bucket（入门/进阶/综合）的知识点中，重点点排前，
 * 找难度匹配、未用过的题；题型尽量与上一题轮换。
 * dimServed 记录本轮各知识点已命中题数，达到 MAX_Q_PER_DIM 的点本轮跳过，
 * 防止重点点垄断整层、饿死同层其余点。
 */
async function pickBySlot(
  client: Client,
  principal: PrincipalLike,
  slot: QuestionSlot,
  tree: Map<string, KnowledgePointRow>,
  focusIds: string[],
  usedRevisions: string[],
  lastFormat: string | null,
  dimServed: Record<string, number>,
): Promise<SlotCandidate | null> {
  const inBucket = [...tree.entries()]
    .filter(([, row]) => moduleToBucket(row.moduleName) === slot.bucket)
    .map(([id]) => id);
  const focus = inBucket.filter((id) => focusIds.includes(id));
  const others = inBucket.filter((id) => !focusIds.includes(id));
  const ordered = [...focus, ...others];

  const candidates: SlotCandidate[] = [];
  for (const kid of ordered) {
    if ((dimServed[kid] ?? 0) >= MAX_Q_PER_DIM) continue; // 本轮该点已达配额
    const pool = await loadDrawablePool(client, principal.tenantId, principal.userId, kid);
    const matched = pool.filter(
      (q) =>
        !usedRevisions.includes(q.questionRevisionId) &&
        difficultyTo1to5(q.difficulty) === slot.difficulty1to5,
    );
    for (const q of matched) {
      candidates.push({ questionRevisionId: q.questionRevisionId, dimensionId: kid, stemFormat: q.stemFormat });
      if (candidates.length >= 5) break; // 已收集足够候选，不必遍历所有知识点
    }
    if (candidates.length >= 5) break;
  }
  if (!candidates.length) return null;

  const preferred = candidates.filter((c) => lastFormat === null || c.stemFormat !== lastFormat);
  const source = preferred.length ? preferred : candidates;
  return source[Math.floor(Math.random() * source.length)] ?? source[0] ?? null;
}

// ---------------------------------------------------------------------------
// 判答（对照题库答案自动判；AI 二次核验/人工修订走 audit 队列）
// ---------------------------------------------------------------------------
export interface GradeOutcome {
  verdict: "correct" | "incorrect";
  expected: string[];
  matchedVia: "answer_text" | "option_is_correct" | null;
  suspicious: boolean; // 疑似题库答案本身有误
}

function normalizeText(value: string): string {
  return value
    .trim()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，。．.、；;：:]/g, "")
    .toLowerCase();
}

export function gradeResponse(
  response: string,
  basis: { answerTexts: string[]; options: { key: string; text: string; isCorrect: boolean }[] },
  stemFormat: string,
): GradeOutcome {
  const expected = basis.answerTexts;
  const normalized = normalizeText(response);
  if (expected.some((answer) => normalizeText(answer) === normalized)) {
    return { verdict: "correct", expected, matchedVia: "answer_text", suspicious: false };
  }
  const option = basis.options.find((item) => normalizeText(item.key) === normalized);
  if (option) {
    return {
      verdict: option.isCorrect ? "correct" : "incorrect",
      expected,
      matchedVia: "option_is_correct",
      // 学生选了 is_correct 的选项却未被 answer_texts 覆盖 → 题库登记答案可疑
      suspicious: option.isCorrect && stemFormat === "single_choice",
    };
  }
  return { verdict: "incorrect", expected, matchedVia: null, suspicious: false };
}

// ---------------------------------------------------------------------------
// 运行结构
// ---------------------------------------------------------------------------
export interface DimensionSnapshot {
  knowledgeId: string;
  name: string;
  answered: number;
  correct: number;
  accuracy: number | null;
  pMastery: number;
  state: MasteryState;
  transferEvidence: number;
}

export interface RunViewQuestion extends QuestionMaterial {
  index: number; // 1-based
}

export interface RunView {
  runId: string;
  status: "active" | "finished" | "cancelled";
  createdAt: string;
  answeredTotal: number;
  questionCap: number;
  roundNo: number;
  goalScore?: number;
  dailyMinutes?: number;
  dimensions: DimensionSnapshot[];
  question: RunViewQuestion | null;
}

/** 轮配置（落库 jsonb，snake_case key 满足 DB `?& ['knowledge_ids','difficulty']` CHECK）。
 *  补充 key：round_no（本轮序号，第1轮=1）、selected_by（user/system）、
 *  goal_score（0–100）、daily_minutes（每天投入分钟）。这些在**建轮时**写入，中途不可改。 */
interface RunConfig {
  knowledge_ids: string[]; // 重点点（第 1 轮用户选；第 2 轮起系统覆盖为「未测/薄弱点」）
  difficulty: number;      // 保留占位（v2 按分层计划抽题，不再自适应；DB CHECK 要求此 key）
  chapter_name: string;
  round_no?: number;
  selected_by?: "user" | "system";
  goal_score?: number;
  daily_minutes?: number;
}

interface CurrentQuestion {
  revision_id: string;
  dimension_id: string; // 该题归属知识点（BKT 观测维度）
}

interface StoredRun {
  run_id: string;
  status: string;
  conversation_thread_id: string | null;
  config: RunConfig;
  state: { runtime: RuntimeState; current_question: CurrentQuestion | null };
  version: number;
  created_at: Date;
}

function parseStoredRun(row: Record<string, unknown>): StoredRun {
  return {
    run_id: String(row.run_id),
    status: String(row.status),
    conversation_thread_id: (row.conversation_thread_id as string | null) ?? null,
    config: row.config as StoredRun["config"],
    state: row.state as StoredRun["state"],
    version: Number(row.version),
    created_at: row.created_at as Date,
  };
}

interface AnswerRow {
  sequence: number;
  question_revision_id: string;
  dimension_id: string;
  stem_format: string;
  response_text: string;
  verdict: string;
}

const RUN_SELECT = `select run_id,status,conversation_thread_id,config,state,version,created_at
                      from science_v3_self_test_run`;

export class SelfTestService {
  constructor(private readonly pool: pg.Pool) {}

  /** GET /api/learning/self-test/knowledge-tree?chapter=… 三级树（只看可抽） */
  async knowledgeTree(principal: PrincipalLike, chapter?: string) {
    return withPrincipal(this.pool, principal, async (client) => {
      const rows = await loadKnowledgeTree(client, principal.tenantId, principal.userId, chapter);
      const byChapter = new Map<string, Map<string, typeof rows>>();
      for (const row of rows) {
        const chapterName = row.gradeBand ?? "未分章";
        const moduleName = row.moduleName ?? chapterName;
        if (!byChapter.has(chapterName)) byChapter.set(chapterName, new Map());
        const modules = byChapter.get(chapterName)!;
        if (!modules.has(moduleName)) modules.set(moduleName, []);
        modules.get(moduleName)!.push(row);
      }
      const chapters = [...byChapter.entries()].map(([chapterName, modules]) => ({
        chapterName,
        modules: [...modules.entries()].map(([moduleName, knowledgePoints]) => ({ moduleName, knowledgePoints })),
      }));
      return { chapters };
    });
  }

  /** GET /api/learning/self-test/current — 进行中的轮（续测入口） */
  async currentRun(principal: PrincipalLike): Promise<{ run: RunView | null }> {
    return withPrincipal(this.pool, principal, async (client) => {
      const result = await client.query(
        `${RUN_SELECT} where tenant_id=$1 and user_id=$2 and status='active' order by created_at desc limit 1`,
        [principal.tenantId, principal.userId],
      );
      if (!result.rows[0]) return { run: null };
      return { run: await this.runViewOf(client, principal, parseStoredRun(result.rows[0])) };
    });
  }

  /** POST /api/learning/self-test/runs */
  async createRun(
    principal: PrincipalLike,
    input: {
      thread_id: string;
      knowledge_ids?: string[];
      chapter_name?: string;
      goal_score?: number;
      daily_minutes?: number;
    },
  ): Promise<{ run: RunView }> {
    if (!/^thr_[A-Za-z0-9]{8,}$/.test(input.thread_id)) {
      throw new SelfTestError(422, "invalid_thread_id", "缺少有效的对话线程");
    }
    const goal = input.goal_score;
    if (goal !== undefined && (!Number.isFinite(goal) || goal < 0 || goal > 100)) {
      throw new SelfTestError(422, "invalid_goal_score", "目标分需在 0–100 之间");
    }
    const minutes = input.daily_minutes;
    if (minutes !== undefined && (!Number.isFinite(minutes) || minutes < 1 || minutes > 600)) {
      throw new SelfTestError(422, "invalid_daily_minutes", "每天投入时长需在 1–600 分钟之间");
    }

    return withPrincipal(this.pool, principal, async (client) => {
      // 单例锁：同一学生只允许一个进行中的轮（不允许并行）
      const active = (await client.query(
        `select run_id from science_v3_self_test_run
          where tenant_id=$1 and user_id=$2 and status='active' limit 1`,
        [principal.tenantId, principal.userId],
      )).rows[0] as { run_id: string } | undefined;
      if (active) {
        throw new SelfTestError(409, "self_test_active_run_exists", `已有一轮测评进行中（${active.run_id}），请先继续或结束该轮`);
      }

      const tree = await loadKnowledgeTree(client, principal.tenantId, principal.userId);
      const meta = new Map(tree.map((row) => [row.knowledgeId, row]));

      // 轮序号：某学生在同 thread 下已 finished 的 run 计数 +1
      const finishedRuns = (await client.query(
        `select run_id from science_v3_self_test_run
          where tenant_id=$1 and user_id=$2 and conversation_thread_id=$3 and status='finished'
          order by created_at asc`,
        [principal.tenantId, principal.userId, input.thread_id],
      )).rows as { run_id: string }[];
      const roundNo = finishedRuns.length + 1;

      // 选题：第 1 轮用户传 knowledge_ids；第 2 轮起系统自动选点（未测→薄弱→随机）
      let knowledgeIds: string[];
      let selectedBy: "user" | "system";
      if (roundNo >= 2) {
        knowledgeIds = await this.pickSystemPoints(client, principal, tree, finishedRuns.map((r) => r.run_id));
        selectedBy = "system";
        if (!knowledgeIds.length) {
          throw new SelfTestError(422, "no_drawable_points", "当前没有可抽题的知识点，无法开启下一轮");
        }
      } else {
        const ids = input.knowledge_ids;
        if (!Array.isArray(ids) || ids.length < 1 || ids.length > 4) {
          throw new SelfTestError(422, "invalid_knowledge_ids", "每次测评请选择 1–4 个重点知识点");
        }
        for (const id of ids) {
          if (typeof id !== "string" || !/^K_[A-Z0-9_]{2,}$/.test(id)) {
            throw new SelfTestError(422, "invalid_knowledge_ids", `知识点编号不合法: ${String(id)}`);
          }
        }
        knowledgeIds = ids;
        selectedBy = "user";
      }
      for (const id of knowledgeIds) {
        const node = meta.get(id);
        if (!node || node.drawable <= 0) {
          throw new SelfTestError(422, "knowledge_not_drawable", `知识点 ${id} 当前没有可抽题（选择题/填空题）`);
        }
      }
      const chapterName = input.chapter_name
        ?? (meta.get(knowledgeIds[0]!)?.gradeBand ?? "未分章");

      const runtime = initialRuntime(ROUND_PLAN);
      const runId = newId("str");

      // 预取第一题（plan[0] = 入门层 / 难1，分层优先 + 重点点填充）
      const firstSlot = currentSlot(runtime);
      if (!firstSlot) throw new SelfTestError(500, "run_state_invalid", "抽题计划为空");
      const first = await pickBySlot(client, principal, firstSlot, meta, knowledgeIds, [], null, runtime.dimServed);
      if (!first) throw new SelfTestError(422, "knowledge_not_drawable", "当前重点知识点无可抽题目");
      const material = await loadQuestionMaterial(client, principal.tenantId, first.questionRevisionId);
      if (!material) throw new SelfTestError(500, "material_missing", "题目素材读取失败");
      runtime.dimServed[first.dimensionId] = (runtime.dimServed[first.dimensionId] ?? 0) + 1;

      const state: { runtime: RuntimeState; current_question: CurrentQuestion | null } = {
        runtime,
        current_question: { revision_id: first.questionRevisionId, dimension_id: first.dimensionId },
      };
      const storedConfig: RunConfig = {
        knowledge_ids: knowledgeIds,
        difficulty: 0.5, // 占位（DB CHECK 要求此 key；v2 按分层计划抽题，不依赖它）
        chapter_name: chapterName,
        round_no: roundNo,
        selected_by: selectedBy,
        ...(goal !== undefined ? { goal_score: goal } : {}),
        ...(minutes !== undefined ? { daily_minutes: minutes } : {}),
      };

      await client.query(
        `insert into science_v3_self_test_run(
           run_id,tenant_id,user_id,conversation_thread_id,status,config,state,version
         ) values ($1,$2,$3,$4,'active',$5::jsonb,$6::jsonb,1)`,
        [runId, principal.tenantId, principal.userId, input.thread_id,
          JSON.stringify(storedConfig),
          JSON.stringify(state)],
      );
      const stored = parseStoredRun((await client.query(
        `${RUN_SELECT} where tenant_id=$1 and run_id=$2`, [principal.tenantId, runId],
      )).rows[0] as Record<string, unknown>);
      return { run: await this.runViewOf(client, principal, stored) };
    });
  }

  /**
   * 系统自动选点（第 2 轮起）：按 未测 → 薄弱 → 随机 优先级，从知识树挑 ≤4 个可抽点。
   * - 未测点：历史 finished runs 中从未出现过的知识点；
   * - 薄弱点：历史作答重放 BKT 状态为 weak / insufficient_evidence 的点；
   * - 仍有名额则从其余可抽点随机补足。
   */
  private async pickSystemPoints(
    client: Client,
    principal: PrincipalLike,
    tree: KnowledgePointRow[],
    priorRunIds: string[],
  ): Promise<string[]> {
    // 历史作答（本轮之前全部 finished runs）
    const historyObs: { dimension_id: string; verdict: string; stem_format: string }[] = priorRunIds.length
      ? (await client.query(
          `select dimension_id, verdict, stem_format from science_v3_self_test_answer
            where tenant_id=$1 and user_id=$2 and run_id = any($3::text[])
            order by sequence asc`,
          [principal.tenantId, principal.userId, priorRunIds],
        )).rows as { dimension_id: string; verdict: string; stem_format: string }[]
      : [];

    const testedIds = new Set<string>();
    const weakIds = new Set<string>();
    for (const id of new Set(historyObs.map((a) => a.dimension_id))) {
      testedIds.add(id);
      const replay = replayDimension(
        historyObs.map((a) => ({ dimensionId: a.dimension_id, correct: a.verdict === "correct", format: a.stem_format })),
        id,
      );
      if (replay.state === "weak" || replay.state === "insufficient_evidence") weakIds.add(id);
    }

    const all = tree.filter((row) => row.drawable > 0);
    const untested = all.filter((row) => !testedIds.has(row.knowledgeId));
    const weak = all.filter((row) => weakIds.has(row.knowledgeId) && !untested.includes(row));
    const rest = all.filter((row) => !untested.includes(row) && !weak.includes(row));

    const pick = (source: KnowledgePointRow[], count: number): string[] => {
      const shuffled = [...source].sort(() => Math.random() - 0.5);
      return shuffled.slice(0, count).map((row) => row.knowledgeId);
    };

    const result: string[] = [];
    result.push(...pick(untested, 4));
    if (result.length < 4) result.push(...pick(weak, 4 - result.length));
    if (result.length < 4) result.push(...pick(rest, 4 - result.length));
    return result.slice(0, 4);
  }

  /** GET /api/learning/self-test/runs/:id */
  async getRun(principal: PrincipalLike, runId: string): Promise<{ run: RunView }> {
    return withPrincipal(this.pool, principal, async (client) => {
      const stored = await this.loadRun(client, principal, runId);
      return { run: await this.runViewOf(client, principal, stored) };
    });
  }

  /**
   * GET /api/learning/self-test/report/latest?thread_id=…
   * 重取该线程最近一份"整章报告"（round_no>=3 的 finished run），幂等、不追加对话消息。
   * 用于前端"查看最近报告"入口：关闭对话框后仍能回到独立报告详情。
   */
  async latestReport(
    principal: PrincipalLike,
    threadId: string,
  ): Promise<{ report: string; report_payload?: unknown; runId: string; round_no: number } | null> {
    if (!/^thr_[A-Za-z0-9]{8,}$/.test(threadId)) {
      throw new SelfTestError(422, "invalid_thread_id", "缺少有效的对话线程");
    }
    return withPrincipal(this.pool, principal, async (client) => {
      const rows = (await client.query(
        `select run_id, config from science_v3_self_test_run
          where tenant_id=$1 and user_id=$2 and conversation_thread_id=$3 and status='finished'
          order by created_at desc limit 1`,
        [principal.tenantId, principal.userId, threadId],
      )).rows as { run_id: string; config: RunConfig }[];
      if (!rows.length) return null;
      const last = rows[0];
      if (!last) return null;
      if ((last.config.round_no ?? 1) < 3) return null; // 仅整章报告（≥3 轮）
      const stored = await this.loadRun(client, principal, last.run_id);
      const { report, payload } = await this.buildReport(client, principal, stored);
      return {
        report,
        report_payload: payload,
        runId: last.run_id,
        round_no: last.config.round_no ?? 1,
      };
    });
  }

  /**
   * GET /api/learning/self-test/teacher/report?student_id=…
   * 教师读取其名下某学生的最近一份整章测评报告（round_no>=3）。
   * 鉴权复用 resolveLearningSubject：仅当该学生与教师同班、且教师在班内为 active teacher 时才放行。
   * 报告内容与学生本人看到的整章汇总报告一致（含 payload）。
   */
  async teacherStudentReport(
    principal: PrincipalLike,
    studentId: string,
  ): Promise<{ report: string; report_payload?: unknown; runId: string; round_no: number; student: { userId: string; displayName: string } } | null> {
    if (!/^stu_[A-Za-z0-9]{8,}$/.test(studentId)) {
      throw new SelfTestError(422, "invalid_student_id", "缺少有效的学生标识");
    }
    if (!principal.roles.includes("teacher")) {
      throw new SelfTestError(403, "teacher_role_required", "只有教师可查看学生测评报告");
    }
    return withPrincipal(this.pool, principal, async (client) => {
      const subject = await resolveLearningSubject(client, principal, studentId);
      const studentPrincipal: PrincipalLike = { tenantId: principal.tenantId, userId: subject.userId, roles: ["student"] };
      const rows = (await client.query(
        `select run_id, config from science_v3_self_test_run
          where tenant_id=$1 and user_id=$2 and status='finished'
          order by created_at desc limit 30`,
        [principal.tenantId, subject.userId],
      )).rows as { run_id: string; config: RunConfig }[];
      // 取最近一份"整章报告"（round_no>=3 的最后一个 finished run）
      let lastId: string | null = null;
      for (const row of rows) {
        if ((row.config.round_no ?? 1) >= 3) { lastId = row.run_id; break; }
      }
      if (!lastId) return null;
      const stored = await this.loadRun(client, studentPrincipal, lastId);
      const { report, payload } = await this.buildReport(client, studentPrincipal, stored);
      return {
        report,
        report_payload: payload,
        runId: stored.run_id,
        round_no: stored.config.round_no ?? 1,
        student: { userId: subject.userId, displayName: subject.displayName },
      };
    });
  }

  /**
   * GET /api/learning/self-test/progress?thread_id=…
   * 前端 PickStep 在"新建一轮前"探测：下一轮序号（决定是否锁选题）+ 目标/时长 carry-over
   *（第 2 轮起沿用第 1 轮录入，锁定不再重填）。
   */
  async progress(principal: PrincipalLike, threadId: string): Promise<{
    next_round_no: number;
    has_active: boolean;
    total_points: number;
    untested_count: number;
    goal_score?: number | undefined;
    daily_minutes?: number | undefined;
  }> {
    if (!/^thr_[A-Za-z0-9]{8,}$/.test(threadId)) {
      throw new SelfTestError(422, "invalid_thread_id", "缺少有效的对话线程");
    }
    return withPrincipal(this.pool, principal, async (client) => {
      const active = (await client.query(
        `select run_id from science_v3_self_test_run
          where tenant_id=$1 and user_id=$2 and status='active' limit 1`,
        [principal.tenantId, principal.userId],
      )).rows[0] as { run_id: string } | undefined;
      const runs = await this.historyRuns(client, principal, threadId);
      const nextRoundNo = runs.length + 1;

      // 未测点数：知识树中可抽点（drawable>0）减去历史 run 已覆盖的知识点
      const tree = await loadKnowledgeTree(client, principal.tenantId, principal.userId);
      const testedIds = new Set<string>();
      for (const run of runs) for (const id of (run.config.knowledge_ids ?? [])) testedIds.add(id);
      const drawablePoints = tree.filter((t) => t.drawable > 0);
      const untestedCount = drawablePoints.filter((t) => !testedIds.has(t.knowledgeId)).length;

      // 沿用最新一轮已配置的目标/时长（第 1 轮即用户首次录入，此后锁定回显）
      const last = [...runs].reverse().find((r) =>
        r.config.goal_score !== undefined || r.config.daily_minutes !== undefined,
      );
      return {
        next_round_no: nextRoundNo,
        has_active: Boolean(active),
        total_points: drawablePoints.length,
        untested_count: untestedCount,
        ...(last?.config.goal_score !== undefined ? { goal_score: last.config.goal_score } : {}),
        ...(last?.config.daily_minutes !== undefined ? { daily_minutes: last.config.daily_minutes } : {}),
      };
    });
  }

  /** POST /api/learning/self-test/runs/:id/answers */
  async submitAnswer(
    principal: PrincipalLike,
    runId: string,
    input: { response: string; idempotency_key: string; suspect_question_error?: boolean },
  ): Promise<{
    duplicated?: boolean;
    verdict: string;
    expected: string[];
    analysis?: string | undefined;
    autoAudited?: boolean;
    run: RunView;
    report?: string | undefined;
    appended?: boolean | undefined;
  }> {
    const response = typeof input.response === "string" ? input.response.trim() : "";
    if (!response || response.length > 2000) throw new SelfTestError(422, "invalid_response", "答案需包含 1–2000 个字符");
    const idempotencyKey = String(input.idempotency_key ?? "");
    if (!/^[A-Za-z0-9:_-]{8,128}$/.test(idempotencyKey)) {
      throw new SelfTestError(422, "invalid_idempotency_key", "缺少有效的 Idempotency-Key");
    }

    return withPrincipal(this.pool, principal, async (client) => {
      const stored = await this.loadRun(client, principal, runId, true);
      if (stored.status !== "active") throw new SelfTestError(409, "run_not_active", "该轮测评已结束", stored.version);
      const current = stored.state.current_question;
      if (!current) throw new SelfTestError(409, "no_current_question", "当前没有待答题目", stored.version);

      // 幂等：同一键已提交 → 直接返回既成结果（不重复推进）
      const existed = (await client.query(
        `select verdict,auto_grade from science_v3_self_test_answer
          where tenant_id=$1 and idempotency_key=$2`,
        [principal.tenantId, idempotencyKey],
      )).rows[0] as { verdict: string; auto_grade: { expected: string[] } } | undefined;
      if (existed) {
        const runView = await this.runViewOf(client, principal, stored);
        return { duplicated: true, verdict: existed.verdict, expected: existed.auto_grade.expected, run: runView };
      }

      const material = await loadQuestionMaterial(client, principal.tenantId, current.revision_id);
      if (!material) throw new SelfTestError(500, "material_missing", "题目素材读取失败");
      const basis = await loadGradeBasis(client, principal.tenantId, current.revision_id);
      if (!basis) throw new SelfTestError(500, "grade_basis_missing", "题目答案缺失，无法判答");
      const graded = gradeResponse(response, basis, material.stemFormat);

      // 疑似题库答案有误 → 审计队列（学生显式标记 或 自动发现）
      const flagged = Boolean(input.suspect_question_error) || graded.suspicious;
      let autoAudited = false;
      if (flagged) {
        await client.query(
          `insert into science_v3_self_test_audit(
             audit_id,tenant_id,question_entity_id,question_revision_id,answer_text,
             student_response,context,status,created_by_user_id
           ) values ($1,$2,$3,$4,$5,$6,$7::jsonb,'pending',$8)`,
          [newId("sau"), principal.tenantId, material.questionEntityId, current.revision_id,
            graded.expected.join(" / ") || "（无登记答案）", response,
            JSON.stringify({
              run_id: runId,
              stem_format: material.stemFormat,
              stem: material.stemMarkdown.slice(0, 500),
              auto_grade: { verdict: graded.verdict, matched_via: graded.matchedVia, suspicious: graded.suspicious },
              flagged_by: graded.suspicious ? "auto" : "student",
            }),
            principal.userId],
        );
        autoAudited = true;
      }

      // 推进运行状态（顺序：记录作答 → 应用策略 → 出下一题/收尾）
      const runtime = stored.state.runtime;
      const sequence = runtime.answeredTotal + 1;
      const dimensionId = current.dimension_id;
      const step = applyAnswerStep(runtime, {
        dimensionId,
        correct: graded.verdict === "correct",
        format: material.stemFormat,
      });
      runtime.usedRevisions.push(current.revision_id);

      const insertAnswer = async () => {
        await client.query(
          `insert into science_v3_self_test_answer(
             answer_id,tenant_id,run_id,user_id,sequence,question_revision_id,dimension_id,
             stem_format,response_text,verdict,auto_grade,difficulty_served,independent,
             idempotency_key,submitted_at,fact_version
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,true,$13,now(),1)`,
          [newId("sta"), principal.tenantId, runId, principal.userId, sequence,
            current.revision_id, dimensionId, material.stemFormat, response, graded.verdict,
            JSON.stringify({ rule: graded.matchedVia ?? "none", expected: graded.expected }),
            material.difficulty, idempotencyKey],
        );
      };

      if (step.kind === "finished") {
        await insertAnswer();
        await client.query(
          `update science_v3_self_test_run
              set status='finished', finished_at=now(), version=version+1,
                  state=$2::jsonb, updated_at=now()
            where tenant_id=$1 and run_id=$3`,
          [principal.tenantId, JSON.stringify({ runtime, current_question: null }), runId],
        );
        const { report, appended, payload } = await this.finishAndReport(client, principal, stored, runtime);
        const runView = await this.runViewOf(client, principal, await this.loadRun(client, principal, runId));
        return {
          verdict: graded.verdict, expected: graded.expected,
          analysis: material.analysisMarkdown || undefined,
          autoAudited, report, appended, report_payload: payload, run: runView,
        };
      }

      // 分层抽下一题：从 nextSlot 所属层内（重点点排前）找难度匹配、未用过的题
      const meta = new Map(
        (await loadKnowledgeTree(client, principal.tenantId, principal.userId)).map((row) => [row.knowledgeId, row]),
      );
      const nextCandidate = await pickBySlot(
        client, principal, step.nextSlot, meta, stored.config.knowledge_ids,
        runtime.usedRevisions, material.stemFormat, runtime.dimServed,
      );
      if (!nextCandidate) {
        // 池意外耗尽：视同完成（防死循环）
        await insertAnswer();
        await client.query(
          `update science_v3_self_test_run
              set status='finished', finished_at=now(), version=version+1,
                  state=$2::jsonb, updated_at=now()
            where tenant_id=$1 and run_id=$3`,
          [principal.tenantId, JSON.stringify({ runtime, current_question: null }), runId],
        );
        const { report, appended, payload } = await this.finishAndReport(client, principal, stored, runtime);
        const runView = await this.runViewOf(client, principal, await this.loadRun(client, principal, runId));
        return {
          verdict: graded.verdict, expected: graded.expected,
          analysis: material.analysisMarkdown || undefined,
          autoAudited, report, appended, report_payload: payload, run: runView,
        };
      }
      runtime.dimServed[nextCandidate.dimensionId] = (runtime.dimServed[nextCandidate.dimensionId] ?? 0) + 1;
      const next: CurrentQuestion = {
        revision_id: nextCandidate.questionRevisionId,
        dimension_id: nextCandidate.dimensionId,
      };
      await insertAnswer();
      await client.query(
        `update science_v3_self_test_run
            set state=$2::jsonb, version=version+1, updated_at=now()
          where tenant_id=$1 and run_id=$3`,
        [principal.tenantId, JSON.stringify({ runtime, current_question: next }), runId],
      );
      const runView = await this.runViewOf(client, principal, await this.loadRun(client, principal, runId));
      return {
        verdict: graded.verdict, expected: graded.expected,
        analysis: material.analysisMarkdown || undefined,
        autoAudited, run: runView,
      };
    });
  }

  /** POST /api/learning/self-test/runs/:id/finish — 提前结束 / 汇总报告 */
  async finishRun(principal: PrincipalLike, runId: string): Promise<{ report: string; appended: boolean; report_payload?: unknown; run: RunView }> {
    return withPrincipal(this.pool, principal, async (client) => {
      const stored = await this.loadRun(client, principal, runId, true);
      if (stored.status !== "active") {
        const { report, payload } = await this.buildReport(client, principal, stored);
        return { report, appended: false, report_payload: payload, run: await this.runViewOf(client, principal, stored) };
      }
      await client.query(
        `update science_v3_self_test_run
            set status='finished', finished_at=now(), version=version+1,
                state=$2::jsonb, updated_at=now()
          where tenant_id=$1 and run_id=$3`,
        [principal.tenantId,
          JSON.stringify({ runtime: stored.state.runtime, current_question: null }), runId],
      );
      const { report, appended, payload } = await this.finishAndReport(client, principal, stored, stored.state.runtime);
      return {
        report, appended, report_payload: payload,
        run: await this.runViewOf(client, principal, await this.loadRun(client, principal, runId)),
      };
    });
  }

  /** POST /api/learning/self-test/audits — 学生手动上报「题目/题库答案疑似有误」 */
  async reportSuspect(
    principal: PrincipalLike,
    input: { question_revision_id: string; question_entity_id?: string; response: string; context?: Record<string, unknown> },
  ): Promise<{ audit_id: string }> {
    if (!/^qrev_[A-Za-z0-9_.:-]{4,}$/.test(input.question_revision_id)) {
      throw new SelfTestError(422, "invalid_question_revision", "题目编号不合法");
    }
    const response = typeof input.response === "string" ? input.response.trim() : "";
    if (!response) throw new SelfTestError(422, "invalid_response", "缺少作答内容");
    return withPrincipal(this.pool, principal, async (client) => {
      const basis = await loadGradeBasis(client, principal.tenantId, input.question_revision_id);
      const auditId = newId("sau");
      await client.query(
        `insert into science_v3_self_test_audit(
           audit_id,tenant_id,question_entity_id,question_revision_id,answer_text,
           student_response,context,status,created_by_user_id
         ) values ($1,$2,$3,$4,$5,$6,$7::jsonb,'pending',$8)`,
        [auditId, principal.tenantId,
          input.question_entity_id ?? "", input.question_revision_id,
          basis?.answerTexts.join(" / ") ?? "（无登记答案）", response,
          JSON.stringify(input.context ?? {}), principal.userId],
      );
      return { audit_id: auditId };
    });
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------
  private async loadRun(client: Client, principal: PrincipalLike, runId: string, forUpdate = false): Promise<StoredRun> {
    if (!/^str_[A-Za-z0-9]{8,}$/.test(runId)) throw new SelfTestError(404, "run_not_found", "测评不存在");
    const result = await client.query(
      `${RUN_SELECT} where tenant_id=$1 and user_id=$2 and run_id=$3 ${forUpdate ? "for update" : ""}`,
      [principal.tenantId, principal.userId, runId],
    );
    if (!result.rows[0]) throw new SelfTestError(404, "run_not_found", "测评不存在或不属于当前账号");
    return parseStoredRun(result.rows[0] as Record<string, unknown>);
  }

  private async runViewOf(client: Client, principal: PrincipalLike, stored: StoredRun): Promise<RunView> {
    const answers = await this.answersOf(client, principal, stored.run_id);
    const meta = new Map(
      (await loadKnowledgeTree(client, principal.tenantId, principal.userId)).map((row) => [row.knowledgeId, row]),
    );
    // 依赖维度 = config.knowledge_ids（重点点）∪ answers 实际出现的 dimension_id（含"填充"落到的非重点点）
    const dimIds: string[] = [];
    const seen = new Set<string>();
    for (const id of [...(stored.config.knowledge_ids ?? []), ...answers.map((a) => a.dimension_id)]) {
      if (!seen.has(id)) { seen.add(id); dimIds.push(id); }
    }
    const globalObs = answers.map((answer) => ({
      dimensionId: answer.dimension_id,
      correct: answer.verdict === "correct",
      format: answer.stem_format,
    }));
    const dimensions: DimensionSnapshot[] = [];
    for (const dimId of dimIds) {
      const node = meta.get(dimId);
      const own = answers.filter((answer) => answer.dimension_id === dimId);
      const replay = replayDimension(globalObs, dimId);
      const correctCount = own.filter((answer) => answer.verdict === "correct").length;
      dimensions.push({
        knowledgeId: dimId,
        name: node?.name ?? dimId,
        answered: own.length,
        correct: correctCount,
        accuracy: own.length ? Math.round((correctCount / own.length) * 1000) / 1000 : null,
        pMastery: replay.p,
        state: replay.state,
        transferEvidence: replay.transferEvidence,
      });
    }

    let question: RunViewQuestion | null = null;
    if (stored.status === "active" && stored.state.current_question) {
      const material = await loadQuestionMaterial(client, principal.tenantId, stored.state.current_question.revision_id);
      if (material) question = { ...material, index: stored.state.runtime.answeredTotal + 1 };
    }
    return {
      runId: stored.run_id,
      status: stored.status as RunView["status"],
      createdAt: stored.created_at.toISOString(),
      answeredTotal: stored.state.runtime.answeredTotal,
      questionCap: ROUND_SIZE,
      roundNo: stored.config.round_no ?? 1,
      ...(stored.config.goal_score !== undefined ? { goalScore: stored.config.goal_score } : {}),
      ...(stored.config.daily_minutes !== undefined ? { dailyMinutes: stored.config.daily_minutes } : {}),
      dimensions,
      question,
    };
  }

  private async answersOf(client: Client, principal: PrincipalLike, runId: string): Promise<AnswerRow[]> {
    const result = await client.query(
      `select sequence,question_revision_id,dimension_id,stem_format,response_text,verdict
         from science_v3_self_test_answer
        where tenant_id=$1 and run_id=$2 order by sequence`,
      [principal.tenantId, runId],
    );
    return result.rows as AnswerRow[];
  }

  /** 结束并生成文字消息；round<3 出 2 句轮小结，round≥3 出终版报告。
   *  报告追加为一条 assistant 消息（同一事务内，失败不阻断）。返回结构化 payload（供详情页）。 */
  private async finishAndReport(
    client: Client,
    principal: PrincipalLike,
    stored: StoredRun,
    _runtime: RuntimeState,
  ): Promise<{ report: string; appended: boolean; payload?: unknown }> {
    const { report, payload } = await this.buildReport(client, principal, stored);
    let appended = false;
    const threadId = stored.conversation_thread_id;
    if (threadId) {
      try {
        await client.query(
          `select * from mathpilot_science_v3_append_self_test_report($1,$2,$3,$4,$5::jsonb,now())`,
          [principal.tenantId, threadId, principal.userId, newId("msg"), JSON.stringify([{ type: "text", text: report }])],
        );
        appended = true;
      } catch (error) {
        console.error("self-test report append failed (thread may be archived)", error);
      }
    }
    return { report, appended, payload };
  }

  /** 同 thread 全部 finished run（含本轮），按 created_at 升序。用于跨轮聚合报告。 */
  private async historyRuns(
    client: Client,
    principal: PrincipalLike,
    threadId: string,
  ): Promise<{ run_id: string; round_no: number; config: RunConfig }[]> {
    const rows = (await client.query(
      `${RUN_SELECT} where tenant_id=$1 and user_id=$2 and conversation_thread_id=$3
        and status='finished' order by created_at asc`,
      [principal.tenantId, principal.userId, threadId],
    )).rows as Record<string, unknown>[];
    return rows.map((row) => ({
      run_id: String(row.run_id),
      round_no: (row.config as RunConfig).round_no ?? 1,
      config: row.config as RunConfig,
    }));
  }

  /** 构造 report.ts 所需的跨 run 聚合上下文。 */
  private async reportContext(
    client: Client,
    principal: PrincipalLike,
    stored: StoredRun,
  ): Promise<ReportContext> {
    const tree = await loadKnowledgeTree(client, principal.tenantId, principal.userId);
    const threadId = stored.conversation_thread_id ?? "";
    const runs = await this.historyRuns(client, principal, threadId);
    const runIdSet = new Set([...runs.map((r) => r.run_id), stored.run_id]);
    const ansRows = (await client.query(
      `select a.sequence,a.question_revision_id,a.dimension_id,a.stem_format,a.response_text,
              a.verdict,a.difficulty_served,r.run_id as run_id,r.created_at as created_at
         from science_v3_self_test_answer a
         join science_v3_self_test_run r on r.run_id = a.run_id
        where a.tenant_id=$1 and a.user_id=$2 and a.run_id = any($3::text[])`,
      [principal.tenantId, principal.userId, [...runIdSet]],
    )).rows as {
      sequence: number; question_revision_id: string; dimension_id: string; stem_format: string;
      response_text: string; verdict: string; difficulty_served: number; run_id: string; created_at: Date;
    }[];
    // 若当前 thread 无历史 run（首轮，极端场景），fallback 到本 run
    const orderedRuns = runs.length ? runs : [{ run_id: stored.run_id, round_no: stored.config.round_no ?? 1, config: stored.config }];
    const answers = ansRows.map((a) => ({
      runId: a.run_id,
      roundNo: orderedRuns.find((r) => r.run_id === a.run_id)?.round_no ?? 1,
      sequence: a.sequence,
      questionRevisionId: a.question_revision_id,
      dimensionId: a.dimension_id,
      stemFormat: a.stem_format,
      responseText: a.response_text,
      verdict: a.verdict === "correct" ? "correct" as const : "incorrect" as const,
      difficultyServed: a.difficulty_served,
    }));
    const ctx: ReportContext = {
      runs: orderedRuns.map((r) => ({
        runId: r.run_id, roundNo: r.round_no, status: "finished" as const,
        config: r.config as { knowledge_ids: string[]; chapter_name?: string; goal_score?: number; daily_minutes?: number; selected_by?: "user" | "system" },
      })),
      answers,
      tree,
      totalPoints: tree.length,
      ...(stored.config.goal_score !== undefined ? { goalScore: stored.config.goal_score } : {}),
      ...(stored.config.daily_minutes !== undefined ? { dailyMinutes: stored.config.daily_minutes } : {}),
    };
    return ctx;
  }

  private async buildReport(
    client: Client,
    principal: PrincipalLike,
    stored: StoredRun,
  ): Promise<{ report: string; payload?: unknown }> {
    const ctx = await this.reportContext(client, principal, stored);
    const roundNo = stored.config.round_no ?? 1;
    if (roundNo < 3) {
      // 轮小结（2 句）：不追加跨轮终版，仅当前轮掌握变化 + 薄弱
      return { report: roundSummaryLines(ctx).join("\n") };
    }
    const final = buildFinalReport(ctx);
    return { report: final.markdown, payload: final.payload };
  }
}

function stateLabelZh(state: MasteryState): string {
  switch (state) {
    case "mastered": return "已掌握";
    case "possibly_mastered": return "可能掌握";
    case "learning": return "学习中";
    case "weak": return "薄弱";
    default: return "证据不足";
  }
}

export function errorFromUnknown(error: unknown): SelfTestError | null {
  return error instanceof SelfTestError ? error : null;
}
