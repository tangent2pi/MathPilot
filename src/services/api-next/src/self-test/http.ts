// self-test 域：HTTP 路由（挂在 /api/learning/self-test/* 与 /api/learning/self-test/knowledge-tree）。
// 校验风格与 learning-http.ts 一致：手工字段校验 + application/problem+json + Idempotency-Key。
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type { Principal } from "../auth.ts";
import { SelfTestError, SelfTestService, errorFromUnknown } from "./service.ts";

type PrincipalResolver = (request: FastifyRequest, reply: FastifyReply) => Promise<Principal | null>;

const query = (request: FastifyRequest): Record<string, unknown> =>
  request.query && typeof request.query === "object" ? request.query as Record<string, unknown> : {};
const params = (request: FastifyRequest): Record<string, string> => request.params as Record<string, string>;
const body = (request: FastifyRequest): Record<string, unknown> =>
  request.body && typeof request.body === "object" && !Array.isArray(request.body)
    ? request.body as Record<string, unknown> : {};

function problem(reply: FastifyReply, error: unknown) {
  const known = errorFromUnknown(error);
  if (known) {
    return reply.code(known.status).type("application/problem+json").send({
      type: `https://mathpilot.dev/problems/${known.code}`,
      title: known.message,
      status: known.status,
      code: known.code,
      ...(known.currentVersion !== undefined ? { current_version: known.currentVersion } : {}),
    });
  }
  throw error;
}

export function registerSelfTestHttp(
  app: FastifyInstance,
  pool: pg.Pool,
  principalOf: PrincipalResolver,
): void {
  const service = new SelfTestService(pool);

  app.get("/api/learning/self-test/profile", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try { return reply.send(await service.profile(principal)); }
    catch (error) { return problem(reply, error); }
  });

  // 知识树（章节→模块→知识点，只看可抽）
  app.get("/api/learning/self-test/knowledge-tree", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try {
      const chapter = typeof query(request).chapter === "string" ? query(request).chapter as string : undefined;
      return reply.send(await service.knowledgeTree(principal, chapter));
    } catch (error) { return problem(reply, error); }
  });

  // 进行中的一轮（续测/单例提示）
  app.get("/api/learning/self-test/current", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try { return reply.send(await service.currentRun(principal)); }
    catch (error) { return problem(reply, error); }
  });

  // 轮进度（下一轮序号 + 目标/时长 carry-over），供前端决定是否锁选题
  app.get("/api/learning/self-test/progress", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try {
      const threadId = typeof query(request).thread_id === "string" ? query(request).thread_id as string : "";
      return reply.send(await service.progress(principal, threadId));
    } catch (error) { return problem(reply, error); }
  });

  // 重取最近一份整章报告（第 3 轮起）——独立"查看报告"入口的数据源
  app.get("/api/learning/self-test/report/latest", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try {
      const threadId = typeof query(request).thread_id === "string" ? query(request).thread_id as string : "";
      const latest = await service.latestReport(principal, threadId);
      if (!latest) return reply.code(404).type("application/problem+json").send({
        type: "https://mathpilot.dev/problems/no_report", title: "该线程还没有整章测评报告", status: 404, code: "no_report",
      });
      return reply.send(latest);
    } catch (error) { return problem(reply, error); }
  });

  // 教师读取其名下学生最近一份整章测评报告（鉴权见 service.teacherStudentReport）
  app.get("/api/learning/self-test/teacher/report", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try {
      const studentId = typeof query(request).student_id === "string" ? query(request).student_id as string : "";
      const latest = await service.teacherStudentReport(principal, studentId);
      if (!latest) return reply.code(404).type("application/problem+json").send({
        type: "https://mathpilot.dev/problems/no_report", title: "该学生还没有整章测评报告", status: 404, code: "no_report",
      });
      return reply.send(latest);
    } catch (error) { return problem(reply, error); }
  });

  // Mutations now belong to the authenticated conversational Agent tool.
  app.post("/api/learning/self-test/runs", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    return problem(reply, new SelfTestError(409, "assessment_agent_required", "请在对话中开始测评或提交作答，由数学智元判答并推进"));
  });

  // 单轮视图（含进度/维度 BKT 状态/当前题）
  app.get("/api/learning/self-test/runs/:runId", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try { return reply.send(await service.getRun(principal, params(request).runId!)); }
    catch (error) { return problem(reply, error); }
  });

  // Mutations now belong to the authenticated conversational Agent tool.
  app.post("/api/learning/self-test/runs/:runId/answers", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    return problem(reply, new SelfTestError(409, "assessment_agent_required", "请在对话中开始测评或提交作答，由数学智元判答并推进"));
  });

  app.post("/api/learning/self-test/runs/:runId/finish", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    return problem(reply, new SelfTestError(409, "assessment_agent_required", "请在对话中要求结束测评"));
  });

  app.post("/api/learning/self-test/audits", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    try {
      const raw = body(request);
      const input: {
        question_revision_id: string;
        question_entity_id?: string;
        response: string;
        context?: Record<string, unknown>;
      } = {
        question_revision_id: typeof raw.question_revision_id === "string" ? raw.question_revision_id : "",
        response: typeof raw.response === "string" ? raw.response : "",
      };
      if (typeof raw.question_entity_id === "string") input.question_entity_id = raw.question_entity_id;
      if (typeof raw.context === "object" && raw.context !== null) {
        input.context = raw.context as Record<string, unknown>;
      }
      const result = await service.reportSuspect(principal, input);
      return reply.code(201).send(result);
    } catch (error) { return problem(reply, error); }
  });
}
