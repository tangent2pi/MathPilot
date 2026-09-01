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

export async function ensureOwnStudent(client: pg.PoolClient, principal: Principal): Promise<LearningSubject> {
  if (!principal.roles.includes("student")) {
    throw new LearningReadError(403, "student_role_required", "当前账号不是学生账号");
  }
  await client.query(
    `insert into science_v3_student(student_id,tenant_id,user_id)
     values($1,$2,$3) on conflict(tenant_id,user_id) do nothing`,
    [newId("stu"), principal.tenantId, principal.userId],
  );
  const row = (await client.query<{ student_id: string; user_id: string; display_name: string }>(
    `select student_id,user_id,display_name
       from mathpilot_science_v3_current_actor_students($1,true)
      where user_id=$2 and actor_mode='self'`, [principal.tenantId,principal.userId],
  )).rows[0];
  if (!row) throw new LearningReadError(500, "student_unavailable", "学生学习身份不可用");
  return { studentId: row.student_id, userId: row.user_id, displayName: row.display_name, actorMode: "self" };
}

export async function resolveLearningSubject(
  client: pg.PoolClient,
  principal: Principal,
  studentHandle?: string,
): Promise<LearningSubject> {
  if (!studentHandle) return ensureOwnStudent(client, principal);
  if (!principal.roles.includes("teacher")) {
    throw new LearningReadError(404, "student_not_found", "学生不存在");
  }
  const row = (await client.query<{ student_id: string; user_id: string; display_name: string }>(
    `select student_id,user_id,display_name
       from mathpilot_science_v3_current_actor_students($1,false)
      where student_id=$2 and actor_mode='teacher'`, [principal.tenantId,studentHandle],
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
    student_id: string; user_id: string; display_name: string; actor_mode:"self"|"teacher";
    thread_version: string; thread_status: string; thread_title: string;
  }>(
    `select * from mathpilot_science_v3_current_actor_thread($1,$2,$3)`,
    [principal.tenantId,threadId,write],
  )).rows[0];
  if (!row) {
    if (write) {
      const readable=(await client.query<{ actor_mode:"self"|"teacher" }>(
        `select actor_mode from mathpilot_science_v3_current_actor_thread($1,$2,false)`,
        [principal.tenantId,threadId],
      )).rows[0];
      if (readable?.actor_mode==="teacher") throw new LearningReadError(403,"thread_read_only","教师查看中的学生对话是只读的");
      if (readable?.actor_mode==="self") throw new LearningReadError(403,"student_role_required","当前账号不能写入学生对话");
    }
    throw new LearningReadError(404, "thread_not_found", "对话不存在");
  }
  return {
    studentId:row.student_id,userId:row.user_id,displayName:row.display_name,actorMode:row.actor_mode,
    threadVersion:Number(row.thread_version),threadStatus:row.thread_status,threadTitle:row.thread_title,
  };
}
