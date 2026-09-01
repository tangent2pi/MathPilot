import { createHash } from "node:crypto";
import { storageObjectReferenceSchema } from "@mathpilot/content-integrity";
import { canonicalJson } from "@mathpilot/content-integrity/node";
import type { CanonicalMessagePart, DomainUIPart } from "@mathpilot/contracts";
import type pg from "pg";
import type { Principal } from "../auth.ts";
import { withPrincipal } from "../lib.ts";
import { assertThreadAccess, ensureOwnStudent } from "../learning-read/acl.ts";
import { LearningReadError } from "../learning-read/cursor.ts";

const idempotencyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const threadPattern = /^thr_[A-Za-z0-9]{8,}$/;
const questionSessionPattern = /^qsn_[A-Za-z0-9]{8,}$/;
const judgmentPattern = /^jdg_[A-Za-z0-9]{8,}$/;
const annotationPattern = /^ann_[A-Za-z0-9]{8,}$/;
const operationPattern = /^op_[A-Za-z0-9]{8,}$/;

export class LearningCommandError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly currentVersion?: number) {
    super(message);
  }
}

const objectValue = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LearningCommandError(422, "invalid_command", "命令内容必须是对象");
  }
  return value as Record<string, unknown>;
};

const idempotencyKey = (header: unknown, body: Record<string, unknown>): string => {
  const value = typeof header === "string" && header ? header : body.idempotency_key;
  if (typeof value !== "string" || !idempotencyPattern.test(value)) {
    throw new LearningCommandError(422, "invalid_idempotency_key", "缺少有效的 Idempotency-Key");
  }
  return value;
};

const expectedVersion = (body: Record<string, unknown>): number => {
  if (!Number.isSafeInteger(body.expected_version) || Number(body.expected_version) < 0) {
    throw new LearningCommandError(422, "invalid_expected_version", "expected_version 必须是非负整数");
  }
  return Number(body.expected_version);
};

const requestedAt = (body: Record<string, unknown>): string => {
  const value = body.requested_at;
  if (value === undefined) return new Date().toISOString();
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new LearningCommandError(422, "invalid_requested_at", "requested_at 必须是 ISO 时间");
  }
  return new Date(value).toISOString();
};

const commandDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const deterministicId = (prefix: string, ...values: string[]): string =>
  `${prefix}_${createHash("sha256").update(values.join("\0")).digest("hex").slice(0, 24)}`;

interface UserMessagePartText { type: "text"; text: string }
interface UserMessagePartAttachment {
  type: "attachment"; attachment_ref: string; name: string; mime_type: string;
  version_id: string; sha256: string; byte_size: number;
}
type UserMessagePart = UserMessagePartText | UserMessagePartAttachment;

function parseMessageParts(value: unknown): UserMessagePart[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new LearningCommandError(422, "invalid_message", "消息必须包含 1–32 个文本或附件部分");
  }
  return value.map((part) => {
    const raw = objectValue(part);
    if (raw.type === "text") {
      if (typeof raw.text !== "string" || !raw.text.trim() || raw.text.length > 50_000
        || Object.keys(raw).some((key) => !["type", "text"].includes(key))) {
        throw new LearningCommandError(422, "invalid_message", "文本消息内容无效");
      }
      return { type: "text", text: raw.text };
    }
    if (raw.type === "attachment") {
      if (typeof raw.attachment_ref !== "string" || !storageObjectReferenceSchema.safeParse(raw.attachment_ref).success
        || typeof raw.name !== "string" || !raw.name || raw.name.length > 240
        || typeof raw.mime_type !== "string" || raw.mime_type.length < 3 || raw.mime_type.length > 160
        || typeof raw.version_id !== "string" || !raw.version_id || raw.version_id.length > 1024
        || typeof raw.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.sha256)
        || typeof raw.byte_size !== "number" || !Number.isSafeInteger(raw.byte_size)
        || raw.byte_size < 1 || raw.byte_size > 48*1024*1024
        || Object.keys(raw).some((key) => !["type", "attachment_ref", "name", "mime_type", "version_id", "sha256", "byte_size"].includes(key))) {
        throw new LearningCommandError(422, "invalid_attachment", "附件引用无效");
      }
      return {
        type:"attachment",attachment_ref:raw.attachment_ref,name:raw.name,mime_type:raw.mime_type,
        version_id:raw.version_id,sha256:raw.sha256,byte_size:raw.byte_size,
      };
    }
    throw new LearningCommandError(422, "invalid_message", "只支持文本和已上传附件");
  });
}

function firstText(parts: readonly UserMessagePart[]): string | undefined {
  return parts.find((part): part is UserMessagePartText => part.type === "text")?.text.trim();
}

