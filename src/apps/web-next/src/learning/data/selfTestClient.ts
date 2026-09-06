// 学习记录页读取测评报告；测评操作由对话 Agent 推进。
export type MasteryState =
  | "insufficient_evidence"
  | "weak"
  | "learning"
  | "possibly_mastered"
  | "mastered";

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

export const selfTestApi = {
  studentReport: () => requestJson<Omit<TeacherReportResult, "student">>("/api/learning/self-test/report"),
  teacherReport: (studentId: string) =>
    requestJson<TeacherReportResult>(
      `/api/learning/self-test/teacher/report?student_id=${encodeURIComponent(studentId)}`,
    ),
};
