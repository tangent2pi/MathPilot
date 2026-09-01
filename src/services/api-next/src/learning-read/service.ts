import type {
  CanonicalMessage,
  CommandCapability,
  LearningThreadMessage,
  LearningView,
} from "@mathpilot/contracts";
import type pg from "pg";
import type { Principal } from "../auth.ts";
import { withPrincipal } from "../lib.ts";
import { assertThreadAccess, resolveLearningSubject, type LearningSubject } from "./acl.ts";
import { decodeCursor, encodeCursor, evidenceHandle, LearningReadError, parseEvidenceHandle } from "./cursor.ts";
import { materializeTeachingArtifacts, teachingArtifactKey } from "./teaching-artifacts.ts";
import { capability, learningView } from "./view.ts";

const asIso = (value: Date | string | null | undefined): string | undefined =>
  value === null || value === undefined ? undefined : new Date(value).toISOString();
const asNumber = (value: string | number | null | undefined, fallback = 0): number => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};
const maxDate = (...values: Array<Date | string | null | undefined>): string | undefined => {
  const times = values.map((value) => value ? new Date(value).getTime() : Number.NaN).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : undefined;
};
const actorPermissions = (subject: LearningSubject): string[] => subject.actorMode === "teacher"
  ? ["learning.read.student", "learning.read.scientific_detail", "learning.submit_correction"]
  : ["learning.read.self", "learning.command.self"];

interface ThreadRow {
  conversation_thread_id: string;
  title: string;
  status: "active" | "archived";
  version: string;
  created_at: Date | string;
  updated_at: Date | string;
  last_message_summary: string | null;
}

interface MessageRow {
  message_id: string;
  conversation_thread_id: string;
  sequence: string;
  author_kind: "student" | "assistant" | "system";
  lifecycle: CanonicalMessage["lifecycle"];
  parts: CanonicalMessage["parts"];
  reply_to_message_id: string | null;
  question_session_id: string | null;
  editable: boolean;
  lock_reason: string | null;
  created_at: Date | string;
  version: string;
}

interface OperationRow {
  operation_id: string;
  kind: string;
  status: string;
  user_message: string;
  related_resource_refs: string[];
  retryable: boolean;
  started_at: Date | string;
  updated_at: Date | string;
  version: string;
}

export class LearningReadService {
  constructor(private readonly pool: pg.Pool) {}

  async listTeacherStudents(principal: Principal): Promise<LearningView> {
    if (!principal.roles.includes("teacher")) throw new LearningReadError(403, "teacher_role_required", "当前账号不是教师账号");
    return withPrincipal(this.pool, principal, async (client) => {
      const rows = (await client.query<{
        student_id: string; display_name: string; class_names: string[]; created_at: Date | string;
      }>(
        `select student.student_id,identity.display_name,
                array_agg(distinct class.name order by class.name) as class_names,
                min(student.created_at) as created_at
           from identity_class_user teacher
           join identity_class class
             on class.tenant_id=teacher.tenant_id and class.class_id=teacher.class_id and class.status='active'
           join identity_class_user learner
             on learner.tenant_id=teacher.tenant_id and learner.class_id=teacher.class_id
            and learner.class_role='student' and learner.status='active'
           join science_v3_student student
             on student.tenant_id=learner.tenant_id and student.user_id=learner.user_id
           join identity_user identity
             on identity.tenant_id=student.tenant_id and identity.user_id=student.user_id
          where teacher.tenant_id=$1 and teacher.user_id=$2
            and teacher.class_role='teacher' and teacher.status='active'
          group by student.student_id,identity.display_name
          order by identity.display_name,student.student_id`,
        [principal.tenantId, principal.userId],
      )).rows;
      return learningView({
        kind: "learning_overview", resourceKind: "teacher-student-list", resourceId: principal.userId,
        version: Math.max(1, rows.length), factsThrough: maxDate(...rows.map((row) => row.created_at)),
        permissions: ["learning.read.student"], data: { students: rows.map((row) => ({
          student_handle: row.student_id, display_name: row.display_name, class_names: row.class_names,
        })) },
      });
    });
  }

  async listThreads(principal: Principal): Promise<LearningView> {
    return withPrincipal(this.pool, principal, async (client) => {
      const subject = await resolveLearningSubject(client, principal);
      const rows = (await client.query<ThreadRow>(
        `select thread.conversation_thread_id,thread.title,thread.status,thread.version,
                thread.created_at,thread.updated_at,
                (select case
                   when part->>'type'='text' then left(part->>'text',120)
                   when part->>'type'='domain_ui' then left(part#>>'{part,snapshot,summary}',120)
                   when part->>'type'='attachment' then '附件：' || coalesce(part->>'name','文件')
                   else null end
                   from science_v3_canonical_message message
                   cross join lateral jsonb_array_elements(message.parts) part
                  where message.tenant_id=thread.tenant_id
                    and message.conversation_thread_id=thread.conversation_thread_id
                  order by message.sequence desc limit 1) as last_message_summary
           from science_v3_conversation_thread thread
          where thread.tenant_id=$1 and thread.student_id=$2
          order by (thread.status='active') desc,thread.updated_at desc`,
        [principal.tenantId, subject.studentId],
      )).rows;
      const version = rows.reduce((value, row) => Math.max(value, Number(row.version)), 1);
      return learningView({
        kind: "thread_list", resourceKind: "student-threads", resourceId: subject.studentId,
        version, factsThrough: maxDate(...rows.map((row) => row.updated_at)), permissions: actorPermissions(subject),
        data: { threads: rows.map((row) => ({
          thread_id: row.conversation_thread_id, title: row.title, status: row.status,
          version: Number(row.version), created_at: asIso(row.created_at), updated_at: asIso(row.updated_at),
          last_message_summary: row.last_message_summary,
        })) },
        capabilities: subject.actorMode === "self" ? [capability("create_thread", "/api/learning/threads", 0)] : [],
      });
    });
  }

  async threadMessages(principal: Principal, threadId: string, afterValue: unknown): Promise<LearningView> {
    const after = decodeCursor(afterValue);
    return withPrincipal(this.pool, principal, async (client) => {
      const subject = await assertThreadAccess(client, principal, threadId);
      const rows = (await client.query<MessageRow>(
        `select message_id,conversation_thread_id,sequence,author_kind,lifecycle,parts,
                reply_to_message_id,question_session_id,editable,lock_reason,created_at,version
           from science_v3_canonical_message
          where tenant_id=$1 and conversation_thread_id=$2 and sequence>$3
          order by sequence limit 101`,
        [principal.tenantId, threadId, after],
      )).rows;
      const hasMore = rows.length > 100;
      const page = rows.slice(0, 100);
      const artifactPresentations = await materializeTeachingArtifacts(client, {
        tenantId: principal.tenantId,
        threadId,
        studentId: subject.studentId,
        studentUserId: subject.userId,
      }, page);
      const operations = await this.threadOperations(client, principal.tenantId, threadId);
      const messages: LearningThreadMessage[] = page.map((row) => ({
        schema_version: 3,
        message_id: row.message_id,
        conversation_thread_id: row.conversation_thread_id,
        sequence: Number(row.sequence),
        author_kind: row.author_kind,
        lifecycle: row.lifecycle,
        parts: row.parts.map((part) => {
          if (part.type !== "teaching_artifact") return part;
          const artifact = artifactPresentations.get(teachingArtifactKey(row.message_id, part.artifact_ref));
          if (!artifact || artifact.summary !== part.summary || artifact.schema !== part.artifact_schema) return part;
          return { ...part, presentation: artifact.presentation };
        }),
        ...(row.reply_to_message_id ? { reply_to_message_id: row.reply_to_message_id } : {}),
        ...(row.question_session_id ? { question_session_id: row.question_session_id } : {}),
        editable: row.editable,
        ...(row.lock_reason ? { lock_reason: row.lock_reason } : {}),
        created_at: new Date(row.created_at).toISOString(),
        version: Number(row.version),
        action_capabilities: [],
      }));
      const lastSequence = messages.at(-1)?.sequence ?? after;
      const sendDisabled = subject.threadStatus !== "active" ? "对话已归档" : undefined;
      return learningView({
        kind: "thread_messages", resourceKind: "conversation-thread", resourceId: threadId,
        version: subject.threadVersion,
        factsThrough: maxDate(...page.map((row) => row.created_at), ...operations.map((row) => row.updated_at)),
        permissions: actorPermissions(subject),
        data: {
          thread: { id: threadId, title: subject.threadTitle, status: subject.threadStatus, version: subject.threadVersion },
          messages,
          operations: operations.map(operationViewData),
          next_cursor: encodeCursor(lastSequence),
          has_more: hasMore,
        },
        capabilities: subject.actorMode === "self"
          ? [capability("send_message", `/api/learning/threads/${threadId}/messages`, subject.threadVersion, sendDisabled)]
          : [],
      });
    });
  }

