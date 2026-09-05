// 自我测评（self-test）API 客户端与契约类型。
// 服务端挂在 /api/learning/self-test/*（api-next，与 learning 同域）。
// 错误格式与 learning client 一致：application/problem+json → SelfTestApiError。
import { newIdempotencyKey } from "./client";

export type SelfTestFormat = "single_choice" | "fill_blank";

export type MasteryState =
  | "insufficient_evidence"
  | "weak"
  | "learning"
  | "possibly_mastered"
  | "mastered";

export interface KnowledgePoint {
  knowledgeId: string; // K_*
  name: string;
  gradeBand: string | null; // 一级（章节）
  moduleName: string | null; // 二级（模块）
  difficulty: number | null;
  masteryStandard: string | null;
  remediationAdvice: string | null;
  drawable: number; // 可抽题数（选择/填空、带答案、学生可见）
  formats: string[];
}

export interface ModuleGroup {
  moduleName: string;
  knowledgePoints: KnowledgePoint[];
}

export interface ChapterGroup {
  chapterName: string;
  modules: ModuleGroup[];
}

export interface KnowledgeTreeView {
  chapters: ChapterGroup[];
}

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

export interface SelfTestQuestion {
  questionEntityId: string;
  questionRevisionId: string;
  stemFormat: SelfTestFormat;
  difficulty: number;
  stemMarkdown: string;
  analysisMarkdown: string;
  options: { key: string; text: string }[]; // 不含 is_correct，判答只在服务端
  knowledgeIds: string[];
  index: number; // 1-based
}

export interface RunView {
  version: number;
  threadId: string;
  runId: string;
  status: "active" | "finished" | "cancelled";
  createdAt: string;
  answeredTotal: number;
  questionCap: number;
  roundNo: number;
  goalScore?: number;
  dailyMinutes?: number;
  dimensions: DimensionSnapshot[];
  question: SelfTestQuestion | null;
}

export interface SubmitAnswerResult {
  duplicated?: boolean;
  verdict: "correct" | "incorrect";
  expected: string[];
  analysis?: string;
  autoAudited?: boolean;
  run: RunView;
  report?: string;
  appended?: boolean;
  report_payload?: ReportPayload;
}

export interface FinishResult {
  report: string;
  appended: boolean;
  run: RunView;
  report_payload?: ReportPayload;
}

/** GET /report/latest —— 重取最近一份整章报告（独立"查看报告"入口）。 */
export interface LatestReportResult {
  report: string;
  report_payload?: ReportPayload;
  runId: string;
  round_no: number;
}

/** GET /teacher/report?student_id= —— 教师读取其名下学生的整章测评报告。 */
export interface TeacherReportResult {
  report: string;
  report_payload?: ReportPayload;
  runId: string;
  round_no: number;
  student: { userId: string; displayName: string };
}

// --- 自我测评 v2 终版报告结构化 payload（对应后端 report.ts FinalReportPayload）---
export interface ReportRadarDimension {
  dimension: string;
  score: number | null;
}

export interface ReportPoint {
  id: string;
  name: string;
  state: MasteryState;
  pMastery: number;
  answered: number;
  tested: boolean;
}

export interface ReportLearningWeek {
  week: number;
  theme: string;
  dailyTasks: string[];
  passLine: string;
}

export interface ReportTrendPoint {
  round: number;
  mastery: number | null;
}

export interface ReportChapter {
  chapterName: string;
  mastery: number | null;
  verdict: string;
  risk: string;
  riskScore: number;
  weakest: string | null;
  coveragePct: number;
  weaknessPct: number;
  goalScore?: number;
  gap?: number | null;
  rounds: number;
  totalAnswered: number;
  totalPoints: number;
}

export interface ReportPayload {
  chapter: ReportChapter;
  round_no: number;
  radar: ReportRadarDimension[];
  points: ReportPoint[];
  risks: string[];
  plan: ReportLearningWeek[];
  trend: ReportTrendPoint[];
}

export interface SelfTestProgress {
  next_round_no: number;
  has_active: boolean;
  total_points: number;
  untested_count: number;
  goal_score?: number;
  daily_minutes?: number;
}

export class SelfTestApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

interface ProblemDetails {
  title?: string;
  error?: string;
  code?: string;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => ({})) as ProblemDetails;
    throw new SelfTestApiError(
      problem.title || problem.error || `请求失败（${response.status}）`,
      response.status,
      problem.code,
    );
  }
  return response.json() as Promise<T>;
}

