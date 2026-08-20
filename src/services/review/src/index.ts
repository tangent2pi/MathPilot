/**
 * review-service：教师复核队列 + 纠正（supersede + 重放 + 修订 SLR 入 Dream 队列）。
 *
 * POST /review/corrections 对 state_observation 的改判：
 *   1. 生成 TeacherCorrection 事件（事实不可变，仅 replay_status/replay_result_ref 可推进）
 *   2. 插入替代观测（supersedes 指向旧观测；旧行不更新——方案 A）
 *   3. 重放该维度 BKT，产出修订 SER
 *   4. 封装修订 SessionLearningRecord（supersedes 旧记录，复用原 TSS），重新进入 Dream 队列
 *   5. 标记 replayed；长期画像仍只经 Dream 路径更新（ADR-004）
 */
import { startService, createPool, withTenant, newId } from "./lib.ts";
import { bktReplay, BKT_PRIOR_V1 } from "@mathpilot/mastery";

const pool = createPool(process.env.DATABASE_URL ?? "postgres://localhost:5432/agmath");

function tenantOf(req: { headers: Record<string, unknown> }): string | null {
  const t = req.headers["x-tenant-id"];
  return typeof t === "string" && t.length > 0 ? t : null;
}
function actorOf(req: { headers: Record<string, unknown> }): string | null {
  const value=req.headers["x-user-id"];
  return typeof value==="string"&&value.length?value:null;
}
function rolesOf(req: { headers: Record<string, unknown> }): string[] {
  const value=req.headers["x-user-roles"];
  return typeof value==="string"?value.split(",").map((role)=>role.trim()).filter(Boolean):[];
}

interface CorrectionBody {
  target_id: string;
  replacement_outcome: "success" | "failure" | "unresolved";
  reason: string;
  reviewer_id: string;
}

interface CreateTaskBody {
  queue: "content" | "student_diagnosis";
  target_type: string;
  target_id: string;
  payload?: Record<string, unknown>;
}