  async threadContext(principal: Principal, threadId: string): Promise<LearningView> {
    return withPrincipal(this.pool, principal, async (client) => {
      const subject = await assertThreadAccess(client, principal, threadId);
      const currentQuestion = (await client.query<{
        question_session_id: string; question_revision_id: string | null; source: string;
        lifecycle: string; version: string; opened_at: Date | string; stem_markdown: string | null;
      }>(
        `select session.question_session_id,session.question_revision_id,session.source,
                session.lifecycle,session.version,session.opened_at,question.stem_markdown
           from science_v3_question_session session
           left join content_question_revision question
             on question.tenant_id=session.tenant_id and question.revision_id=session.question_revision_id
          where session.tenant_id=$1 and session.conversation_thread_id=$2
            and session.lifecycle in ('active','finalizing')
          order by session.opened_at desc limit 1`,
        [principal.tenantId, threadId],
      )).rows[0];
      const intent = (await client.query<{
        selection_intent_id: string; revision: string; natural_language_request: string; created_at: Date | string;
      }>(
        `select selection_intent_id,revision,natural_language_request,created_at
           from science_v3_selection_intent
          where tenant_id=$1 and conversation_thread_id=$2 order by revision desc limit 1`,
        [principal.tenantId, threadId],
      )).rows[0];
      const activity = (await client.query(
        `select learning_activity_id,goal,source,policy,status,version,created_at
           from science_v3_learning_activity
          where tenant_id=$1 and student_id=$2 and status in ('active','paused')
          order by created_at desc limit 1`,
        [principal.tenantId, subject.studentId],
      )).rows[0];
      const annotations = (await client.query<{
        annotation_id: string; claim: string; target_kind: string; target_ref: string;
        set_version: string; created_at: Date | string;
      }>(
        `select annotation.annotation_id,annotation.claim,annotation.target_kind,annotation.target_ref,
                annotation.set_version,annotation.created_at
           from science_v3_semantic_annotation annotation
          where annotation.tenant_id=$1 and annotation.student_id=$2
            and not exists(select 1 from science_v3_annotation_supersession supersession
                            where supersession.tenant_id=annotation.tenant_id
                              and supersession.superseded_annotation_id=annotation.annotation_id)
            and not exists(select 1 from science_v3_annotation_stale_fact stale
                            where stale.tenant_id=annotation.tenant_id and stale.annotation_id=annotation.annotation_id)
            and coalesce((select preference.enabled from science_v3_annotation_usage_preference_event preference
                           where preference.tenant_id=annotation.tenant_id
                             and preference.student_id=annotation.student_id
                             and preference.annotation_id=annotation.annotation_id
                           order by preference.created_at desc,preference.preference_event_id desc limit 1),true)
            and coalesce((select preference.enabled from science_v3_annotation_usage_preference_event preference
                           where preference.tenant_id=annotation.tenant_id
                             and preference.student_id=annotation.student_id and preference.annotation_id is null
                           order by preference.created_at desc,preference.preference_event_id desc limit 1),true)
          order by annotation.set_version desc,annotation.created_at desc limit 3`,
        [principal.tenantId, subject.studentId],
      )).rows;
      const operations = await this.threadOperations(client, principal.tenantId, threadId);
      const contextManifest = (await client.query<{
        workspace_manifest: unknown;
        requested_at: Date | string;
        manifest_recorded_at: Date | string;
      }>(
        `select attempt.workspace_manifest,request.requested_at,
                attempt.started_at as manifest_recorded_at
           from science_v3_foreground_request request
           join lateral (
             select candidate.workspace_manifest,candidate.started_at
               from science_v3_agent_attempt candidate
              where candidate.tenant_id=request.tenant_id
                and candidate.operation_id=request.operation_id
                and candidate.task_type='foreground_teaching'
                and candidate.workspace_manifest is not null
              order by candidate.temporal_attempt desc,candidate.started_at desc
              limit 1
           ) attempt on true
          where request.tenant_id=$1 and request.conversation_thread_id=$2
          order by request.requested_at desc limit 1`,
        [principal.tenantId, threadId],
      )).rows[0];
      const capabilities: CommandCapability[] = [];
      if (subject.actorMode === "self" && subject.threadStatus === "active") {
        capabilities.push(capability("send_message", `/api/learning/threads/${threadId}/messages`, subject.threadVersion));
        if (!currentQuestion) {
          capabilities.push(capability("revise_selection_intent", `/api/learning/threads/${threadId}/intent-revisions`, subject.threadVersion));
        }
        if (currentQuestion?.lifecycle === "active") {
          capabilities.push(capability("request_cut", `/api/learning/question-sessions/${currentQuestion.question_session_id}/cut-requests`, Number(currentQuestion.version)));
        }
      }
      return learningView({
        kind: "thread_context", resourceKind: "conversation-thread", resourceId: threadId,
        version: subject.threadVersion,
        factsThrough: maxDate(currentQuestion?.opened_at, intent?.created_at,
          contextManifest?.requested_at, contextManifest?.manifest_recorded_at,
          ...annotations.map((row) => row.created_at), ...operations.map((row) => row.updated_at)),
        permissions: actorPermissions(subject),
        data: {
          current_question: currentQuestion ? {
            id: currentQuestion.question_session_id, revision_id: currentQuestion.question_revision_id,
            source: currentQuestion.source, status: currentQuestion.lifecycle,
            version: Number(currentQuestion.version), prompt_summary: currentQuestion.stem_markdown?.slice(0, 240),
          } : null,
          current_intent: intent ? {
            id: intent.selection_intent_id, revision: Number(intent.revision),
            summary: intent.natural_language_request, created_at: asIso(intent.created_at),
          } : null,
          current_activity: activity ?? null,
          relevant_memories: annotations.map((row) => ({
            annotation_id: row.annotation_id, claim: row.claim, target_kind: row.target_kind,
            target_ref: row.target_ref, set_version: Number(row.set_version),
            href: `/learning/memory#${row.annotation_id}`,
          })),
          agent_context_manifest: contextManifest?.workspace_manifest ?? null,
          operations: operations.map(operationViewData),
        },
        capabilities,
      });
    });
  }