function postInit(key: string, body: Record<string, unknown>): RequestInit {
  return {
    method: "POST",
    headers: { "idempotency-key": key },
    body: JSON.stringify({ ...body, idempotency_key: key }),
  };
}

export interface CreateRunInput {
  thread_id?: string;
  knowledge_ids?: string[];
  chapter_name?: string;
  quick?: "low" | "medium" | "high";
  difficulty_1_5?: number;
  goal_score?: number;
  daily_minutes?: number;
}

export const selfTestApi = {
  profile: () => requestJson<{ profile: null | {
    runId: string; threadId: string; status: string; round_no: number;
    provisional: boolean; report_payload: ReportPayload;
  } }>("/api/learning/self-test/profile"),
  /** 章节 → 模块 → 知识点（仅可抽） */
  knowledgeTree: (chapter?: string) => {
    const suffix = chapter ? `?chapter=${encodeURIComponent(chapter)}` : "";
    return requestJson<KnowledgeTreeView>(
      `/api/learning/self-test/knowledge-tree${suffix}`,
    );
  },

  /** 进行中的一轮（续测/单例提示）；无则 run=null */
  currentRun: () =>
    requestJson<{ run: RunView | null }>("/api/learning/self-test/current"),

  /** 轮进度：下一轮序号 + 目标/时长 carry-over（决定是否锁选题 / 回显已填表单） */
  progress: (threadId: string) =>
    requestJson<SelfTestProgress>(
      `/api/learning/self-test/progress?thread_id=${encodeURIComponent(threadId)}`,
    ),

  /** 建一轮。thread_id 缺省由服务端自建对话线程并在响应中返回。 */
  createRun: (input: CreateRunInput) => {
    const key = newIdempotencyKey("self-test-run");
    const body: Record<string, unknown> = {};
    if (input.knowledge_ids?.length) body.knowledge_ids = input.knowledge_ids;
    if (input.thread_id) body.thread_id = input.thread_id;
    if (input.chapter_name) body.chapter_name = input.chapter_name;
    if (input.quick) body.quick = input.quick;
    if (input.difficulty_1_5 !== undefined) body.difficulty_1_5 = input.difficulty_1_5;
    if (input.goal_score !== undefined) body.goal_score = input.goal_score;
    if (input.daily_minutes !== undefined) body.daily_minutes = input.daily_minutes;
    return requestJson<{ run: RunView; thread_id?: string }>(
      "/api/learning/self-test/runs",
      postInit(key, body),
    );
  },

  getRun: (runId: string) =>
    requestJson<{ run: RunView }>(
      `/api/learning/self-test/runs/${encodeURIComponent(runId)}`,
    ),

  /** 作答。response：选择题传 option key，填空题传文本。 */
  submitAnswer: (
    runId: string,
    input: { response: string; suspect_question_error?: boolean },
    key = newIdempotencyKey("self-test-answer"),
  ) => {
    const body: Record<string, unknown> = { response: input.response };
    if (input.suspect_question_error) body.suspect_question_error = true;
    return requestJson<SubmitAnswerResult>(
      `/api/learning/self-test/runs/${encodeURIComponent(runId)}/answers`,
      postInit(key, body),
    );
  },

  /** 提前结束并出报告（报告追加为当前对话 assistant 消息） */
  finishRun: (runId: string) => {
    const key = newIdempotencyKey("self-test-finish");
    return requestJson<FinishResult>(
      `/api/learning/self-test/runs/${encodeURIComponent(runId)}/finish`,
      postInit(key, {}),
    );
  },

  /** 重取最近一份整章报告（第 3 轮起有值）；无则抛 SelfTestApiError(404 no_report)。 */
  latestReport: (threadId: string) =>
    requestJson<LatestReportResult>(
      `/api/learning/self-test/report/latest?thread_id=${encodeURIComponent(threadId)}`,
    ),

  /** 教师读取其名下学生的最近一份整章测评报告；无则抛 SelfTestApiError(404 no_report)。 */
  teacherReport: (studentId: string) =>
    requestJson<TeacherReportResult>(
      `/api/learning/self-test/teacher/report?student_id=${encodeURIComponent(studentId)}`,
    ),

  /** 手动上报「此题答案疑似有误」到题库勘误队列 */
  reportSuspect: (input: {
    question_revision_id: string;
    response: string;
    question_entity_id?: string;
    context?: Record<string, unknown>;
  }) => {
    const key = newIdempotencyKey("self-test-audit");
    return requestJson<{ audit_id: string }>(
      "/api/learning/self-test/audits",
      postInit(key, input),
    );
  },
};