startService({
  name: "review",
  port: Number(process.env.PORT ?? 3008),
  register(app) {
    app.get("/review/tasks", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { queue, status, target_ids, target_type, stem_format: stemFormat, source_pipeline_id: sourcePipelineId, q, limit: rawLimit, offset: rawOffset } = req.query as {
        queue?: string; status?: string; target_ids?: string; target_type?: string; stem_format?: string; source_pipeline_id?: string; q?: string; limit?: string; offset?: string;
      };
      const actor=actorOf(req),admin=rolesOf(req).includes("tenant_admin");
      // target_ids：逗号分隔的目标过滤（发布门按本章节题目拉取裁决，P0-4）
      const targets = target_ids
        ? target_ids.split(",").map((s) => s.trim()).filter(Boolean)
        : null;
      const parsedLimit=Number.parseInt(rawLimit??"",10),parsedOffset=Number.parseInt(rawOffset??"",10);
      const limit=Number.isFinite(parsedLimit)?Math.min(1000,Math.max(1,parsedLimit)):1000;
      const offset=Number.isFinite(parsedOffset)?Math.max(0,parsedOffset):0;
      const search=q?.trim()?`%${q.trim().slice(0,200)}%`:null;
      return withTenant(pool, tenantId, async (c) => {
        const r = await c.query(
          `select task_id, queue, target_type, target_id, status, assignee_id, payload, created_at, resolved_at
             from review_review_task
            where ($1::text is null or queue = $1)
              and ($2::text is null or status = $2)
              and ($3::text[] is null or target_id = any($3))
              and ($6::text is null or target_type = $6)
              and ($7::text is null or target_id ilike $7
                or coalesce(payload->'candidate'->>'stem_markdown','') ilike $7
                or coalesce(payload->'candidate'->>'name','') ilike $7
                or coalesce(payload->'candidate'->>'trigger','') ilike $7)
              and ($10::text is null or payload->>'source_pipeline_id' = $10)
              and ($11::text is null or payload->'candidate'->>'stem_format' = $11)
              and ($4::text is null or $5::boolean
                or (queue='content' and payload->>'owner_teacher_id'=$4)
                or (queue='student_diagnosis' and exists(select 1 from identity_teacher_student_binding b
                  where b.teacher_id=$4 and b.student_id=payload->>'student_id' and b.status='active')))
            order by created_at desc limit $8 offset $9`,
          [queue ?? null, status ?? null, targets, actor, admin, target_type ?? null, search, limit, offset, sourcePipelineId ?? null, stemFormat ?? null],
        );
        const summary = await c.query(
          `select count(*) filter (where $9::text is null or status=$9)::int as filtered_count,
                  count(*)::int as total_count,
                  count(*) filter (where status='pending')::int as pending_count,
                  count(*) filter (where status='rejected')::int as rejected_count,
                  count(*) filter (where status in ('confirmed','modified','merged'))::int as resolved_count
             from review_review_task
            where ($1::text is null or queue = $1)
              and ($2::text[] is null or target_id = any($2))
              and ($5::text is null or target_type = $5)
              and ($6::text is null or target_id ilike $6
                or coalesce(payload->'candidate'->>'stem_markdown','') ilike $6
                or coalesce(payload->'candidate'->>'name','') ilike $6
                or coalesce(payload->'candidate'->>'trigger','') ilike $6)
              and ($7::text is null or payload->>'source_pipeline_id' = $7)
              and ($8::text is null or payload->'candidate'->>'stem_format' = $8)
              and ($3::text is null or $4::boolean
                or (queue='content' and payload->>'owner_teacher_id'=$3)
                or (queue='student_diagnosis' and exists(select 1 from identity_teacher_student_binding b
                  where b.teacher_id=$3 and b.student_id=payload->>'student_id' and b.status='active')))`,
          [queue ?? null, targets, actor, admin, target_type ?? null, search, sourcePipelineId ?? null, stemFormat ?? null, status ?? null],
        );
        return { tasks: r.rows, ...summary.rows[0], limit, offset };
      });
    });

    /** 内部端点：其他服务（如 content 管线）登记复核任务 */
    app.post("/review/tasks", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const body = req.body as CreateTaskBody;
      if (body.queue !== "content" && body.queue !== "student_diagnosis") {
        return reply.code(422).send({ error: "queue must be content|student_diagnosis" });
      }
      const taskId = newId("rvt");
      await withTenant(pool, tenantId, async (c) => {
        await c.query(
          `insert into review_review_task (task_id, tenant_id, queue, target_type, target_id, status, payload)
           values ($1,$2,$3,$4,$5,'pending',$6)`,
          [taskId, tenantId, body.queue, body.target_type, body.target_id, JSON.stringify(body.payload ?? {})],
        );
      });
      return reply.code(201).send({ task_id: taskId, status: "pending" });
    });

    /** 教师裁决复核任务（review_review_task 是工作流状态表，非不可变事实）。
     *  - modified：可携带 modification 载荷（stem_markdown/answer_summary/rubric/measurement_targets），
     *    发布时由 content 真正应用（P0-4）；
     *  - cancelled：内容管线补偿清理（staging 事务失败后取消已注册任务），不视为裁决。 */
    app.patch("/review/tasks/:id", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { id } = req.params as { id: string };
      const body = req.body as { status: string; assignee_id?: string; modification?: Record<string, unknown> };
      const actor=actorOf(req),admin=rolesOf(req).includes("tenant_admin");
      if (!actor && body.status!=="cancelled") return reply.code(403).send({error:"review actor required"});
      if (!["confirmed", "modified", "rejected", "merged", "cancelled"].includes(body.status)) {
        return reply.code(422).send({ error: "status must be confirmed|modified|rejected|merged|cancelled" });
      }
      if (body.status === "modified" && body.modification !== undefined
          && (typeof body.modification !== "object" || Array.isArray(body.modification))) {
        return reply.code(422).send({ error: "modification must be an object" });
      }
      const out = await withTenant(pool, tenantId, async (c) => {
        const r = await c.query(
          `update review_review_task
              set status = $2, assignee_id = coalesce($3, assignee_id), resolved_at = now(),
                  payload = payload || jsonb_build_object('modification', $4::jsonb)
            where task_id = $1 and status <> 'cancelled'
              and ($5::text is null or $6::boolean
                or (queue='content' and payload->>'owner_teacher_id'=$5)
                or (queue='student_diagnosis' and exists(select 1 from identity_teacher_student_binding b
                  where b.teacher_id=$5 and b.student_id=payload->>'student_id' and b.status='active')))
            returning task_id, status, payload`,
          [id, body.status, body.assignee_id ?? null,
           JSON.stringify(body.modification ?? {}),actor,admin],
        );
        return r.rows[0];
      });
      if (!out) return reply.code(409).send({ error: "task not found or no longer editable" });
      return { task_id: out.task_id, status: out.status, modification: out.payload?.modification ?? undefined };
    });

    /** 列表批量裁决。批量操作只处理无需逐项编辑的状态；“修改后确认”仍在详情中
     *  连同具体 modification 一起提交，避免出现没有修改内容的 modified 任务。 */
    app.post("/review/tasks/bulk", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const actor = actorOf(req), admin = rolesOf(req).includes("tenant_admin");
      if (!actor) return reply.code(403).send({ error: "review actor required" });
      const body = req.body as { task_ids?: unknown; status?: unknown };
      const taskIds = Array.isArray(body.task_ids)
        ? [...new Set(body.task_ids.filter((id): id is string => typeof id === "string" && id.length > 0))]
        : [];
      if (taskIds.length === 0 || taskIds.length > 100) {
        return reply.code(422).send({ error: "task_ids must contain 1..100 unique ids" });
      }
      if (!["confirmed", "rejected", "merged"].includes(String(body.status ?? ""))) {
        return reply.code(422).send({ error: "bulk status must be confirmed|rejected|merged" });
      }
      const updated = await withTenant(pool, tenantId, async (c) => {
        const result = await c.query(
          `update review_review_task
              set status=$2, assignee_id=$3, resolved_at=now()
            where task_id=any($1::text[]) and status<>'cancelled'
              and ($4::boolean
                or (queue='content' and payload->>'owner_teacher_id'=$3)
                or (queue='student_diagnosis' and exists(select 1 from identity_teacher_student_binding b
                  where b.teacher_id=$3 and b.student_id=payload->>'student_id' and b.status='active')))
            returning task_id,status`,
          [taskIds, body.status, actor, admin],
        );
        const rows = result.rows as { task_id: string; status: string }[];
        if (rows.length !== taskIds.length) throw Object.assign(new Error("bulk review conflict"), { code: "BULK_REVIEW_CONFLICT" });
        return rows;
      }).catch((error: unknown) => {
        if ((error as { code?: string }).code === "BULK_REVIEW_CONFLICT") return null;
        throw error;
      });
      if (!updated) {
        return reply.code(409).send({
          error: "one or more tasks are unavailable or no longer editable",
        });
      }
      return { updated, count: updated.length };
    });

    app.post("/review/corrections", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const body = req.body as CorrectionBody;
      if (!body.reason?.trim()) return reply.code(400).send({ error: "reason required" });
      const now = new Date().toISOString();
      const correctionId = newId("cor");
      const newObsId = newId("obs");
      const replaySerId = newId("ser");
      const revisionSlrId = newId("slr");

      const out = await withTenant(pool, tenantId, async (c) => {
        const old = await c.query(
          "select * from runtime_state_observation where observation_id = $1",
          [body.target_id],
        );
        const oldObs = old.rows[0];
        if (!oldObs) return { status: 404 as const, body: { error: "observation not found" } };
        const superseded = await c.query(
          "select 1 from runtime_state_observation where supersedes = $1",
          [body.target_id],
        );
        if (superseded.rows.length > 0) {
          return { status: 409 as const, body: { error: "observation already superseded" } };
        }

        await c.query(
          `insert into review_teacher_correction
             (correction_id, tenant_id, target_type, target_id, action, replacement_ref,
              reason, reviewer_id, replay_status, payload)
           values ($1,$2,'state_observation',$3,'supersede',$4,$5,$6,'replaying',$7)`,
          [correctionId, tenantId, body.target_id, newObsId, body.reason, body.reviewer_id,
           JSON.stringify({
             correction_id: correctionId, tenant_id: tenantId,
             target_type: "state_observation", target_id: body.target_id,
             action: "supersede", replacement_ref: newObsId,
             reason: body.reason, reviewer_id: body.reviewer_id,
             replay_status: "replaying", created_at: now,
           })],
        );

        // 替代观测：谱系仅由 supersedes 表达（correction 侧有 replacement_ref 反向链接）
        const newObsPayload = {
          ...oldObs.payload,
          observation_id: newObsId,
          outcome: body.replacement_outcome,
          supersedes: body.target_id,
          created_at: now,
        };
        await c.query(
          `insert into runtime_state_observation
             (observation_id, tenant_id, student_id, dimension_id, question_id, session_id,
              judgment_id, outcome, independent, evidence_rule, hint_level, supersedes, payload)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [newObsId, tenantId, oldObs.student_id, oldObs.dimension_id, oldObs.question_id,
           oldObs.session_id, oldObs.judgment_id, body.replacement_outcome, oldObs.independent,
           oldObs.evidence_rule, oldObs.hint_level, body.target_id, JSON.stringify(newObsPayload)],
        );

        // 重放：该学生该维度全部有效观测（排除被 supersede 的旧行）
        const hist = await c.query(
          `select o.outcome from runtime_state_observation o
            where o.student_id = $1 and o.dimension_id = $2 and o.independent
              and o.outcome in ('success','failure')
              and not exists (
                select 1 from runtime_state_observation o2 where o2.supersedes = o.observation_id
              )
            order by o.created_at`,
          [oldObs.student_id, oldObs.dimension_id],
        );
        const pBaseline = Math.round(
          bktReplay(hist.rows.map((r) => r.outcome as "success" | "failure")) * 1000,
        ) / 1000;

        const serPayload = {
          report_id: replaySerId,
          session_id: oldObs.session_id,
          student_id: oldObs.student_id,
          dimension_id: oldObs.dimension_id,
          p_bkt_baseline: pBaseline,
          independent_observation_count: hist.rows.length,
          parameter_set_id: BKT_PRIOR_V1.id,
          calibration_status: "prior_only",
          input_event_refs: [newObsId],
          calculation_trace_ref: `replay_${correctionId}`,
          kernel_version: "mastery-bkt@0.1.0",
          created_at: now,
        };
        await c.query(
          `insert into state_scientific_evaluation_report
             (report_id, tenant_id, session_id, student_id, dimension_id, p_bkt_baseline,
              calibration_status, parameter_set_id, kernel_version, payload)
           values ($1,$2,$3,$4,$5,$6,'prior_only',$7,$8,$9)`,
          [replaySerId, tenantId, oldObs.session_id, oldObs.student_id, oldObs.dimension_id,
           pBaseline, BKT_PRIOR_V1.id, "mastery-bkt@0.1.0", JSON.stringify(serPayload)],
        );

        // 修订 SLR：重放的 SER + 原 TSS 重新封装，进入 Dream 队列，取代旧记录
        // （设计 §11.3 / 实施规划 C6：纠正后重放 → 程序评价 → 教学总结重建/失效 → Dream Decision）
        // 骨架简化：TSS 复用原总结（教学观察未变，仅程序评价被纠正）；重建/失效在真实模型接入后落地。
        let revision: { slr_id: string } | null = null;
        const oldSlr = await c.query(
          `select r1.record_id, r1.tss_id from runtime_session_learning_record r1
            where r1.session_id = $1
              and not exists (
                select 1 from runtime_session_learning_record r2 where r2.supersedes = r1.record_id
              )
            order by r1.created_at desc limit 1`,
          [oldObs.session_id],
        );
        if (oldSlr.rows[0]) {
          const { record_id: oldRecordId, tss_id: tssId } = oldSlr.rows[0];
          await c.query(
            `insert into runtime_session_learning_record
               (record_id, tenant_id, session_id, student_id, ser_id, tss_id,
                integrity_passed, supersedes, dream_queued_at, payload)
             values ($1,$2,$3,$4,$5,$6,true,$7,now(),$8)`,
            [revisionSlrId, tenantId, oldObs.session_id, oldObs.student_id, replaySerId, tssId,
             oldRecordId,
             JSON.stringify({
               record_id: revisionSlrId,
               session_id: oldObs.session_id,
               student_id: oldObs.student_id,
               scientific_evaluation_report_id: replaySerId,
               teaching_session_summary_id: tssId,
               integrity_check: {
                 session_id_match: true,
                 cross_refs_present: true,
                 provenance_complete: true,
                 passed: true,
               },
               supersedes: oldRecordId,
               revision_reason: `teacher_correction:${correctionId}`,
               dream_queued_at: now,
               created_at: now,
             })],
          );
          revision = { slr_id: revisionSlrId };
        }

        await c.query(
          `update review_teacher_correction
              set replay_status = 'replayed', replay_result_ref = $2
            where correction_id = $1`,
          [correctionId, replaySerId],
        );

        return {
          status: 200 as const,
          body: {
            correction_id: correctionId,
            superseded_observation: body.target_id,
            replacement_observation: newObsId,
            replay_report: serPayload,
            revision_record: revision,
            note: "修订双产物已重新入 Dream 队列；长期画像仍只由 Dream Decision 更新（旧 Decision 保留并被 supersede）",
          },
        };
      });

      return reply.code(out.status).send(out.body);
    });
  },
});