  async questionInteraction(principal: Principal, questionSessionId: string): Promise<LearningView> {
    return withPrincipal(this.pool, principal, async (client) => {
      const row = (await client.query<{
        question_session_id: string; conversation_thread_id: string; student_id: string;
        question_revision_id: string | null; external_question_ref: string | null; source: string;
        lifecycle: string; version: string; opened_at: Date | string; closed_at: Date | string | null;
        stem_format: string | null; stem_markdown: string | null; attempt_id: string | null;
        selection_decision_id: string | null; decision_summary: string | null;
        satisfied_requirements: string[] | null; unsatisfied_preferences: string[] | null;
      }>(
        `select session.question_session_id,session.conversation_thread_id,session.student_id,
                session.question_revision_id,session.external_question_ref,session.source,
                session.lifecycle,session.version,session.opened_at,session.closed_at,
                question.stem_format,question.stem_markdown,
                (select attempt.attempt_id from science_v3_attempt attempt
                  where attempt.tenant_id=session.tenant_id and attempt.question_session_id=session.question_session_id
                  order by attempt.session_sequence desc limit 1) as attempt_id,
                decision.selection_decision_id,decision.decision_summary,
                decision.satisfied_requirements,decision.unsatisfied_preferences
           from science_v3_question_session session
           left join content_question_revision question
             on question.tenant_id=session.tenant_id and question.revision_id=session.question_revision_id
           left join science_v3_question_opened opened
             on opened.tenant_id=session.tenant_id and opened.question_session_id=session.question_session_id
           left join science_v3_selection_decision decision
             on decision.tenant_id=opened.tenant_id and decision.selection_decision_id=opened.selection_decision_id
          where session.tenant_id=$1 and session.question_session_id=$2`,
        [principal.tenantId, questionSessionId],
      )).rows[0];
      if (!row) throw new LearningReadError(404, "question_session_not_found", "题目会话不存在");
      const thread = await assertThreadAccess(client, principal, row.conversation_thread_id);
      if (thread.studentId !== row.student_id) throw new LearningReadError(404, "question_session_not_found", "题目会话不存在");
      const options = row.question_revision_id ? (await client.query<{ option_key: string; option_text: string }>(
        `select option.option_key,option.option_text
           from content_revision_item item
           join content_question_option option on option.tenant_id=item.tenant_id and option.item_id=item.item_id
          where item.tenant_id=$1 and item.revision_id=$2 and item.item_kind='question_option'
          order by item.position`,
        [principal.tenantId, row.question_revision_id],
      )).rows : [];
      const responseKind = row.stem_format === "open_solution" ? "short_answer" : row.stem_format ?? "short_answer";
      const status = row.lifecycle === "active" ? (row.attempt_id ? "submitted" : "open")
        : row.lifecycle === "finalizing" ? "finalizing" : "closed";
      const commands: CommandCapability[] = [];
      if (thread.actorMode === "self" && row.lifecycle === "active" && !row.attempt_id && row.question_revision_id) {
        commands.push(capability("submit_attempt", `/api/learning/question-sessions/${questionSessionId}/attempts`, Number(row.version)));
      }
      if (thread.actorMode === "self" && row.lifecycle === "active") {
        commands.push(capability("request_cut", `/api/learning/question-sessions/${questionSessionId}/cut-requests`, Number(row.version)));
      }
      return learningView({
        kind: "question_interaction", resourceKind: "question-session", resourceId: questionSessionId,
        version: Number(row.version), factsThrough: row.closed_at ?? row.opened_at,
        permissions: actorPermissions(thread), redactions: ["answer", "analysis", "private_rubric"],
        data: {
          question_session: { id: questionSessionId, version: Number(row.version), status },
          question: {
            revision_id: row.question_revision_id ?? row.external_question_ref,
            source: row.source,
            prompt_parts: [{ type: "text", text: row.stem_markdown ?? "外部题目内容仅在授权附件中可见。" }],
            response_kind: responseKind,
            ...(options.length ? { options: options.map((option) => ({ id: option.option_key, content: option.option_text })) } : {}),
          },
          ...(row.decision_summary ? { selection_context: {
            summary: row.decision_summary,
            satisfied: row.satisfied_requirements ?? [], compromises: row.unsatisfied_preferences ?? [],
          } } : {}),
          evidence_notice: {
            eligibility: row.source === "catalog" ? "formal" : "provisional",
            student_explanation: row.source === "catalog"
              ? "独立作答且判定可靠时，可形成正式学习证据。"
              : "可正常讲解；是否进入正式学习状态取决于可验证的题目与判定依据。",
          },
          response_policy: { required: true, allow_skip: true, allow_text: true },
          ...(row.attempt_id ? { submitted_attempt_ref: `attempt:${row.attempt_id}` } : {}),
          commands,
        },
        capabilities: commands,
      });
    });
  }

  async overview(principal: Principal, studentHandle?: string): Promise<LearningView> {
    return withPrincipal(this.pool, principal, async (client) => {
      const subject = await resolveLearningSubject(client, principal, studentHandle);
      const activeQuestion = (await client.query<{
        question_session_id: string; conversation_thread_id: string; stem_markdown: string | null;
        version: string; opened_at: Date | string;
      }>(
        `select session.question_session_id,session.conversation_thread_id,question.stem_markdown,
                session.version,session.opened_at
           from science_v3_question_session session
           left join content_question_revision question
             on question.tenant_id=session.tenant_id and question.revision_id=session.question_revision_id
          where session.tenant_id=$1 and session.student_id=$2 and session.lifecycle='active'
          order by session.opened_at desc limit 1`,
        [principal.tenantId, subject.studentId],
      )).rows[0];
      const summary = (await client.query<{
        session_count: number; due_count: number; error_due_count: number; memory_count: number;
        latest_fact_at: Date | string | null; max_version: string;
      }>(
        `select
           (select count(*)::int from science_v3_question_session where tenant_id=$1 and student_id=$2) session_count,
           (select count(*)::int from science_v3_retention_projection where tenant_id=$1 and student_id=$2 and due_at<=now()) due_count,
           (select count(*)::int from science_v3_error_pattern_projection where tenant_id=$1 and student_id=$2 and verification_due_at<=now() and state<>'superseded') error_due_count,
           (select count(*)::int from science_v3_semantic_annotation annotation
             where annotation.tenant_id=$1 and annotation.student_id=$2
               and not exists(select 1 from science_v3_annotation_supersession supersession
                               where supersession.tenant_id=annotation.tenant_id
                                 and supersession.superseded_annotation_id=annotation.annotation_id)) memory_count,
           greatest(
             (select max(opened_at) from science_v3_question_session where tenant_id=$1 and student_id=$2),
             (select max(projected_at) from science_v3_mastery_projection where tenant_id=$1 and student_id=$2),
             (select max(created_at) from science_v3_semantic_annotation where tenant_id=$1 and student_id=$2)
           ) latest_fact_at,
           greatest(1,
             coalesce((select max(version) from science_v3_question_session where tenant_id=$1 and student_id=$2),1),
             coalesce((select max(projection_version) from science_v3_mastery_projection where tenant_id=$1 and student_id=$2),1),
             coalesce((select max(set_version) from science_v3_semantic_annotation where tenant_id=$1 and student_id=$2),1)
           ) max_version`,
        [principal.tenantId, subject.studentId],
      )).rows[0]!;
      const recent = (await client.query<{
        question_session_id: string; conversation_thread_id: string; lifecycle: string;
        opened_at: Date | string; stem_markdown: string | null; verdict: string | null;
      }>(
        `select session.question_session_id,session.conversation_thread_id,session.lifecycle,
                session.opened_at,question.stem_markdown,
                (select judgment.verdict from science_v3_attempt attempt
                  join science_v3_judgment judgment
                    on judgment.tenant_id=attempt.tenant_id and judgment.attempt_id=attempt.attempt_id
                 where attempt.tenant_id=session.tenant_id and attempt.question_session_id=session.question_session_id
                 order by judgment.fact_version desc limit 1) verdict
           from science_v3_question_session session
           left join content_question_revision question
             on question.tenant_id=session.tenant_id and question.revision_id=session.question_revision_id
          where session.tenant_id=$1 and session.student_id=$2
          order by session.opened_at desc limit 3`,
        [principal.tenantId, subject.studentId],
      )).rows;
      const next = activeQuestion ? {
        kind: "continue_question", title: "继续当前题目",
        summary: activeQuestion.stem_markdown?.slice(0, 180) ?? "返回对话继续完成当前题目。",
        href: `/c/${activeQuestion.conversation_thread_id}#question-${activeQuestion.question_session_id}`,
      } : summary.due_count > 0 ? {
        kind: "retention_review", title: "先完成到期复习", summary: `有 ${summary.due_count} 项保持性复习到期。`, href: "/learning/review",
      } : summary.error_due_count > 0 ? {
        kind: "error_verification", title: "验证一个容易出错的情境", summary: `有 ${summary.error_due_count} 项需要复核。`, href: "/learning/review",
      } : {
        kind: "start_learning", title: "开始一次练习", summary: "告诉数学智元你现在想练什么。", href: "/",
      };
      return learningView({
        kind: "learning_overview", resourceKind: "student", resourceId: subject.studentId,
        version: Number(summary.max_version), factsThrough: summary.latest_fact_at,
        permissions: actorPermissions(subject),
        data: {
          actor: { mode: subject.actorMode, student_id: subject.studentId, display_name: subject.displayName },
          next_recommendation: next,
          counts: { sessions: summary.session_count, due_reviews: summary.due_count, error_verifications: summary.error_due_count, memories: summary.memory_count },
          recent_changes: recent.map((row) => ({
            question_session_id: row.question_session_id, thread_id: row.conversation_thread_id,
            summary: row.stem_markdown?.slice(0, 180) ?? "外部题目", status: row.lifecycle,
            verdict: row.verdict, occurred_at: asIso(row.opened_at),
          })),
          empty_state: summary.session_count === 0 ? "完成几次练习后，这里会出现有依据的学习记录。" : null,
        },
      });
    });
  }