export class LearningCommandService {
  constructor(private readonly pool: pg.Pool) {}

  async createThread(principal: Principal, value: unknown, headerKey: unknown) {
    const body = objectValue(value ?? {});
    const key = idempotencyKey(headerKey, body);
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "新对话";
    if (title.length > 120) throw new LearningCommandError(422, "invalid_title", "对话标题不能超过 120 个字符");
    return withPrincipal(this.pool, principal, async (client) => {
      const subject = await ensureOwnStudent(client, principal);
      const threadId = deterministicId("thr", principal.tenantId, principal.userId, key);
      const existing = (await client.query<{ title: string; status: string; version: string; created_at: Date | string }>(
        `select title,status,version,created_at from science_v3_conversation_thread
          where tenant_id=$1 and conversation_thread_id=$2`,
        [principal.tenantId, threadId],
      )).rows[0];
      if (existing) {
        if (existing.title !== title) throw new LearningCommandError(409, "idempotency_conflict", "该幂等键已用于另一条创建命令");
        return { created: false, thread: { thread_id: threadId, title: existing.title, status: existing.status, version: Number(existing.version), created_at: new Date(existing.created_at).toISOString() } };
      }
      const row = (await client.query<{ created_at: Date | string }>(
        `insert into science_v3_conversation_thread(
           conversation_thread_id,tenant_id,student_id,title,status,next_message_sequence,version
         ) values($1,$2,$3,$4,'active',1,1) returning created_at`,
        [threadId, principal.tenantId, subject.studentId, title],
      )).rows[0]!;
      return { created: true, thread: { thread_id: threadId, title, status: "active", version: 1, created_at: new Date(row.created_at).toISOString() } };
    });
  }

