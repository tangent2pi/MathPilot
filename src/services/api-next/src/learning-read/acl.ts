import type pg from "pg";
import type { Principal } from "../auth.ts";
import { newId } from "../lib.ts";
import { LearningReadError } from "./cursor.ts";

export interface LearningSubject {
  studentId: string;
  userId: string;
  displayName: string;
  actorMode: "self" | "teacher";
}

export async function ensureOwnStudent(client: pg.PoolClient, principal: { userId: string; tenantId: string; roles: readonly string[] }): Promise<LearningSubject> {
  if (!principal.roles.includes("student")) {
    throw new LearningReadError(403, "student_role_required", "当前账号不是学生账号");
  }
  await client.query(
    `insert into science_v3_student(student_id,tenant_id,user_id)
     values($1,$2,$3) on conflict(tenant_id,user_id) do nothing`,
    [newId("stu"), principal.tenantId, principal.userId],
  );
  const row = (await client.query<{ student_id: string; user_id: string; display_name: string }>(
    `select student.student_id,student.user_id,identity.display_name
       from science_v3_student student
       join identity_user identity on identity.tenant_id=student.tenant_id and identity.user_id=student.user_id
      where student.tenant_id=$1 and student.user_id=$2`,
    [principal.tenantId, principal.userId],
  )).rows[0];
  if (!row) throw new LearningReadError(500, "student_unavailable", "学生学习身份不可用");
  return { studentId: row.student_id, userId: row.user_id, displayName: row.display_name, actorMode: "self" };
}

export async function resolveLearningSubject(
  client: pg.PoolClient,
  principal: { userId: string; tenantId: string; roles: readonly string[] },
  studentHandle?: string,
): Promise<LearningSubject> {
  if (!studentHandle) return ensureOwnStudent(client, principal);
  if (!principal.roles.includes("teacher")) {
    throw new LearningReadError(404, "student_not_found", "学生不存在");
  }
  const row = (await client.query<{ student_id: string; user_id: string; display_name: string }>(
    `select distinct student.student_id,student.user_id,identity.display_name
       from science_v3_student student
       join identity_user identity
         on identity.tenant_id=student.tenant_id and identity.user_id=student.user_id
       join identity_class_user learner
         on learner.tenant_id=student.tenant_id and learner.user_id=student.user_id
        and learner.class_role='student' and learner.status='active'
       join identity_class_user teacher
         on teacher.tenant_id=learner.tenant_id and teacher.class_id=learner.class_id
        and teacher.user_id=$3 and teacher.class_role='teacher' and teacher.status='active'
       join identity_class class
         on class.tenant_id=learner.tenant_id and class.class_id=learner.class_id and class.status='active'
      where student.tenant_id=$1 and student.student_id=$2`,
    [principal.tenantId, studentHandle, principal.userId],
  )).rows[0];
  if (!row) throw new LearningReadError(404, "student_not_found", "学生不存在");
  return { studentId: row.student_id, userId: row.user_id, displayName: row.display_name, actorMode: "teacher" };
}

export async function assertThreadAccess(
  client: pg.PoolClient,
  principal: Principal,
  threadId: string,
  write = false,
): Promise<LearningSubject & { threadVersion: number; threadStatus: string; threadTitle: string }> {
  const row = (await client.query<{
    student_id: string; user_id: string; display_name: string; version: string; status: string; title: string;
  }>(
    `select thread.student_id,student.user_id,identity.display_name,thread.version,thread.status,thread.title
       from science_v3_conversation_thread thread
       join science_v3_student student
         on student.tenant_id=thread.tenant_id and student.student_id=thread.student_id
       join identity_user identity
         on identity.tenant_id=student.tenant_id and identity.user_id=student.user_id
      where thread.tenant_id=$1 and thread.conversation_thread_id=$2 and thread.deleted_at is null`,
    [principal.tenantId, threadId],
  )).rows[0];
  if (!row) throw new LearningReadError(404, "thread_not_found", "对话不存在");
  if (row.user_id === principal.userId) {
    if (write && !principal.roles.includes("student")) throw new LearningReadError(403, "student_role_required", "当前账号不能写入学生对话");
    return {
      studentId: row.student_id, userId: row.user_id, displayName: row.display_name,
      actorMode: "self", threadVersion: Number(row.version), threadStatus: row.status, threadTitle: row.title,
    };
  }
  const subject = await resolveLearningSubject(client, principal, row.student_id);
  if (write) throw new LearningReadError(403, "thread_read_only", "教师查看中的学生对话是只读的");
  return { ...subject, threadVersion: Number(row.version), threadStatus: row.status, threadTitle: row.title };
}