  async history(principal: Principal, afterValue: unknown, kind: unknown, studentHandle?: string): Promise<LearningView> {
    const offset = decodeCursor(afterValue);
    const filter = typeof kind === "string" && ["all", "independent", "review", "error", "change"].includes(kind) ? kind : "all";
    return withPrincipal(this.pool, principal, async (client) => {
      const subject = await resolveLearningSubject(client, principal, studentHandle);
      const rows = (await client.query<{
        question_session_id: string; conversation_thread_id: string; question_revision_id: string | null;
        source: string; lifecycle: string; close_reason: string | null; opened_at: Date | string;
        closed_at: Date | string | null; version: string; stem_markdown: string | null;
        attempt_id: string | null; attempt_kind: string | null; hint_level: number | null;
        submitted_at: Date | string | null; judgment_id: string | null; verdict: string | null;
        uncertainty: string | null; decision_summary: string | null; diagnostic_status: string | null;
      }>(
        `select session.question_session_id,session.conversation_thread_id,session.question_revision_id,
                session.source,session.lifecycle,session.close_reason,session.opened_at,session.closed_at,
                session.version,question.stem_markdown,
                attempt.attempt_id,attempt.kind attempt_kind,attempt.hint_level,attempt.submitted_at,
                judgment.judgment_id,judgment.verdict,judgment.uncertainty,judgment.decision_summary,
                closure.diagnostic_status
           from science_v3_question_session session
           left join content_question_revision question
             on question.tenant_id=session.tenant_id and question.revision_id=session.question_revision_id
           left join lateral (
             select * from science_v3_attempt candidate
              where candidate.tenant_id=session.tenant_id and candidate.question_session_id=session.question_session_id
              order by candidate.session_sequence desc limit 1
           ) attempt on true
           left join lateral (
             select candidate.* from science_v3_judgment candidate
              where candidate.tenant_id=attempt.tenant_id and candidate.attempt_id=attempt.attempt_id
              order by candidate.fact_version desc limit 1
           ) judgment on true
           left join science_v3_question_closure closure
             on closure.tenant_id=session.tenant_id and closure.question_session_id=session.question_session_id
          where session.tenant_id=$1 and session.student_id=$2
            and ($3='all'
              or ($3='independent' and coalesce(attempt.hint_level,0)=0)
              or ($3='review' and exists(
                    select 1
                      from science_v3_delayed_review_event review
                      join science_v3_observation observation
                        on observation.tenant_id=review.tenant_id
                       and observation.observation_id=review.observation_id
                     where review.tenant_id=session.tenant_id
                       and observation.question_session_id=session.question_session_id))
              or ($3='error' and closure.diagnostic_status is not null)
              or ($3='change' and exists(select 1 from science_v3_observation observation
                                          where observation.tenant_id=session.tenant_id and observation.question_session_id=session.question_session_id)))
          order by session.opened_at desc,session.question_session_id desc
          offset $4 limit 31`,
        [principal.tenantId, subject.studentId, filter, offset],
      )).rows;
      const page = rows.slice(0, 30);
      const version = page.reduce((value, row) => Math.max(value, Number(row.version)), 1);
      return learningView({
        kind: "learning_history", resourceKind: "student-history", resourceId: subject.studentId,
        version, factsThrough: maxDate(...page.map((row) => row.closed_at ?? row.opened_at)),
        permissions: actorPermissions(subject),
        data: {
          filter,
          entries: page.map((row) => ({
            question_session_id: row.question_session_id, question_revision_id: row.question_revision_id,
            thread_id: row.conversation_thread_id, question_summary: row.stem_markdown?.slice(0, 240) ?? "外部题目",
            source: row.source, status: row.lifecycle, close_reason: row.close_reason,
            opened_at: asIso(row.opened_at), closed_at: asIso(row.closed_at),
            attempt: row.attempt_id ? {
              id: row.attempt_id, kind: row.attempt_kind, hint_level: row.hint_level,
              independent: row.hint_level === 0, submitted_at: asIso(row.submitted_at),
            } : null,
            judgment: row.judgment_id ? {
              id: row.judgment_id, verdict: row.verdict, uncertainty: row.uncertainty,
              summary: row.decision_summary,
              evidence_href: `/learning/evidence/${evidenceHandle({ kind: "judgment", id: row.judgment_id!, studentId: subject.studentId })}`,
            } : null,
            scientific_impact: row.diagnostic_status ? diagnosticImpact(row.diagnostic_status)
              : row.judgment_id ? (row.hint_level === 0 ? "已进入证据评估" : "用于教学连续性，不作为独立掌握证据") : "尚未形成正式判定",
            thread_href: `/c/${row.conversation_thread_id}#question-${row.question_session_id}`,
          })),
          next_cursor: page.length ? encodeCursor(offset + page.length) : encodeCursor(offset),
          has_more: rows.length > 30,
        },
      });
    });
  }

  async scientificState(principal: Principal, kindValue: unknown, studentHandle?: string): Promise<LearningView> {
    const kind = typeof kindValue === "string" && ["knowledge", "question_type", "error"].includes(kindValue)
      ? kindValue : "knowledge";
    return withPrincipal(this.pool, principal, async (client) => {
      const subject = await resolveLearningSubject(client, principal, studentHandle);
      if (kind === "error") return this.errorPatternView(client, principal, subject);
      const prefix = kind === "knowledge" ? "K_" : "T_";
      const rows = (await client.query<{
        dimension_id: string; dimension_revision_id: string; lineage_version: string;
        p_mastery: string; state: string; independent_count: number; transfer_evidence: number;
        parameter_set_id: string; calibration_status: string; projection_version: string;
        projected_at: Date | string; label: string | null; retention_unit_revision_id: string | null;
        due_at: Date | string | null; retrievability: string | null; retention_parameter_set_id: string | null;
      }>(
        `select mastery.dimension_id,lineage.dimension_revision_id,mastery.lineage_version,
                mastery.p_mastery,mastery.state,mastery.independent_count,mastery.transfer_evidence,
                mastery.parameter_set_id,mastery.calibration_status,mastery.projection_version,
                mastery.projected_at,coalesce(knowledge.name,question_type.name) label,
                retention.retention_unit_revision_id,retention.due_at,retention.retrievability,
                retention.parameter_set_id retention_parameter_set_id
           from science_v3_mastery_projection mastery
           join science_v3_dimension_lineage lineage
             on lineage.tenant_id=mastery.tenant_id and lineage.dimension_id=mastery.dimension_id
            and lineage.lineage_version=mastery.lineage_version
           left join content_knowledge_revision knowledge
             on knowledge.tenant_id=lineage.tenant_id and knowledge.revision_id=lineage.dimension_revision_id
           left join content_question_type_revision question_type
             on question_type.tenant_id=lineage.tenant_id and question_type.revision_id=lineage.dimension_revision_id
           left join lateral (
             select projection.* from science_v3_retention_projection projection
              where projection.tenant_id=mastery.tenant_id and projection.student_id=mastery.student_id
                and projection.dimension_revision_id=lineage.dimension_revision_id
              order by projection.due_at limit 1
           ) retention on true
          where mastery.tenant_id=$1 and mastery.student_id=$2 and mastery.dimension_id like $3
          order by mastery.projected_at desc,mastery.dimension_id`,
        [principal.tenantId, subject.studentId, `${prefix}%`],
      )).rows;
      const annotations = (await client.query<{
        annotation_id: string; target_ref: string; claim: string; confidence: string;
        support_count: number; counter_count: number; set_version: string;
      }>(
        `select annotation_id,target_ref,claim,confidence,cardinality(support_refs) support_count,
                cardinality(counter_refs) counter_count,set_version
           from science_v3_semantic_annotation annotation
          where tenant_id=$1 and student_id=$2 and target_kind='dimension'
            and not exists(select 1 from science_v3_annotation_supersession supersession
                            where supersession.tenant_id=annotation.tenant_id
                              and supersession.superseded_annotation_id=annotation.annotation_id)`,
        [principal.tenantId, subject.studentId],
      )).rows;
      const version = rows.reduce((value, row) => Math.max(value, Number(row.projection_version)), 1);
      return learningView({
        kind: "scientific_state", resourceKind: "student-scientific-state", resourceId: `${subject.studentId}:${kind}`,
        version, factsThrough: maxDate(...rows.map((row) => row.projected_at)),
        permissions: actorPermissions(subject),
        data: {
          kind,
          dimensions: rows.map((row) => {
            const dueAt = asIso(row.due_at);
            const related = annotations.filter((annotation) => annotation.target_ref === `dimension:${row.dimension_revision_id}`);
            return {
              dimension: { id: row.dimension_id, revision_id: row.dimension_revision_id, kind, label: row.label ?? row.dimension_id },
              mastery: {
                state: row.state, p_mastery: asNumber(row.p_mastery), independent_count: row.independent_count,
                transfer_evidence: row.transfer_evidence, calibration_status: row.calibration_status,
                parameter_set_id: row.parameter_set_id, projected_at: asIso(row.projected_at),
              },
              ...(row.retention_unit_revision_id ? { retention: {
                status: !dueAt ? "unscheduled" : new Date(dueAt).getTime() <= Date.now() ? "due" : "future",
                due_at: dueAt, retrievability: asNumber(row.retrievability), parameter_set_id: row.retention_parameter_set_id,
              } } : {}),
              annotations: related.map((annotation) => ({
                annotation_id: annotation.annotation_id, claim: annotation.claim,
                scope_summary: row.label ?? row.dimension_id,
                evidence_summary: `支持 ${annotation.support_count}，反证 ${annotation.counter_count}`,
                status: "active",
              })),
              evidence_href: `/learning/evidence/${evidenceHandle({ kind: "mastery", id: row.dimension_id, studentId: subject.studentId })}`,
            };
          }),
          empty_state: rows.length ? null : "完成几次独立练习后，这里会显示有依据的状态。",
        },
      });
    });
  }