  async renameThread(principal: Principal, threadId: string, value: unknown, headerKey: unknown) {
    if (!threadPattern.test(threadId)) throw new LearningCommandError(404, "thread_not_found", "对话不存在");
    const body = objectValue(value);
    idempotencyKey(headerKey, body);
    const version = expectedVersion(body);
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title || title.length > 120) throw new LearningCommandError(422, "invalid_title", "对话标题需包含 1–120 个字符");
    return withPrincipal(this.pool, principal, async (client) => {
      const subject = await assertThreadAccess(client, principal, threadId, true);
      if (subject.threadTitle === title) return { thread_id: threadId, title, status: subject.threadStatus, version: subject.threadVersion };
      if (subject.threadVersion !== version) throw new LearningCommandError(409, "version_conflict", `当前对话版本为 ${subject.threadVersion}`, subject.threadVersion);
      const row = (await client.query<{ version: string; status: string }>(
        `update science_v3_conversation_thread
            set title=$3,updated_at=clock_timestamp(),version=version+1
          where tenant_id=$1 and conversation_thread_id=$2 and version=$4
        returning version,status`,
        [principal.tenantId, threadId, title, version],
      )).rows[0];
      if (!row) throw new LearningCommandError(409, "version_conflict", "对话已在其他设备更新");
      return { thread_id: threadId, title, status: row.status, version: Number(row.version) };
    });
  }

  async archiveThread(principal: Principal, threadId: string, value: unknown, headerKey: unknown) {
    if (!threadPattern.test(threadId)) throw new LearningCommandError(404, "thread_not_found", "对话不存在");
    const body = objectValue(value);
    idempotencyKey(headerKey, body);
    const version = expectedVersion(body);
    return withPrincipal(this.pool, principal, async (client) => {
      const subject = await assertThreadAccess(client, principal, threadId, true);
      if (subject.threadStatus === "archived") return { thread_id: threadId, title: subject.threadTitle, status: "archived", version: subject.threadVersion };
      if (subject.threadVersion !== version) throw new LearningCommandError(409, "version_conflict", `当前对话版本为 ${subject.threadVersion}`, subject.threadVersion);
      const row = (await client.query<{ version: string }>(
        `update science_v3_conversation_thread
            set status='archived',updated_at=clock_timestamp(),version=version+1
          where tenant_id=$1 and conversation_thread_id=$2 and version=$3
        returning version`,
        [principal.tenantId, threadId, version],
      )).rows[0];
      if (!row) throw new LearningCommandError(409, "version_conflict", "对话已在其他设备更新");
      return { thread_id: threadId, title: subject.threadTitle, status: "archived", version: Number(row.version) };
    });
  }

  async submitForegroundMessage(principal: Principal, threadId: string, value: unknown, headerKey: unknown) {
    if (!threadPattern.test(threadId)) throw new LearningCommandError(404, "thread_not_found", "对话不存在");
    const body = objectValue(value);
    const key = idempotencyKey(headerKey, body);
    const version = expectedVersion(body);
    const submittedAt = requestedAt(body);
    const parts = parseMessageParts(body.parts);
    const command = { schema_version: 3, command_type: "send_message", idempotency_key: key, expected_version: version, requested_at: submittedAt, conversation_thread_id: threadId, parts };
    const commandSha256 = commandDigest(command);
    return withPrincipal(this.pool, principal, async (client) => {
      const thread = await assertThreadAccess(client, principal, threadId, true);
      if (thread.threadStatus !== "active") throw new LearningCommandError(409, "thread_archived", "对话已归档");
      const existing = (await client.query<{
        foreground_request_id: string; operation_id: string; triggering_message_id: string;
        foreground_epoch_id: string; command_sha256: string;
      }>(
        `select foreground_request_id,operation_id,triggering_message_id,foreground_epoch_id,command_sha256
           from science_v3_foreground_request where tenant_id=$1 and idempotency_key=$2`,
        [principal.tenantId, key],
      )).rows[0];
      if (existing) {
        if (existing.command_sha256 !== commandSha256) {
          throw new LearningCommandError(409, "idempotency_conflict", "该幂等键已用于另一条消息命令");
        }
        return {
          accepted: true, created: false, foreground_request_id: existing.foreground_request_id,
          operation_id: existing.operation_id, message_id: existing.triggering_message_id,
          foreground_epoch_id: existing.foreground_epoch_id, thread_version: thread.threadVersion,
        };
      }
      if (thread.threadVersion !== version) {
        throw new LearningCommandError(409, "version_conflict", `当前对话版本为 ${thread.threadVersion}`, thread.threadVersion);
      }
      await client.query(
        `select 1 from science_v3_conversation_thread
          where tenant_id=$1 and conversation_thread_id=$2 for update`,
        [principal.tenantId, threadId],
      );
      const activeEpoch = (await client.query<{ foreground_epoch_id: string; active_question_session_id: string | null }>(
        `select foreground_epoch_id,active_question_session_id from science_v3_foreground_agent_epoch
          where tenant_id=$1 and conversation_thread_id=$2 and ended_at is null`,
        [principal.tenantId, threadId],
      )).rows[0];
      const requestId = deterministicId("fgr", principal.tenantId, principal.userId, key);
      const operationId = deterministicId("op", principal.tenantId, principal.userId, key, "foreground");
      const eventId = deterministicId("evt", principal.tenantId, principal.userId, key, "foreground");
      const artifactId = deterministicId("art", principal.tenantId, principal.userId, key, "foreground-input");
      const messageId = deterministicId("msg", principal.tenantId, principal.userId, key);
      const epochId = activeEpoch?.foreground_epoch_id ?? deterministicId("fge", principal.tenantId, threadId, key);
      const input = {
        schema_version: 3,
        request_id: requestId,
        conversation_thread_id: threadId,
        foreground_epoch_id: epochId,
        student_id: thread.studentId,
        triggering_message_id: messageId,
        ...(activeEpoch?.active_question_session_id
          ? { active_question_session_id: activeEpoch.active_question_session_id } : {}),
        submitted_at: submittedAt,
        message_parts: parts,
        history_is_untrusted_data: true,
      };
      const inputArtifact=canonicalJson(input);
      const result = (await client.query<{
        foreground_request_id: string; operation_id: string; canonical_message_id: string;
        foreground_epoch_id: string; thread_version: string; created: boolean;
      }>(
        `select * from mathpilot_science_v3_submit_foreground_message(
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16
        )`,
        [principal.tenantId, principal.userId, requestId, operationId, eventId, artifactId,
          messageId, epochId, threadId, key, commandSha256, version,
          JSON.stringify(parts), inputArtifact.json, inputArtifact.sha256, submittedAt],
      )).rows[0]!;
      let threadVersion = Number(result.thread_version);
      const titleText = firstText(parts);
      if (result.created && thread.threadTitle === "新对话" && titleText) {
        const title = titleText.replace(/\s+/g, " ").slice(0, 42);
        const renamed = (await client.query<{ version: string }>(
          `update science_v3_conversation_thread
              set title=$3,updated_at=clock_timestamp(),version=version+1
            where tenant_id=$1 and conversation_thread_id=$2 and title='新对话'
          returning version`,
          [principal.tenantId, threadId, title],
        )).rows[0];
        if (renamed) threadVersion = Number(renamed.version);
      }
      return {
        accepted: true, created: result.created, foreground_request_id: result.foreground_request_id,
        operation_id: result.operation_id, message_id: result.canonical_message_id,
        foreground_epoch_id: result.foreground_epoch_id, thread_version: threadVersion,
      };
    });
  }

  async submitAttempt(principal: Principal, questionSessionId: string, value: unknown, headerKey: unknown) {
    if (!questionSessionPattern.test(questionSessionId)) throw new LearningCommandError(404, "question_session_not_found", "题目会话不存在");
    const body = objectValue(value);
    const key = idempotencyKey(headerKey, body);
    const version = expectedVersion(body);
    const submittedAt = requestedAt(body);
    const kind = typeof body.attempt_kind === "string" ? body.attempt_kind : "answer";
    if (!new Set(["answer", "probe", "correction", "explanation"]).has(kind)) throw new LearningCommandError(422, "invalid_attempt_kind", "回答类型无效");
    const responseParts = parseResponseParts(body.response_parts);
    return withPrincipal(this.pool, principal, async (client) => {
      const session = (await client.query<{
        conversation_thread_id: string; student_id: string; question_revision_id: string | null;
        lifecycle: string; version: string;
      }>(
        `select conversation_thread_id,student_id,question_revision_id,lifecycle,version
           from science_v3_question_session where tenant_id=$1 and question_session_id=$2`,
        [principal.tenantId, questionSessionId],
      )).rows[0];
      if (!session) throw new LearningCommandError(404, "question_session_not_found", "题目会话不存在");
      const thread = await assertThreadAccess(client, principal, session.conversation_thread_id, true);
      if (thread.studentId !== session.student_id) throw new LearningCommandError(404, "question_session_not_found", "题目会话不存在");
      if (!session.question_revision_id) throw new LearningCommandError(409, "teaching_only_question", "这道外部题可以继续讲解，但当前不能作为正式答题证据提交");
      const attemptId = deterministicId("att", principal.tenantId, principal.userId, key);
      const operationId = deterministicId("op", principal.tenantId, principal.userId, key, "attempt");
      const messageId = deterministicId("msg", principal.tenantId, principal.userId, key, "attempt-receipt");
      const summary = responseSummary(responseParts);
      const part: DomainUIPart = {
        schema: "mathpilot.message-part/domain-ui/v1",
        part_id: deterministicId("part", principal.tenantId, attemptId, "receipt"),
        view_kind: "answer_receipt",
        resource_ref: `attempt:${attemptId}`,
        resource_version: 1,
        snapshot: {
          schema: "mathpilot.view/answer_receipt/v1",
          title: "你的回答",
          summary: `${summary}，已提交。`,
          data: { attempt_id: attemptId, response_parts: responseParts },
        },
        action_slots: [],
        occurred_at: submittedAt,
        origin: "domain_projector",
        domain_event_ref: `event://attempt-recorded/${attemptId}`,
      };
      const canonicalParts: CanonicalMessagePart[] = [{ type: "domain_ui", part }];
      const refs = responseParts.map((_part, index) => `answer://${attemptId}/part/${index + 1}`);
      const result = (await client.query<{
        command_operation_id: string; admitted_attempt_id: string | null; canonical_message_id: string | null;
        session_version: string; result_status: string; rejection_code: string | null;
      }>(
        `select * from mathpilot_science_v3_submit_attempt(
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::text[],$14,$15
        )`,
        [principal.tenantId, principal.userId, operationId, key, attemptId, messageId,
          session.conversation_thread_id, questionSessionId, version, session.question_revision_id,
          kind, JSON.stringify(canonicalParts), refs, 0, submittedAt],
      )).rows[0]!;
      if (result.result_status === "rejected") {
        throw new LearningCommandError(409, result.rejection_code ?? "attempt_rejected", "本次回答未被接纳，请刷新题目状态", Number(result.session_version));
      }
      return {
        created: result.result_status === "committed",
        operation: { operation_id: result.command_operation_id, status: "succeeded", user_message: "答案已提交" },
        attempt: { attempt_id: result.admitted_attempt_id, message_id: result.canonical_message_id, question_session_id: questionSessionId },
        question_session_version: Number(result.session_version),
      };
    });
  }

  async requestCut(principal: Principal, questionSessionId: string, value: unknown, headerKey: unknown) {
    if (!questionSessionPattern.test(questionSessionId)) throw new LearningCommandError(404, "question_session_not_found", "题目会话不存在");
    const body = objectValue(value);
    const key = idempotencyKey(headerKey, body);
    const version = expectedVersion(body);
    const at = requestedAt(body);
    const reason = typeof body.reason === "string" ? body.reason : "student_switch";
    if (!new Set(["completed", "student_switch", "skipped", "teacher_switch", "system_policy", "abandoned"]).has(reason)) {
      throw new LearningCommandError(422, "invalid_cut_reason", "切题原因无效");
    }
    return withPrincipal(this.pool, principal, async (client) => {
      const session = (await client.query<{ conversation_thread_id: string; student_id: string; version: string }>(
        `select conversation_thread_id,student_id,version from science_v3_question_session
          where tenant_id=$1 and question_session_id=$2`,
        [principal.tenantId, questionSessionId],
      )).rows[0];
      if (!session) throw new LearningCommandError(404, "question_session_not_found", "题目会话不存在");
      const thread = await assertThreadAccess(client, principal, session.conversation_thread_id, true);
      if (thread.studentId !== session.student_id) throw new LearningCommandError(404, "question_session_not_found", "题目会话不存在");
      const operationId = deterministicId("op", principal.tenantId, principal.userId, key, "cut");
      const cutId = deterministicId("cut", principal.tenantId, principal.userId, key);
      const eventId = deterministicId("evt", principal.tenantId, principal.userId, key, "cut");
      const artifactId = deterministicId("art", principal.tenantId, principal.userId, key, "cut-input");
      const payload = {
        schema_version: 3,
        cut_request_ref: `cut-request:${cutId}`,
        question_session_ref: `question-session:${questionSessionId}`,
        reason,
        requested_at: at,
      };
      const inputArtifact=canonicalJson(payload);
      const result = (await client.query<{
        command_operation_id: string; accepted_cut_request_id: string | null; session_version: string;
        result_status: string; rejection_code: string | null;
      }>(
        `select * from mathpilot_science_v3_request_cut(
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15
        )`,
        [principal.tenantId, principal.userId, operationId, key, cutId, eventId, artifactId,
          session.conversation_thread_id, questionSessionId, version, reason, null,
          inputArtifact.json, inputArtifact.sha256, at],
      )).rows[0]!;
      if (result.result_status === "rejected") throw new LearningCommandError(409, result.rejection_code ?? "cut_rejected", "当前题目状态已变化", Number(result.session_version));
      return {
        accepted: true,
        operation: { operation_id: result.command_operation_id, status: "accepted", user_message: "正在保存本题记录" },
        cut_request_id: result.accepted_cut_request_id,
        question_session_version: Number(result.session_version),
      };
    });
  }

  async teacherCorrectJudgment(principal: Principal, judgmentId: string, value: unknown, headerKey: unknown) {
    if (!judgmentPattern.test(judgmentId)) throw new LearningCommandError(404, "judgment_not_found", "判定不存在");
    if (!principal.roles.includes("teacher")) throw new LearningCommandError(403, "teacher_role_required", "当前账号不是教师账号");
    const body = objectValue(value);
    const key = idempotencyKey(headerKey, body);
    const version = expectedVersion(body);
    const at = requestedAt(body);
    const verdict = typeof body.verdict === "string" ? body.verdict : "";
    if (!new Set(["correct", "partially_correct", "incorrect", "unresolved"]).has(verdict)) {
      throw new LearningCommandError(422, "invalid_verdict", "更正后的判定结果无效");
    }
    const summary = typeof body.decision_summary === "string" ? body.decision_summary.trim() : "";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!summary || summary.length > 2000) throw new LearningCommandError(422, "invalid_summary", "判定说明需包含 1–2000 个字符");
    if (!reason || reason.length > 2000) throw new LearningCommandError(422, "invalid_reason", "更正原因需包含 1–2000 个字符");

    return withPrincipal(this.pool, principal, async (client) => {
      const target = (await client.query<{
        attempt_id: string; rubric_results: unknown; dimension_proposals: unknown;
        uncertainty: string; evidence_refs: string[]; fact_version: string;
        question_session_id: string; conversation_thread_id: string; student_id: string;
        lifecycle: string; superseded_by: string | null;
      }>(
        `select judgment.attempt_id,judgment.rubric_results,judgment.dimension_proposals,
                judgment.uncertainty,judgment.evidence_refs,judgment.fact_version,
                session.question_session_id,session.conversation_thread_id,session.student_id,session.lifecycle,
                (select newer.judgment_id from science_v3_judgment newer
                  where newer.tenant_id=judgment.tenant_id
                    and newer.supersedes_judgment_id=judgment.judgment_id
                  order by newer.fact_version desc limit 1) superseded_by
           from science_v3_judgment judgment
           join science_v3_attempt attempt
             on attempt.tenant_id=judgment.tenant_id and attempt.attempt_id=judgment.attempt_id
           join science_v3_question_session session
             on session.tenant_id=attempt.tenant_id and session.question_session_id=attempt.question_session_id
          where judgment.tenant_id=$1 and judgment.judgment_id=$2`,
        [principal.tenantId, judgmentId],
      )).rows[0];
      if (!target) throw new LearningCommandError(404, "judgment_not_found", "判定不存在");
      const subject = await assertThreadAccess(client, principal, target.conversation_thread_id);
      if (subject.actorMode !== "teacher" || subject.studentId !== target.student_id) {
        throw new LearningCommandError(404, "judgment_not_found", "判定不存在");
      }

      const existing = (await client.query<{
        teacher_user_id: string; teacher_correction_id: string; operation_id: string;
        target_judgment_id: string; replacement_judgment_id: string; reason: string;
        fact_version: string; verdict: string; decision_summary: string;
      }>(
        `select correction.teacher_user_id,correction.teacher_correction_id,correction.operation_id,
                correction.target_judgment_id,correction.replacement_judgment_id,correction.reason,
                correction.fact_version,replacement.verdict,replacement.decision_summary
           from science_v3_teacher_correction correction
           join science_v3_judgment replacement
             on replacement.tenant_id=correction.tenant_id
            and replacement.judgment_id=correction.replacement_judgment_id
          where correction.tenant_id=$1 and correction.idempotency_key=$2`,
        [principal.tenantId, key],
      )).rows[0];
      if (existing) {
        if (existing.teacher_user_id !== principal.userId || existing.target_judgment_id !== judgmentId
          || existing.verdict !== verdict || existing.decision_summary !== summary || existing.reason !== reason) {
          throw new LearningCommandError(409, "idempotency_conflict", "该幂等键已用于另一条教师纠正");
        }
        return {
          accepted: true, created: false,
          teacher_correction_id: existing.teacher_correction_id,
          replacement_judgment_id: existing.replacement_judgment_id,
          aggregate_version: Number(existing.fact_version),
          operation: { operation_id: existing.operation_id, status: "accepted", user_message: "教师纠正已记录，正在重放科学状态" },
        };
      }
      if (target.superseded_by) throw new LearningCommandError(409, "judgment_superseded", "该判定后来已被更正");
      if (!new Set(["closed", "abandoned"]).has(target.lifecycle)) {
        throw new LearningCommandError(409, "question_not_closed", "题目结束后才能提交教师纠正");
      }
      if (Number(target.fact_version) !== version) {
        throw new LearningCommandError(409, "version_conflict", `当前判定版本为 ${target.fact_version}`, Number(target.fact_version));
      }

      const correctionId = deterministicId("tcor", principal.tenantId, principal.userId, key);
      const replacementId = deterministicId("jdg", principal.tenantId, principal.userId, key, "replacement");
      const operationId = deterministicId("op", principal.tenantId, principal.userId, key, "teacher-correction");
      const eventId = deterministicId("evt", principal.tenantId, principal.userId, key, "teacher-correction");
      const result = (await client.query<{
        operation_id: string; teacher_correction_id: string; aggregate_version: string; status: string;
      }>(
        `select * from mathpilot_science_v3_record_teacher_correction(
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14::text[],$15,$16
        )`,
        [principal.tenantId, correctionId, operationId, eventId, key, principal.userId,
          judgmentId, replacementId, verdict, JSON.stringify(target.rubric_results),
          JSON.stringify(target.dimension_proposals), target.uncertainty, summary,
          target.evidence_refs, reason, at],
      )).rows[0]!;
      return {
        accepted: true, created: true,
        teacher_correction_id: result.teacher_correction_id,
        replacement_judgment_id: replacementId,
        aggregate_version: Number(result.aggregate_version),
        operation: { operation_id: result.operation_id, status: result.status, user_message: "教师纠正已记录，正在重放科学状态" },
      };
    });
  }

  async annotationFeedback(principal: Principal, annotationId: string, value: unknown, headerKey: unknown) {
    if (!annotationPattern.test(annotationId)) throw new LearningCommandError(404, "annotation_not_found", "学习观察不存在");
    const body = objectValue(value);
    const key = idempotencyKey(headerKey, body);
    const version = expectedVersion(body);
    const at = requestedAt(body);
    const feedback = typeof body.feedback === "string" ? body.feedback : "";
    const mapped = ({ helpful: "accurate", inaccurate: "inaccurate", not_relevant: "not_useful" } as Record<string, string>)[feedback];
    if (!mapped) throw new LearningCommandError(422, "invalid_feedback", "反馈类型无效");
    const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : undefined;
    if (note && note.length > 2000) throw new LearningCommandError(422, "invalid_note", "反馈说明不能超过 2000 个字符");
    return withPrincipal(this.pool, principal, async (client) => {
      const subject = await ensureOwnStudent(client, principal);
      const annotation = (await client.query<{ student_id: string; set_version: string }>(
        `select student_id,set_version from science_v3_semantic_annotation
          where tenant_id=$1 and annotation_id=$2`,
        [principal.tenantId, annotationId],
      )).rows[0];
      if (!annotation || annotation.student_id !== subject.studentId) throw new LearningCommandError(404, "annotation_not_found", "学习观察不存在");
      if (Number(annotation.set_version) !== version) throw new LearningCommandError(409, "version_conflict", `当前学习观察版本为 ${annotation.set_version}`, Number(annotation.set_version));
      const feedbackId = deterministicId("afb", principal.tenantId, principal.userId, key);
      const existing = (await client.query<{ feedback: string; note: string | null; created_at: Date | string }>(
        `select feedback,note,created_at from science_v3_annotation_feedback
          where tenant_id=$1 and annotation_feedback_id=$2`,
        [principal.tenantId, feedbackId],
      )).rows[0];
      if (existing) {
        if (existing.feedback !== mapped || (existing.note ?? undefined) !== note) throw new LearningCommandError(409, "idempotency_conflict", "该幂等键已用于另一条反馈");
        return { created: false, feedback_id: feedbackId, annotation_id: annotationId, created_at: new Date(existing.created_at).toISOString() };
      }
      const operationId = deterministicId("op", principal.tenantId, principal.userId, key, "annotation-feedback");
      await client.query(
        `insert into science_v3_operation(operation_id,tenant_id,requested_by_user_id,kind,status,user_message,related_resource_refs)
         values($1,$2,$3,'annotation_feedback','accepted','正在记录你的反馈',array[$4])`,
        [operationId, principal.tenantId, principal.userId, `annotation:${annotationId}`],
      );
      await client.query(
        `update science_v3_operation set status='running',updated_at=clock_timestamp(),version=version+1
          where tenant_id=$1 and operation_id=$2`, [principal.tenantId, operationId],
      );
      await client.query(
        `insert into science_v3_annotation_feedback(
          annotation_feedback_id,tenant_id,student_id,annotation_id,actor_user_id,feedback,note,created_at
        ) values($1,$2,$3,$4,$5,$6,$7,$8)`,
        [feedbackId, principal.tenantId, subject.studentId, annotationId, principal.userId, mapped, note ?? null, at],
      );
      await client.query(
        `insert into science_v3_operation_result(
          tenant_id,operation_id,idempotency_key,result_status,aggregate_ref,aggregate_version,result_resource_refs
        ) values($1,$2,$3,'committed',$4,$5,array[$6])`,
        [principal.tenantId, operationId, key, `annotation:${annotationId}`, version, `annotation-feedback:${feedbackId}`],
      );
      await client.query(
        `update science_v3_operation
            set status='succeeded',user_message='反馈已记录',retryable=false,
                related_resource_refs=array[$3],updated_at=clock_timestamp(),version=version+1
          where tenant_id=$1 and operation_id=$2`,
        [principal.tenantId, operationId, `annotation-feedback:${feedbackId}`],
      );
      return { created: true, feedback_id: feedbackId, annotation_id: annotationId, operation_id: operationId, created_at: at };
    });
  }

  async setContextPreference(principal: Principal, value: unknown, headerKey: unknown) {
    const body = objectValue(value);
    const key = idempotencyKey(headerKey, body);
    expectedVersion(body);
    const at = requestedAt(body);
    if (typeof body.personalization_enabled !== "boolean") throw new LearningCommandError(422, "invalid_preference", "personalization_enabled 必须是布尔值");
    const annotationId = body.annotation_id;
    if (annotationId !== undefined && (typeof annotationId !== "string" || !annotationPattern.test(annotationId))) {
      throw new LearningCommandError(422, "invalid_annotation", "annotation_id 无效");
    }
    return withPrincipal(this.pool, principal, async (client) => {
      const subject = await ensureOwnStudent(client, principal);
      if (typeof annotationId === "string") {
        const owns = (await client.query(
          `select 1 from science_v3_semantic_annotation
            where tenant_id=$1 and student_id=$2 and annotation_id=$3`,
          [principal.tenantId, subject.studentId, annotationId],
        )).rowCount;
        if (!owns) throw new LearningCommandError(404, "annotation_not_found", "学习观察不存在");
      }
      const preferenceId = deterministicId("aup", principal.tenantId, principal.userId, key);
      const existing = (await client.query<{ enabled: boolean; annotation_id: string | null; created_at: Date | string }>(
        `select enabled,annotation_id,created_at from science_v3_annotation_usage_preference_event
          where tenant_id=$1 and preference_event_id=$2`,
        [principal.tenantId, preferenceId],
      )).rows[0];
      if (existing) {
        if (existing.enabled !== body.personalization_enabled || (existing.annotation_id ?? undefined) !== annotationId) {
          throw new LearningCommandError(409, "idempotency_conflict", "该幂等键已用于另一条偏好设置");
        }
        return { created: false, preference_event_id: preferenceId, created_at: new Date(existing.created_at).toISOString() };
      }
      await client.query(
        `insert into science_v3_annotation_usage_preference_event(
          preference_event_id,tenant_id,student_id,actor_user_id,annotation_id,enabled,reason,created_at
        ) values($1,$2,$3,$4,$5,$6,$7,$8)`,
        [preferenceId, principal.tenantId, subject.studentId, principal.userId,
          annotationId ?? null, body.personalization_enabled,
          body.personalization_enabled ? "学生恢复用于个性化" : "学生暂停用于个性化", at],
      );
      return { created: true, preference_event_id: preferenceId, annotation_id: annotationId ?? null, enabled: body.personalization_enabled, created_at: at };
    });
  }

  async cancelOperation(principal: Principal, operationId: string, value: unknown, headerKey: unknown) {
    if (!operationPattern.test(operationId)) throw new LearningCommandError(404, "operation_not_found", "操作不存在");
    const body = objectValue(value);
    idempotencyKey(headerKey, body);
    const version = expectedVersion(body);
    return withPrincipal(this.pool, principal, async (client) => {
      const operation = (await client.query<{ requested_by_user_id: string; status: string; version: string }>(
        `select requested_by_user_id,status,version from science_v3_operation
          where tenant_id=$1 and operation_id=$2 for update`,
        [principal.tenantId, operationId],
      )).rows[0];
      if (!operation || operation.requested_by_user_id !== principal.userId) throw new LearningCommandError(404, "operation_not_found", "操作不存在");
      if (operation.status === "cancelled") return { operation_id: operationId, status: "cancelled", version: Number(operation.version) };
      if (!["accepted", "running", "needs_input"].includes(operation.status)) throw new LearningCommandError(409, "operation_terminal", "该操作已经结束");
      if (Number(operation.version) !== version) throw new LearningCommandError(409, "version_conflict", `当前操作版本为 ${operation.version}`, Number(operation.version));
      const row = (await client.query<{ version: string }>(
        `update science_v3_operation
            set status='cancelled',user_message='操作已取消',retryable=false,
                updated_at=clock_timestamp(),version=version+1
          where tenant_id=$1 and operation_id=$2 and version=$3
        returning version`,
        [principal.tenantId, operationId, version],
      )).rows[0];
      await client.query(
        `update science_v3_foreground_request
            set status='cancelled',completed_at=clock_timestamp(),updated_at=clock_timestamp()
          where tenant_id=$1 and operation_id=$2 and status in ('queued','running')`,
        [principal.tenantId, operationId],
      );
      return { operation_id: operationId, status: "cancelled", version: Number(row!.version) };
    });
  }
}

