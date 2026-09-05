import { createHash } from "node:crypto";
import type pg from "pg";
import { SelfTestError, SelfTestService, type PrincipalLike } from "./service.ts";
import { withPrincipal } from "./lib.ts";
import { loadGradeBasis } from "./content.ts";

export interface AssessmentAction {
  action: "inspect" | "start" | "resume" | "cancel" | "commit_judgment" | "next" | "finish";
  knowledge_ids?: string[];
  chapter_name?: string;
  goal_score?: number;
  daily_minutes?: number;
  expected_version?: number;
  question_revision_id?: string;
  verdict?: "correct" | "incorrect";
  rationale?: string;
  independent?: boolean;
  evidence_message_ids?: string[];
  suspect_question_error?: boolean;
}

/** Called only by the authenticated foreground tool host; no HTTP judgment input. */
export async function performAssessment(pool: pg.Pool, binding: {
  principal: PrincipalLike; operationId: string; agentAttemptId: string;
}, action: AssessmentAction): Promise<unknown> {
  const { principal } = binding;
  const context = await withPrincipal(pool, principal, async (client) => {
    const row = (await client.query<{ conversation_thread_id: string; triggering_message_id: string; sequence: string }>(
      `select f.conversation_thread_id,f.triggering_message_id,m.sequence
       from science_v3_foreground_request f
       join science_v3_agent_attempt a on a.tenant_id=f.tenant_id and a.operation_id=f.operation_id
       join science_v3_student s on s.tenant_id=f.tenant_id and s.student_id=f.student_id
       join science_v3_conversation_thread t on t.tenant_id=f.tenant_id and t.conversation_thread_id=f.conversation_thread_id
       join science_v3_canonical_message m on m.tenant_id=f.tenant_id and m.message_id=f.triggering_message_id
       where f.tenant_id=$1 and f.operation_id=$2 and a.agent_attempt_id=$3 and s.user_id=$4
         and f.status='running' and a.status='started' and a.task_type='foreground_teaching'
         and t.status='active' and t.deleted_at is null`,
      [principal.tenantId, binding.operationId, binding.agentAttemptId, principal.userId],
    )).rows[0];
    if (!row) throw new SelfTestError(403, "foreground_unavailable", "当前对话任务已结束或无权操作测评");
    return row;
  });
  const service = new SelfTestService(pool);
  const stored = await withPrincipal(pool, principal, async (client) => (await client.query<{
    run_id: string; status: string; conversation_thread_id: string;
    state: { current_question: { revision_id: string } | null; presented_after_sequence?: number; evidence_thread_id?: string };
  }>(`select run_id,status,conversation_thread_id,state from science_v3_self_test_run where tenant_id=$1 and user_id=$2
      and (status='active' or conversation_thread_id=$3 or state->>'evidence_thread_id'=$3)
      order by (status='active') desc,created_at desc limit 1`, [principal.tenantId, principal.userId, context.conversation_thread_id])).rows[0]);
  const needsResume = stored?.status === "active"
    && (stored.state.evidence_thread_id ?? stored.conversation_thread_id) !== context.conversation_thread_id;
  if (action.action === "inspect") {
    const run = stored ? (await service.getRun(principal, stored.run_id)).run : null;
    const details = await withPrincipal(pool, principal, async (client) => {
      const messages = (await client.query(`select message_id,sequence,parts from science_v3_canonical_message
        where tenant_id=$1 and conversation_thread_id=$2 and author_kind='student' and author_user_id=$3
          and sequence>$4 and sequence<=$5 order by sequence desc limit 12`,
        [principal.tenantId, context.conversation_thread_id, principal.userId,
          needsResume ? Number(context.sequence) : stored?.state.presented_after_sequence ?? 0, Number(context.sequence)])).rows;
      const reference = run?.question ? await loadGradeBasis(client, principal.tenantId, run.question.questionRevisionId) : null;
      return { student_messages: messages.reverse(), reference_for_grading: reference };
    });
    return { run, needs_resume: needsResume, ...details, knowledge_tree: await service.knowledgeTree(principal, action.chapter_name),
      instructions: "这是该学生跨对话的活动测评。needs_resume 时询问继续旧测评还是终止；继续则 resume 并重新展示题目等待新作答，终止则 cancel。目标不明确先追问，不要擅自选知识点。参考答案勿提前泄露。" };
  }
  if (action.action === "start") {
    if (stored) {
      const current = await service.getRun(principal, stored.run_id);
      if (current.run.status === "active") return { ...current, needs_resume: needsResume,
        next_action: needsResume ? "ask_resume_or_cancel" : "continue" };
    }
    return service.createRun(principal, { ...action, thread_id: context.conversation_thread_id,
      request_key: `${binding.operationId}:assessment:start` });
  }
  if (!stored) throw new SelfTestError(409, "assessment_not_started", "请先 start 测评");
  if (!Number.isSafeInteger(action.expected_version)) throw new SelfTestError(422, "version_required", "先 inspect 获取当前 version");
  if (action.action === "cancel") return service.cancelRun(principal, stored.run_id, action.expected_version!);
  if (action.action === "resume") return service.resumeRun(principal, stored.run_id, context.conversation_thread_id, action.expected_version!);
  if (action.action === "finish") return service.finishRun(principal, stored.run_id, false, action.expected_version);
  if (needsResume) throw new SelfTestError(409, "assessment_resume_required", "请先确认继续旧测评并 resume，或 cancel 终止；无需等待后台清理");
  if (action.action === "next") return service.nextQuestion(principal, stored.run_id, action.expected_version!);
  if (action.action !== "commit_judgment" || !action.question_revision_id || !action.verdict
    || !action.rationale || typeof action.independent !== "boolean" || !action.evidence_message_ids?.length) {
    throw new SelfTestError(422, "judgment_required", "判答需要当前题目、判定、理由、独立性和作答消息引用");
  }
  // The response text comes from stored student messages, never model-invented answers.
  const response = await withPrincipal(pool, principal, async (client) => {
    const rows = (await client.query<{ parts: Array<{ type: string; text?: string }> }>(
      `select parts from science_v3_canonical_message where tenant_id=$1 and conversation_thread_id=$2
       and author_kind='student' and author_user_id=$3 and message_id=any($4::text[]) order by sequence`,
      [principal.tenantId, context.conversation_thread_id, principal.userId, action.evidence_message_ids],
    )).rows;
    return rows.flatMap((row) => row.parts.map((part) => part.type === "text" ? part.text ?? "" : "[学生附件，见证据消息]")).join("\n").slice(0, 2000);
  });
  const key = createHash("sha256").update(`${stored.run_id}:${action.question_revision_id}:${action.evidence_message_ids.join(":")}`).digest("hex");
  return service.commitJudgment(principal, stored.run_id, {
    ...action, question_revision_id: action.question_revision_id, expected_version: action.expected_version!,
    verdict: action.verdict, rationale: action.rationale, independent: action.independent,
    evidence_message_ids: action.evidence_message_ids, response, idempotency_key: `agent:${key}`,
    agent_attempt_id: binding.agentAttemptId, max_evidence_sequence: Number(context.sequence),
  });
}