  async memories(principal: Principal, afterValue: unknown, statusValue: unknown, studentHandle?: string): Promise<LearningView> {
    const offset = decodeCursor(afterValue);
    const status = typeof statusValue === "string" && ["active", "muted", "stale", "all"].includes(statusValue) ? statusValue : "active";
    return withPrincipal(this.pool, principal, async (client) => {
      const subject = await resolveLearningSubject(client, principal, studentHandle);
      const rows = (await client.query<{
        annotation_id: string; target_kind: string; target_ref: string; claim: string; scope: Record<string, unknown>;
        support_count: number; counter_count: number; confidence: string; trend: string | null;
        action_hint: string | null; valid_from: Date | string; review_due_at: Date | string | null;
        set_version: string; created_at: Date | string; muted: boolean; stale: boolean;
        superseded_by: string | null; under_review: boolean;
      }>(
        `select * from (
           select annotation.annotation_id,annotation.target_kind,annotation.target_ref,annotation.claim,annotation.scope,
                  cardinality(annotation.support_refs) support_count,cardinality(annotation.counter_refs) counter_count,
                  annotation.confidence,annotation.trend,annotation.action_hint,annotation.valid_from,annotation.review_due_at,
                  annotation.set_version,annotation.created_at,
                  not coalesce((select preference.enabled from science_v3_annotation_usage_preference_event preference
                    where preference.tenant_id=annotation.tenant_id and preference.student_id=annotation.student_id
                      and (preference.annotation_id=annotation.annotation_id or preference.annotation_id is null)
                    order by (preference.annotation_id is not null) desc,preference.created_at desc,
                             preference.preference_event_id desc limit 1),true) muted,
                  exists(select 1 from science_v3_annotation_stale_fact stale
                          where stale.tenant_id=annotation.tenant_id and stale.annotation_id=annotation.annotation_id) stale,
                  (select supersession.replacement_annotation_id from science_v3_annotation_supersession supersession
                    where supersession.tenant_id=annotation.tenant_id
                      and supersession.superseded_annotation_id=annotation.annotation_id) superseded_by,
                  exists(select 1 from science_v3_annotation_feedback feedback
                          where feedback.tenant_id=annotation.tenant_id and feedback.annotation_id=annotation.annotation_id
                            and feedback.feedback in ('inaccurate','not_useful','needs_review')) under_review
             from science_v3_semantic_annotation annotation
            where annotation.tenant_id=$1 and annotation.student_id=$2
         ) memory
         where $3='all'
            or ($3='muted' and memory.muted)
            or ($3='stale' and memory.stale)
            or ($3='active' and not memory.muted and not memory.stale and memory.superseded_by is null)
         order by memory.set_version desc,memory.created_at desc
         offset $4 limit 31`,
        [principal.tenantId, subject.studentId, status, offset],
      )).rows;
      const page = rows.slice(0, 30);
      const version = page.reduce((value, row) => Math.max(value, Number(row.set_version)), 1);
      return learningView({
        kind: "memory_ledger", resourceKind: "student-memory-ledger", resourceId: subject.studentId,
        version, factsThrough: maxDate(...page.map((row) => row.created_at)),
        permissions: actorPermissions(subject),
        data: {
          status,
          memories: page.map((row) => ({
            annotation_id: row.annotation_id, target_kind: row.target_kind, claim: row.claim,
            scope: Object.entries(row.scope).map(([facet, value]) => ({ facet, value: String(value), label: String(value) })),
            support: { count: row.support_count, href: `/learning/evidence/${evidenceHandle({ kind: "annotation", id: row.annotation_id, studentId: subject.studentId })}` },
            counter: { count: row.counter_count, href: `/learning/evidence/${evidenceHandle({ kind: "annotation", id: row.annotation_id, studentId: subject.studentId })}` },
            confidence: row.confidence, trend: row.trend, action_hint: row.action_hint,
            status: row.superseded_by ? "superseded" : row.stale ? "stale" : row.muted ? "muted" : row.under_review ? "under_review" : "active",
            used_for_personalization: !row.muted && !row.stale && !row.superseded_by,
            valid_from: asIso(row.valid_from), review_due_at: asIso(row.review_due_at), superseded_by: row.superseded_by,
            commands: subject.actorMode === "self" ? [
              capability("annotation_feedback", `/api/learning/annotations/${row.annotation_id}/feedback`, Number(row.set_version)),
              capability("set_context_preference", "/api/learning/context-preferences", Number(row.set_version)),
            ] : [],
          })),
          next_cursor: page.length ? encodeCursor(offset + page.length) : encodeCursor(offset),
          has_more: rows.length > 30,
          empty_state: page.length ? null : "系统还没有发布可核对的学习观察。",
        },
      });
    });
  }

  async reviews(principal: Principal, afterValue: unknown, studentHandle?: string): Promise<LearningView> {
    const offset = decodeCursor(afterValue);
    return withPrincipal(this.pool, principal, async (client) => {
      const subject = await resolveLearningSubject(client, principal, studentHandle);
      const rows = (await client.query<{
        item_kind: "retention" | "error_verification"; item_id: string; label: string;
        due_at: Date | string; state: string; version: string;
      }>(
        `select * from (
           select 'retention'::text item_kind,retention.retention_unit_revision_id item_id,
                  coalesce(knowledge.name,question_type.name,retention.dimension_revision_id) label,
                  retention.due_at,retention.card_state state,retention.projection_version version
             from science_v3_retention_projection retention
             left join content_knowledge_revision knowledge
               on knowledge.tenant_id=retention.tenant_id and knowledge.revision_id=retention.dimension_revision_id
             left join content_question_type_revision question_type
               on question_type.tenant_id=retention.tenant_id and question_type.revision_id=retention.dimension_revision_id
            where retention.tenant_id=$1 and retention.student_id=$2
           union all
           select 'error_verification',pattern.error_cause_id,
                  coalesce(cause.name,pattern.error_cause_id),pattern.verification_due_at,
                  pattern.state,pattern.projection_version
             from science_v3_error_pattern_projection pattern
             left join content_error_cause_revision cause
               on cause.tenant_id=pattern.tenant_id and cause.revision_id=pattern.active_definition_revision_id
            where pattern.tenant_id=$1 and pattern.student_id=$2
              and pattern.verification_due_at is not null and pattern.state<>'superseded'
         ) queue order by due_at,item_kind,item_id offset $3 limit 31`,
        [principal.tenantId, subject.studentId, offset],
      )).rows;
      const page = rows.slice(0, 30);
      const version = page.reduce((value, row) => Math.max(value, Number(row.version)), 1);
      return learningView({
        kind: "review_queue", resourceKind: "student-review-queue", resourceId: subject.studentId,
        version, factsThrough: maxDate(...page.map((row) => row.due_at)), permissions: actorPermissions(subject),
        data: {
          items: page.map((row) => ({
            review_item_ref: `${row.item_kind}:${row.item_id}`, source: row.item_kind,
            label: row.label, due_at: asIso(row.due_at), status: new Date(row.due_at).getTime() <= Date.now() ? "due" : "future",
            state: row.state,
            commands: subject.actorMode === "self"
              ? [capability("start_review", `/api/learning/reviews/${encodeURIComponent(`${row.item_kind}:${row.item_id}`)}/start`, Number(row.version))]
              : [],
          })),
          next_cursor: page.length ? encodeCursor(offset + page.length) : encodeCursor(offset),
          has_more: rows.length > 30,
          empty_state: page.length ? null : "目前没有需要立即完成的复习。",
        },
      });
    });
  }