interface ResponseTextPart { type: "text"; text: string }
interface ResponseContentRefPart { type: "content_ref"; content_ref: string }
type ResponsePart = ResponseTextPart | ResponseContentRefPart;

function parseResponseParts(value: unknown): ResponsePart[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new LearningCommandError(422, "invalid_response", "回答必须包含 1–32 个部分");
  }
  return value.map((part) => {
    const raw = objectValue(part);
    if (raw.type === "text" && typeof raw.text === "string" && raw.text.trim() && raw.text.length <= 20_000
      && Object.keys(raw).every((key) => ["type", "text"].includes(key))) {
      return { type: "text", text: raw.text };
    }
    if (raw.type === "content_ref" && typeof raw.content_ref === "string"
      && /^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/.test(raw.content_ref)
      && Object.keys(raw).every((key) => ["type", "content_ref"].includes(key))) {
      return { type: "content_ref", content_ref: raw.content_ref };
    }
    throw new LearningCommandError(422, "invalid_response", "回答部分无效");
  });
}

function responseSummary(parts: readonly ResponsePart[]): string {
  const text = parts.map((part) => part.type === "text" ? part.text : "已附内容").join("、").replace(/\s+/g, " ");
  return text.length > 240 ? `${text.slice(0, 237)}…` : text;
}

export function commandErrorFromUnknown(error: unknown): LearningCommandError | LearningReadError | undefined {
  if (error instanceof LearningCommandError || error instanceof LearningReadError) return error;
  const pgError = error as { code?: string; message?: string };
  if (pgError.code === "23505") return new LearningCommandError(409, "conflict", "该操作已被提交");
  if (pgError.code === "23514" || pgError.code === "22P02") return new LearningCommandError(422, "invalid_command", "命令不符合当前资源约束");
  if (pgError.code === "P0001") {
    const message = pgError.message ?? "领域命令未被接纳";
    if (message.includes("version conflict")) return new LearningCommandError(409, "version_conflict", "资源版本已变化，请刷新后重试");
    if (message.includes("idempotency")) return new LearningCommandError(409, "idempotency_conflict", "幂等键已用于另一项命令");
    return new LearningCommandError(409, "domain_conflict", "命令与当前领域状态冲突");
  }
  return undefined;
}