  async annotation(principal: Principal, annotationId: string): Promise<LearningView> {
    return withPrincipal(this.pool, principal, async (client) => {
      const owner = (await client.query<{ student_id: string }>(
        `select student_id from science_v3_semantic_annotation where tenant_id=$1 and annotation_id=$2`,
        [principal.tenantId, annotationId],
      )).rows[0];
      if (!owner) throw new LearningReadError(404, "annotation_not_found", "学习观察不存在");
      const subject = await resolveLearningSubject(client, principal,
        (await this.ownStudentId(client, principal)) === owner.student_id ? undefined : owner.student_id);
      const row = (await client.query<{
        annotation_id: string; target_kind: string; target_ref: string; claim: string;
        scope: Record<string, unknown>; support_refs: string[]; counter_refs: string[];
        confidence: string; trend: string | null; action_hint: string | null;
        valid_from: Date | string; review_due_at: Date | string | null; set_version: string;
        created_at: Date | string; superseded_by: string | null; stale_reason: string | null;
        muted: boolean; under_review: boolean;
      }>(
        `select annotation.annotation_id,annotation.target_kind,annotation.target_ref,annotation.claim,
                annotation.scope,annotation.support_refs,annotation.counter_refs,annotation.confidence,
                annotation.trend,annotation.action_hint,annotation.valid_from,annotation.review_due_at,
                annotation.set_version,annotation.created_at,
                (select replacement_annotation_id from science_v3_annotation_supersession supersession
                  where supersession.tenant_id=annotation.tenant_id
                    and supersession.superseded_annotation_id=annotation.annotation_id) superseded_by,
                (select reason from science_v3_annotation_stale_fact stale
                  where stale.tenant_id=annotation.tenant_id and stale.annotation_id=annotation.annotation_id
                  order by stale.created_at desc limit 1) stale_reason,
                not coalesce((select preference.enabled from science_v3_annotation_usage_preference_event preference
                  where preference.tenant_id=annotation.tenant_id and preference.student_id=annotation.student_id
                    and (preference.annotation_id=annotation.annotation_id or preference.annotation_id is null)
                  order by (preference.annotation_id is not null) desc,preference.created_at desc,
                           preference.preference_event_id desc limit 1),true) muted,
                exists(select 1 from science_v3_annotation_feedback feedback
                        where feedback.tenant_id=annotation.tenant_id and feedback.annotation_id=annotation.annotation_id
                          and feedback.feedback in ('inaccurate','not_useful','needs_review')) under_review
           from science_v3_semantic_annotation annotation
          where annotation.tenant_id=$1 and annotation.annotation_id=$2`,
        [principal.tenantId, annotationId],
      )).rows[0]!;
      return learningView({
        kind: "annotation_detail", resourceKind: "annotation", resourceId: annotationId,
        version: Number(row.set_version), factsThrough: row.created_at, permissions: actorPermissions(subject),
        data: {
          annotation_id: row.annotation_id, target_kind: row.target_kind, target_ref: row.target_ref,
          claim: row.claim, scope: row.scope, confidence: row.confidence, trend: row.trend,
          action_hint: row.action_hint, valid_from: asIso(row.valid_from), review_due_at: asIso(row.review_due_at),
          support: { count: row.support_refs.length, refs: row.support_refs },
          counter: { count: row.counter_refs.length, refs: row.counter_refs },
          status: row.superseded_by ? "superseded" : row.stale_reason ? "stale" : row.muted ? "muted" : row.under_review ? "under_review" : "active",
          used_for_personalization: !row.superseded_by && !row.stale_reason && !row.muted,
          superseded_by: row.superseded_by, stale_reason: row.stale_reason,
          evidence_href: `/learning/evidence/${evidenceHandle({ kind: "annotation", id: annotationId, studentId: subject.studentId })}`,
        },
        capabilities: subject.actorMode === "self" ? [
          capability("annotation_feedback", `/api/learning/annotations/${annotationId}/feedback`, Number(row.set_version)),
          capability("set_context_preference", "/api/learning/context-preferences", Number(row.set_version)),
        ] : [],
      });
    });
  }

  async evidence(principal: Principal, handle: string): Promise<LearningView> {
    const reference = parseEvidenceHandle(handle);
    return withPrincipal(this.pool, principal, async (client) => {
      const ownId = await this.ownStudentId(client, principal);
      const subject = await resolveLearningSubject(client, principal, ownId === reference.studentId ? undefined : reference.studentId);
      if (subject.studentId !== reference.studentId) throw new LearningReadError(404, "evidence_not_found", "依据不存在或已失效");
      if (reference.kind === "annotation") {
        const row = (await client.query<{
          annotation_id: string; claim: string; target_kind: string; target_ref: string;
          support_refs: string[]; counter_refs: string[]; confidence: string; created_at: Date | string;
          set_version: string;
        }>(
          `select annotation_id,claim,target_kind,target_ref,support_refs,counter_refs,confidence,created_at,set_version
             from science_v3_semantic_annotation
            where tenant_id=$1 and student_id=$2 and annotation_id=$3`,
          [principal.tenantId, subject.studentId, reference.id],
        )).rows[0];
        if (!row) throw new LearningReadError(404, "evidence_not_found", "依据不存在或已失效");
        return learningView({
          kind: "evidence_bundle", resourceKind: "annotation-evidence", resourceId: handle,
          version: Number(row.set_version), factsThrough: row.created_at, permissions: actorPermissions(subject),
          data: {
            subject: { kind: "annotation", label: row.claim, current: true },
            question: { revision_id: "not-applicable", prompt_summary: "跨题学习观察" },
            scientific_relations: [
              ...row.support_refs.map((ref) => ({ layer: "annotation", relation: "supports", explanation: ref })),
              ...row.counter_refs.map((ref) => ({ layer: "annotation", relation: "counters", explanation: ref })),
            ],
            provenance: { occurred_at: asIso(row.created_at) },
            annotation: { target_kind: row.target_kind, target_ref: row.target_ref, confidence: row.confidence },
          },
        });
      }
      if (reference.kind === "mastery" || reference.kind === "retention" || reference.kind === "error-pattern") {
        return this.projectionEvidence(client, principal, subject, reference.kind, reference.id, handle);
      }
      const predicate = reference.kind === "judgment" ? "judgment.judgment_id=$3"
        : reference.kind === "attempt" ? "attempt.attempt_id=$3"
          : "session.question_session_id=$3";
      const row = (await client.query<{
        question_session_id: string; conversation_thread_id: string; question_revision_id: string | null;
        stem_markdown: string | null; attempt_id: string | null; attempt_kind: string | null;
        attempt_parts: CanonicalMessage["parts"] | null; hint_level: number | null; submitted_at: Date | string | null;
        judgment_id: string | null; verdict: string | null; rubric_results: unknown[] | null;
        uncertainty: string | null; decision_summary: string | null; evidence_refs: string[] | null;
        model_id: string | null; prompt_version: string | null; created_at: Date | string;
        fact_version: string | null; superseded_by: string | null;
        superseded_by_verdict: string | null; superseded_by_summary: string | null;
      }>(
        `select session.question_session_id,session.conversation_thread_id,session.question_revision_id,
                question.stem_markdown,attempt.attempt_id,attempt.kind attempt_kind,message.parts attempt_parts,
                attempt.hint_level,attempt.submitted_at,judgment.judgment_id,judgment.verdict,
                judgment.rubric_results,judgment.uncertainty,judgment.decision_summary,
                judgment.evidence_refs,judgment.model_id,judgment.prompt_version,
                coalesce(judgment.created_at,attempt.submitted_at,session.opened_at) created_at,
                judgment.fact_version,
                (select newer.judgment_id from science_v3_judgment newer
                  where newer.tenant_id=judgment.tenant_id and newer.supersedes_judgment_id=judgment.judgment_id
                  order by newer.fact_version desc limit 1) superseded_by,
                (select newer.verdict from science_v3_judgment newer
                  where newer.tenant_id=judgment.tenant_id and newer.supersedes_judgment_id=judgment.judgment_id
                  order by newer.fact_version desc limit 1) superseded_by_verdict,
                (select newer.decision_summary from science_v3_judgment newer
                  where newer.tenant_id=judgment.tenant_id and newer.supersedes_judgment_id=judgment.judgment_id
                  order by newer.fact_version desc limit 1) superseded_by_summary
           from science_v3_question_session session
           left join content_question_revision question
             on question.tenant_id=session.tenant_id and question.revision_id=session.question_revision_id
           left join science_v3_attempt attempt
             on attempt.tenant_id=session.tenant_id and attempt.question_session_id=session.question_session_id
           left join science_v3_canonical_message message
             on message.tenant_id=attempt.tenant_id and message.message_id=attempt.message_id
           left join science_v3_judgment judgment
             on judgment.tenant_id=attempt.tenant_id and judgment.attempt_id=attempt.attempt_id
          where session.tenant_id=$1 and session.student_id=$2 and ${predicate}
          order by attempt.session_sequence desc,judgment.fact_version desc limit 1`,
        [principal.tenantId, subject.studentId, reference.id],
      )).rows[0];
      if (!row) throw new LearningReadError(404, "evidence_not_found", "依据不存在或已失效");
      return learningView({
        kind: "evidence_bundle", resourceKind: `${reference.kind}-evidence`, resourceId: handle,
        version: Math.max(1, Number(row.fact_version ?? 1)), factsThrough: row.created_at,
        permissions: actorPermissions(subject), redactions: ["hidden_reasoning", "system_prompt", "credentials"],
        data: {
          subject: { kind: reference.kind, label: row.decision_summary ?? row.stem_markdown?.slice(0, 120) ?? "学习依据", current: !row.superseded_by },
          question: { revision_id: row.question_revision_id, prompt_summary: row.stem_markdown?.slice(0, 500) ?? "外部题目" },
          ...(row.attempt_id ? { attempt: {
            kind: row.attempt_kind, submitted_at: asIso(row.submitted_at), hint_level: row.hint_level,
            independent: row.hint_level === 0, content_parts: row.attempt_parts ?? [],
          } } : {}),
          ...(row.judgment_id ? { judgment: {
            id: row.judgment_id, fact_version: Number(row.fact_version ?? 1),
            verdict: row.verdict, rubric_items: row.rubric_results ?? [], uncertainty: row.uncertainty,
            summary: row.decision_summary, evidence_links: row.evidence_refs ?? [], superseded_by: row.superseded_by,
            ...(row.superseded_by ? { replacement: {
              id: row.superseded_by, verdict: row.superseded_by_verdict, summary: row.superseded_by_summary,
            } } : {}),
          } } : {}),
          scientific_relations: row.hint_level && row.hint_level > 0
            ? [{ layer: "M", relation: "excluded_from_independent_mastery", explanation: "本次使用了提示，仅用于教学连续性。" }]
            : [{ layer: "M", relation: "eligible_for_evaluation", explanation: "是否纳入掌握证据由冻结规则和判定共同决定。" }],
          provenance: { occurred_at: asIso(row.created_at), model_version: row.model_id, prompt_version: row.prompt_version },
          thread_href: `/c/${row.conversation_thread_id}#question-${row.question_session_id}`,
        },
        capabilities: subject.actorMode === "teacher" && row.judgment_id && !row.superseded_by
          ? [capability("teacher_supersede_fact", `/api/learning/judgments/${row.judgment_id}/corrections`, Number(row.fact_version ?? 1))]
          : [],
      });
    });
  }

  async activity(principal: Principal, activityId: string): Promise<LearningView> {
    return withPrincipal(this.pool, principal, async (client) => {
      const row = (await client.query<{
        learning_activity_id: string; student_id: string; goal: string; source: string;
        policy: Record<string, unknown>; status: string; created_at: Date | string;
        closed_at: Date | string | null; version: string;
      }>(
        `select * from science_v3_learning_activity where tenant_id=$1 and learning_activity_id=$2`,
        [principal.tenantId, activityId],
      )).rows[0];
      if (!row) throw new LearningReadError(404, "activity_not_found", "学习活动不存在");
      const ownId = await this.ownStudentId(client, principal);
      const subject = await resolveLearningSubject(client, principal, ownId === row.student_id ? undefined : row.student_id);
      const count = (await client.query<{ sessions: number; closed: number }>(
        `select count(*)::int sessions,count(*) filter(where lifecycle in ('closed','abandoned'))::int closed
           from science_v3_question_session where tenant_id=$1 and student_id=$2 and learning_activity_id=$3`,
        [principal.tenantId, row.student_id, activityId],
      )).rows[0]!;
      return learningView({
        kind: "learning_activity", resourceKind: "learning-activity", resourceId: activityId,
        version: Number(row.version), factsThrough: row.closed_at ?? row.created_at, permissions: actorPermissions(subject),
        data: {
          id: row.learning_activity_id, goal: row.goal, source: row.source, policy: row.policy,
          status: row.status, created_at: asIso(row.created_at), closed_at: asIso(row.closed_at),
          progress: { question_sessions: count.sessions, closed_question_sessions: count.closed },
        },
      });
    });
  }

  async operation(principal: Principal, operationId: string): Promise<LearningView> {
    return withPrincipal(this.pool, principal, async (client) => {
      const row = (await client.query<OperationRow & { requested_by_user_id: string; student_id: string | null }>(
        `select operation.*,
                coalesce(foreground.student_id,cut.student_id,intent.student_id,question.student_id) student_id
           from science_v3_operation operation
           left join science_v3_foreground_request foreground
             on foreground.tenant_id=operation.tenant_id and foreground.operation_id=operation.operation_id
           left join science_v3_cut_request cut_request
             on cut_request.tenant_id=operation.tenant_id and cut_request.operation_id=operation.operation_id
           left join science_v3_question_session cut
             on cut.tenant_id=cut_request.tenant_id and cut.question_session_id=cut_request.question_session_id
           left join science_v3_selection_request selection_request
             on selection_request.tenant_id=operation.tenant_id and selection_request.operation_id=operation.operation_id
           left join science_v3_selection_intent intent
             on intent.tenant_id=selection_request.tenant_id and intent.selection_intent_id=selection_request.selection_intent_id
           left join science_v3_teacher_correction correction
             on correction.tenant_id=operation.tenant_id and correction.operation_id=operation.operation_id
           left join science_v3_question_session question
             on question.tenant_id=correction.tenant_id and question.question_session_id=correction.question_session_id
          where operation.tenant_id=$1 and operation.operation_id=$2`,
        [principal.tenantId, operationId],
      )).rows[0];
      if (!row) throw new LearningReadError(404, "operation_not_found", "操作不存在");
      let subject: LearningSubject;
      if (row.requested_by_user_id === principal.userId && principal.roles.includes("student")) {
        subject = await resolveLearningSubject(client, principal);
      } else if (row.student_id) {
        subject = await resolveLearningSubject(client, principal, row.student_id);
      } else if (row.requested_by_user_id === principal.userId) {
        subject = { studentId: "stu_unbound00", userId: principal.userId, displayName: principal.name, actorMode: "teacher" };
      } else throw new LearningReadError(404, "operation_not_found", "操作不存在");
      return learningView({
        kind: "operation", resourceKind: "operation", resourceId: operationId,
        version: Number(row.version), factsThrough: row.updated_at, permissions: actorPermissions(subject),
        data: operationViewData(row),
        capabilities: row.requested_by_user_id === principal.userId && ["accepted", "running", "needs_input"].includes(row.status)
          ? [capability("cancel_operation", `/api/learning/operations/${operationId}/cancel`, Number(row.version))] : [],
      });
    });
  }

  async accessibleClientEvents(principal: Principal, after: number, limit = 100): Promise<Array<{
    cursor: number; event_id: string; event_type: string; resource_key: string;
    resource_version: string; occurred_at: Date | string;
  }>> {
    return withPrincipal(this.pool, principal, async (client) => (await client.query(
      `select event.cursor,event.event_id,event.event_type,event.resource_key,event.resource_version,event.occurred_at
         from science_v3_client_event event
        where event.tenant_id=$1 and event.cursor>$2
          and (
            event.audience_user_id=$3
            or ($4::boolean and event.student_id is not null and exists(
              select 1 from science_v3_student student
              join identity_class_user learner
                on learner.tenant_id=student.tenant_id and learner.user_id=student.user_id
               and learner.class_role='student' and learner.status='active'
              join identity_class_user teacher
                on teacher.tenant_id=learner.tenant_id and teacher.class_id=learner.class_id
               and teacher.user_id=$3 and teacher.class_role='teacher' and teacher.status='active'
              join identity_class class
                on class.tenant_id=learner.tenant_id and class.class_id=learner.class_id and class.status='active'
             where student.tenant_id=event.tenant_id and student.student_id=event.student_id
            ))
          )
        order by event.cursor limit $5`,
      [principal.tenantId, after, principal.userId, principal.roles.includes("teacher"), Math.min(Math.max(limit, 1), 100)],
    )).rows);
  }

  private async threadOperations(client: pg.PoolClient, tenantId: string, threadId: string): Promise<OperationRow[]> {
    return (await client.query<OperationRow>(
      `select distinct operation.operation_id,operation.kind,operation.status,operation.user_message,
              operation.related_resource_refs,operation.retryable,operation.started_at,operation.updated_at,operation.version
         from science_v3_operation operation
         left join science_v3_foreground_request foreground
           on foreground.tenant_id=operation.tenant_id and foreground.operation_id=operation.operation_id
         left join science_v3_selection_request selection_request
           on selection_request.tenant_id=operation.tenant_id and selection_request.operation_id=operation.operation_id
         left join science_v3_selection_intent intent
           on intent.tenant_id=selection_request.tenant_id and intent.selection_intent_id=selection_request.selection_intent_id
         left join science_v3_cut_request cut_request
           on cut_request.tenant_id=operation.tenant_id and cut_request.operation_id=operation.operation_id
        where operation.tenant_id=$1
          and (foreground.conversation_thread_id=$2 or intent.conversation_thread_id=$2 or cut_request.conversation_thread_id=$2)
        order by operation.updated_at desc limit 20`,
      [tenantId, threadId],
    )).rows;
  }

  private async errorPatternView(
    client: pg.PoolClient,
    principal: Principal,
    subject: LearningSubject,
  ): Promise<LearningView> {
    const rows = (await client.query<{
      error_cause_id: string; active_definition_revision_id: string; state: string;
      support_count: number; counter_count: number; independent_session_count: number;
      recurrence_count: number; verification_due_at: Date | string | null;
      policy_version: string; projection_version: string; projected_at: Date | string;
      name: string | null; manifestation: string | null; remediation: string | null;
    }>(
      `select pattern.*,cause.name,cause.manifestation,cause.remediation
         from science_v3_error_pattern_projection pattern
         left join content_error_cause_revision cause
           on cause.tenant_id=pattern.tenant_id and cause.revision_id=pattern.active_definition_revision_id
        where pattern.tenant_id=$1 and pattern.student_id=$2
        order by (pattern.state='confirmed') desc,pattern.verification_due_at nulls last,pattern.projected_at desc`,
      [principal.tenantId, subject.studentId],
    )).rows;
    const version = rows.reduce((value, row) => Math.max(value, Number(row.projection_version)), 1);
    return learningView({
      kind: "error_pattern_list", resourceKind: "student-error-patterns", resourceId: subject.studentId,
      version, factsThrough: maxDate(...rows.map((row) => row.projected_at)), permissions: actorPermissions(subject),
      data: {
        patterns: rows.map((row) => ({
          error_cause_id: row.error_cause_id, definition_revision_id: row.active_definition_revision_id,
          title: errorPatternTitle(row.state, row.name ?? row.manifestation ?? row.error_cause_id),
          behavior: row.manifestation ?? row.name ?? "尚在形成可解释的行为描述",
          state: row.state, support_count: row.support_count, counter_count: row.counter_count,
          independent_session_count: row.independent_session_count, recurrence_count: row.recurrence_count,
          verification_due_at: asIso(row.verification_due_at), next_step: row.remediation,
          evidence_href: `/learning/evidence/${evidenceHandle({ kind: "error-pattern", id: row.error_cause_id, studentId: subject.studentId })}`,
          technical: { policy_version: row.policy_version, projection_version: Number(row.projection_version), projected_at: asIso(row.projected_at) },
        })),
        empty_state: rows.length ? null : "还没有足够证据形成可核对的错因记录。",
      },
    });
  }

  private async projectionEvidence(
    client: pg.PoolClient,
    principal: Principal,
    subject: LearningSubject,
    kind: "mastery" | "retention" | "error-pattern",
    id: string,
    handle: string,
  ): Promise<LearningView> {
    if (kind === "mastery") {
      const row = (await client.query<{
        dimension_id: string; state: string; p_mastery: string; independent_count: number;
        transfer_evidence: number; input_observation_ids: string[]; projection_version: string;
        projector_version: string; parameter_set_id: string; projected_at: Date | string;
      }>(
        `select * from science_v3_mastery_projection
          where tenant_id=$1 and student_id=$2 and dimension_id=$3
          order by lineage_version desc limit 1`,
        [principal.tenantId, subject.studentId, id],
      )).rows[0];
      if (!row) throw new LearningReadError(404, "evidence_not_found", "依据不存在或已失效");
      return learningView({
        kind: "evidence_bundle", resourceKind: "mastery-evidence", resourceId: handle,
        version: Number(row.projection_version), factsThrough: row.projected_at, permissions: actorPermissions(subject),
        data: {
          subject: { kind: "mastery", label: row.dimension_id, current: true },
          question: { revision_id: "multiple", prompt_summary: "由多次独立题目证据归约" },
          scientific_relations: row.input_observation_ids.map((observation) => ({ layer: "M", relation: "input_observation", explanation: observation })),
          mastery: { state: row.state, p_mastery: asNumber(row.p_mastery), independent_count: row.independent_count, transfer_evidence: row.transfer_evidence },
          provenance: { occurred_at: asIso(row.projected_at), policy_version: row.parameter_set_id, model_version: row.projector_version },
        },
      });
    }
    if (kind === "retention") {
      const row = (await client.query<{
        retention_unit_revision_id: string; dimension_revision_id: string; due_at: Date | string;
        stability: string; difficulty: string; retrievability: string; card_state: string;
        review_count: number; input_review_event_ids: string[]; projection_version: string;
        projector_version: string; parameter_set_id: string; projected_at: Date | string;
      }>(
        `select * from science_v3_retention_projection
          where tenant_id=$1 and student_id=$2 and retention_unit_revision_id=$3`,
        [principal.tenantId, subject.studentId, id],
      )).rows[0];
      if (!row) throw new LearningReadError(404, "evidence_not_found", "依据不存在或已失效");
      return learningView({
        kind: "evidence_bundle", resourceKind: "retention-evidence", resourceId: handle,
        version: Number(row.projection_version), factsThrough: row.projected_at, permissions: actorPermissions(subject),
        data: {
          subject: { kind: "retention", label: row.dimension_revision_id, current: true },
          question: { revision_id: "multiple", prompt_summary: "由延迟复习记录更新" },
          scientific_relations: row.input_review_event_ids.map((event) => ({ layer: "R", relation: "review_event", explanation: event })),
          retention: { due_at: asIso(row.due_at), stability: asNumber(row.stability), difficulty: asNumber(row.difficulty), retrievability: asNumber(row.retrievability), card_state: row.card_state, review_count: row.review_count },
          provenance: { occurred_at: asIso(row.projected_at), policy_version: row.parameter_set_id, model_version: row.projector_version },
        },
      });
    }
    const row = (await client.query<{
      error_cause_id: string; state: string; effective_evidence_ids: string[];
      support_count: number; counter_count: number; recurrence_count: number;
      projection_version: string; projector_version: string; policy_version: string;
      projected_at: Date | string;
    }>(
      `select * from science_v3_error_pattern_projection
        where tenant_id=$1 and student_id=$2 and error_cause_id=$3`,
      [principal.tenantId, subject.studentId, id],
    )).rows[0];
    if (!row) throw new LearningReadError(404, "evidence_not_found", "依据不存在或已失效");
    return learningView({
      kind: "evidence_bundle", resourceKind: "error-pattern-evidence", resourceId: handle,
      version: Number(row.projection_version), factsThrough: row.projected_at, permissions: actorPermissions(subject),
      data: {
        subject: { kind: "error_pattern", label: row.error_cause_id, current: row.state !== "superseded" },
        question: { revision_id: "multiple", prompt_summary: "由多次区分性证据归约" },
        scientific_relations: row.effective_evidence_ids.map((evidence) => ({ layer: "C_e", relation: "effective_evidence", explanation: evidence })),
        pattern: { state: row.state, support_count: row.support_count, counter_count: row.counter_count, recurrence_count: row.recurrence_count },
        provenance: { occurred_at: asIso(row.projected_at), policy_version: row.policy_version, model_version: row.projector_version },
      },
    });
  }

  private async ownStudentId(client: pg.PoolClient, principal: Principal): Promise<string | undefined> {
    if (!principal.roles.includes("student")) return undefined;
    return (await client.query<{ student_id: string }>(
      `select student_id from science_v3_student where tenant_id=$1 and user_id=$2`,
      [principal.tenantId, principal.userId],
    )).rows[0]?.student_id;
  }
}

const operationViewData = (row: OperationRow) => ({
  operation_id: row.operation_id,
  kind: row.kind,
  status: row.status,
  user_message: row.user_message,
  related_resource_refs: row.related_resource_refs,
  retryable: row.retryable,
  started_at: asIso(row.started_at),
  updated_at: asIso(row.updated_at),
  version: Number(row.version),
});

const diagnosticImpact = (status: string): string => {
  switch (status) {
    case "concluded": return "已形成可追溯的诊断结论";
    case "inconclusive": return "现有证据暂不足以形成诊断结论";
    case "skipped": return "本题未进入诊断";
    case "unclassified": return "诊断记录仍在整理";
    default: return "诊断记录已更新";
  }
};

const errorPatternTitle = (state: string, label: string): string => {
  switch (state) {
    case "suspected": return `还需确认：${label}`;
    case "confirmed": return `当前需要处理：${label}`;
    case "improving": return `正在改善：${label}`;
    case "resolved": return `近期已通过验证：${label}`;
    default: return `定义或判定已更新：${label}`;
  }
};
