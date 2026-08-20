/**
 * profile-service：画像快照查询 + Dream 消费闭环。
 *
 * POST /dream/run 消费该学生未处理的 SLR：
 *   SLR → ProfileEvidenceBundle → Dream/Profile Update Agent（经 agent-runtime，
 *   独立 Session，综合双产物与证据账本输出最终 PUD）→ 确定性 Validator
 *   （引用/区间/算术/双 Session）→ 通过后物化 StudentSnapshot 并更新 mastery_state。
 *
 * 纪律（ADR-004）：
 * - Validator 只校验不修改，失败退回模型重试（不自动程序化更新画像）；
 * - 模型声明 review_required 的 Decision 送教师复核（student_diagnosis 队列），
 *   不物化快照、不消费 SLR——窗口保留给复核后重跑（设计 §9.3/§11.3）；
 * - 本服务是 StudentSnapshot 唯一写入方。
 */
import { startService, createPool, withTenant, newId } from "./lib.ts";
import { createAgentRuntimeClient } from "@mathpilot/providers-model";
import { masteryState } from "@mathpilot/mastery";
import { planFromProfile } from "./planner.ts";
import { rosterGetMastery, rosterUpdate } from "./bkt-sidecar.ts";
import {
  validatePud,
  VALIDATOR_VERSION,
  type DimensionUpdate,
  type PudPayload,
} from "./validator.ts";

const pool = createPool(process.env.DATABASE_URL ?? "postgres://localhost:5432/mathpilot");
/** 模型调用统一经 agent-runtime（Pi 宿主）；本服务不直连任何模型供应商 */
const AGENT_RUNTIME_URL = process.env.AGENT_RUNTIME_URL ?? "http://localhost:3005";
const REVIEW_URL = process.env.REVIEW_URL ?? "http://localhost:3008";
const runtime = createAgentRuntimeClient({ baseUrl: AGENT_RUNTIME_URL });

function tenantOf(req: { headers: Record<string, unknown> }): string | null {
  const t = req.headers["x-tenant-id"];
  return typeof t === "string" && t.length > 0 ? t : null;
}

startService({
  name: "profile",
  port: Number(process.env.PORT ?? 3003),
  register(app) {
    /** 学生最小画像采集（设计 §3.1）：自报资料 upsert；只影响选题与计划，不写掌握结论 */
    app.put("/students/:studentId/profile", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { studentId } = req.params as { studentId: string };
      const body = req.body as {
        grade?: string; current_score?: number; target_score?: number;
        weekly_hours?: string; self_weak?: string[]; device_draft?: string;
      };
      if (!body.grade || !body.weekly_hours || !body.device_draft) {
        return reply.code(422).send({ error: "grade/weekly_hours/device_draft required" });
      }
      if (!["1-3", "4-6", "7-10", "10+"].includes(body.weekly_hours)) {
        return reply.code(422).send({ error: "weekly_hours must be 1-3|4-6|7-10|10+" });
      }
      if (!["触屏手写", "纸面拍照", "无草稿"].includes(body.device_draft)) {
        return reply.code(422).send({ error: "device_draft must be 触屏手写|纸面拍照|无草稿" });
      }
      const now = new Date().toISOString();
      const payload = {
        student_id: studentId, tenant_id: tenantId,
        grade: body.grade,
        current_score: body.current_score ?? null,
        target_score: body.target_score ?? null,
        weekly_hours: body.weekly_hours,
        self_weak: body.self_weak ?? [],
        device_draft: body.device_draft,
        updated_at: now,
      };
      await withTenant(pool, tenantId, async (c) => {
        await c.query(
          `insert into state_student_profile
             (student_id, tenant_id, grade, current_score, target_score, weekly_hours, self_weak, device_draft, payload)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           on conflict (student_id)
           do update set grade = excluded.grade, current_score = excluded.current_score,
             target_score = excluded.target_score, weekly_hours = excluded.weekly_hours,
             self_weak = excluded.self_weak, device_draft = excluded.device_draft,
             payload = excluded.payload, updated_at = now()`,
          [studentId, tenantId, body.grade, body.current_score ?? null, body.target_score ?? null,
           body.weekly_hours, body.self_weak ?? [], body.device_draft, JSON.stringify(payload)],
        );
      });
      return reply.send(payload);
    });

    app.get("/students/:studentId/profile", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { studentId } = req.params as { studentId: string };
      const row = await withTenant(pool, tenantId, async (c) => {
        const r = await c.query(
          "select payload from state_student_profile where student_id = $1",
          [studentId],
        );
        return r.rows[0];
      });
      if (!row) return reply.code(404).send({ error: "no profile", hint: "请先完成最小画像注册" });
      return row.payload;
    });

    /**
     * 只读投影（STUDENT.md 概念，Hermes/OpenClaw 借鉴）：供教学 Session 与报告读取。
     * 画像 + 最新快照摘要 + 复测到期；只读、预算内注入（§5.3 文件层）。
     */
    app.get("/students/:studentId/projection", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { studentId } = req.params as { studentId: string };
      const out = await withTenant(pool, tenantId, async (c) => {
        const profile = await c.query("select payload from state_student_profile where student_id = $1", [studentId]);
        const snapshot = await c.query(
            "select payload from state_student_snapshot where student_id = $1 order by published_at desc limit 1",
            [studentId],
          );
        const mastery = await c.query(
            "select dimension_id, p_profile, state, updated_at from state_mastery_state where student_id = $1",
            [studentId],
          );
        const retention = await c.query(
            "select dimension_id, i90_posterior, next_review_due, stable from state_retention_state where student_id = $1",
            [studentId],
          );
        const misconceptions = await c.query(
            "select error_cause_id, state, evidence_refs, updated_at from state_misconception_state where student_id = $1 order by updated_at desc",
            [studentId],
          );
        return {
          profile: profile.rows[0]?.payload ?? null,
          snapshot: snapshot.rows[0]?.payload ?? null,
          mastery: mastery.rows,
          retention: retention.rows,
          misconceptions: misconceptions.rows,
          profile_lag: snapshot.rows.length === 0,
        };
      });
      return out;
    });

    /** 过程性历史：快照链、计划版本、保持率与错因状态，供学生趋势和教师复核只读展示。 */
    app.get("/students/:studentId/history", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { studentId } = req.params as { studentId: string };
      return withTenant(pool, tenantId, async (c) => {
        const snapshots = await c.query("select payload from state_student_snapshot where student_id = $1 order by published_at desc limit 50", [studentId]);
        const plans = await c.query("select payload from state_learning_plan where student_id = $1 order by created_at desc limit 20", [studentId]);
        const retention = await c.query("select dimension_id,i90_posterior,next_review_due,stable,updated_at from state_retention_state where student_id = $1 order by updated_at desc", [studentId]);
        const misconceptions = await c.query("select error_cause_id,state,evidence_refs,updated_at from state_misconception_state where student_id = $1 order by updated_at desc", [studentId]);
        return {
          student_id: studentId,
          snapshots: snapshots.rows.map((r) => r.payload),
          plans: plans.rows.map((r) => r.payload),
          retention: retention.rows,
          misconceptions: misconceptions.rows,
        };
      });
    });

    /**
     * 学习计划生成（§10.3 / §7.3：画像子集，独立于 Dream）。
     * 确定性排布（planner.ts）+ plan skill 转写解释；LLM 不增删任务。
     */
    app.post("/students/:studentId/plans", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { studentId } = req.params as { studentId: string };
      const { horizon_weeks: horizonWeeks = 4 } = req.body as { horizon_weeks?: number };
      if (!Number.isInteger(horizonWeeks) || horizonWeeks < 1 || horizonWeeks > 4) {
        return reply.code(422).send({ error: "horizon_weeks must be 1-4" });
      }

      const facts = await withTenant(pool, tenantId, async (c) => {
        const profile = await c.query("select payload from state_student_profile where student_id = $1", [studentId]);
        const mastery = await c.query(
            "select dimension_id, p_profile, state from state_mastery_state where student_id = $1",
            [studentId],
          );
        const snapshot = await c.query(
            "select payload from state_student_snapshot where student_id = $1 order by published_at desc limit 1",
            [studentId],
          );
        return { profile: profile.rows[0]?.payload ?? null, mastery: mastery.rows, snapshot: snapshot.rows[0]?.payload ?? null };
      });
      if (!facts.profile) {
        return reply.code(422).send({ error: "profile_required", hint: "请先完成最小画像注册" });
      }

      const masteryView: Record<string, { state?: string; next_review_due_days?: number | null }> = {};
      for (const m of facts.mastery) masteryView[m.dimension_id] = { state: m.state };
      for (const dim of facts.snapshot?.dimensions ?? []) {
        masteryView[dim.dimension_id] = { state: dim.state };
      }

      const tasks = planFromProfile({
        horizon_weeks: horizonWeeks,
        weekly_hours: facts.profile.weekly_hours,
        target_score: facts.profile.target_score,
        current_score: facts.profile.current_score,
        self_weak: facts.profile.self_weak ?? [],
        mastery: masteryView,
      });

      // plan skill 转写（失败不阻塞计划生成：确定性任务已排，解释留空并标注）
      const planRes = await runtime.runTask({
        taskType: "plan",
        sessionRef: newId("pln"),
        tenantId,
        context: {
          studentProfile: "读取 ./input/student/profile.json",
          planDraft: "读取 ./input/plan/draft.json",
        },
        workspaceFiles: [
          { workspacePath: "student/profile.json", content: JSON.stringify({
            grade: facts.profile.grade,
            target_score: facts.profile.target_score,
            current_score: facts.profile.current_score,
            weekly_hours: facts.profile.weekly_hours,
            self_weak: facts.profile.self_weak,
          }, null, 2) },
          { workspacePath: "plan/draft.json", content: JSON.stringify(tasks.map((t, i) => ({ task_index: i, ...t })), null, 2) },
        ],
        promptText: "读取工作区中的程序画像与确定性计划草案，只为既有任务顺序生成解释。",
        databaseScope: { studentId },
        workspaceLifecycle: "terminal",
      });
      let explanation = "";
      let taskExplanations: Record<string, string> = {};
      if (planRes.ok) {
        const j = planRes.outputJson as { explanation?: string; task_explanations?: { task_index?: number; why?: string }[] } | undefined;
        explanation = j?.explanation ?? "";
        for (const e of j?.task_explanations ?? []) {
          if (e.task_index !== undefined) taskExplanations[String(e.task_index)] = e.why ?? "";
        }
      }
      const explained = tasks.map((t, i) => ({ ...t, ...(taskExplanations[String(i)] ? { why: taskExplanations[String(i)] } : {}) }));

      const planId = newId("pln");
      const payload = {
        plan_id: planId,
        student_id: studentId,
        tenant_id: tenantId,
        horizon_weeks: horizonWeeks,
        explanation,
        tasks: explained,
        plan_skipped: !planRes.ok ? planRes.error : undefined,
        created_at: new Date().toISOString(),
      };
      await withTenant(pool, tenantId, async (c) => {
        await c.query(
          `insert into state_learning_plan (plan_id, tenant_id, student_id, horizon_weeks, payload)
           values ($1,$2,$3,$4,$5)`,
          [planId, tenantId, studentId, horizonWeeks, JSON.stringify(payload)],
        );
      });
      return reply.send(payload);
    });

    app.get("/students/:studentId/plans", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { studentId } = req.params as { studentId: string };
      const row = await withTenant(pool, tenantId, async (c) => {
        const r = await c.query(
          "select payload from state_learning_plan where student_id = $1 order by created_at desc limit 1",
          [studentId],
        );
        return r.rows[0];
      });
      if (!row) return reply.code(404).send({ error: "no plan", hint: "请先生成学习计划" });
      return row.payload;
    });

    app.get("/snapshots/:studentId", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { studentId } = req.params as { studentId: string };
      const row = await withTenant(pool, tenantId, async (c) => {
        const r = await c.query(
          `select payload from state_student_snapshot
            where student_id = $1 order by published_at desc limit 1`,
          [studentId],
        );
        return r.rows[0];
      });
      if (!row) return reply.code(404).send({ error: "no snapshot", profile_lag: true });
      return row.payload;
    });

    /** 独立校验入口（评测/黄金集用）：对给定 PUD 跑 Validator，不写库。
     *  程序基准（Roster）与观测数从库中确定性计算；窗口会话集可显式传入
     *  （缺省为空集 → 数值调整的会话授权校验按传入集合判定）。 */
    app.post("/dream/validate", async (req, reply) => {
      const tenantId = tenantOf(req) ?? "tnt_dev00001";
      const body = req.body as PudPayload & { window_session_ids?: string[] };
      const pud = body as PudPayload;
      // refs_exist 以库中实际存在为准
      const existing = new Set<string>();
      const programBaselines = new Map<string, number>();
      const obsCounts = new Map<string, number>();
      const replayByDim = new Map<string, { observation_id: string; outcome: "success" | "failure"; supersedes: string | null }[]>();
      await withTenant(pool, tenantId, async (c) => {
        for (const id of pud.baseline_report_refs ?? []) {
          const r = await c.query(
            "select 1 from state_scientific_evaluation_report where report_id = $1", [id]);
          if (r.rows.length > 0) existing.add(id);
        }
        for (const id of pud.teaching_summary_refs ?? []) {
          const r = await c.query(
            "select 1 from runtime_teaching_session_summary where summary_id = $1", [id]);
          if (r.rows.length > 0) existing.add(id);
        }
        // 程序基准输入：该生该维度全部独立观测（含 supersede 关系）。先从 DB 取权威事实，
        // 再在事务外幂等推送到 Roster；容器首次启动时也不能依赖残留 JSONL 状态。
        for (const dim of new Set((pud.dimension_updates ?? []).map((du) => du.dimension_id))) {
          const rows = await c.query(
            `select observation_id, outcome, supersedes
               from runtime_state_observation
              where student_id = $1 and dimension_id = $2 and independent
                and outcome in ('success','failure')
              order by created_at, observation_id`,
            [pud.student_id, dim],
          );
          const observations = rows.rows as { observation_id: string; outcome: "success" | "failure"; supersedes: string | null }[];
          replayByDim.set(dim, observations);
          const superseded = new Set(observations.map((o) => o.supersedes).filter((x): x is string => Boolean(x)));
          obsCounts.set(dim, observations.filter((o) => !superseded.has(o.observation_id)).length);
        }
      });
      for (const [dim, observations] of replayByDim) {
        for (const o of observations) {
          const up = await rosterUpdate(pud.student_id, dim, o.outcome, o.observation_id, o.supersedes ?? undefined);
          if (!up.ok) {
            return reply.code(502).send({ error: "roster_update_failed", detail: `${up.error}: ${up.detail ?? ""}` });
          }
        }
        const g = await rosterGetMastery(pud.student_id, dim);
        if (!g.ok) return reply.code(502).send({ error: "roster_get_failed", detail: `${g.error}: ${g.detail ?? ""}` });
        if (g.value.p_mastery !== null) programBaselines.set(dim, g.value.p_mastery);
      }
      const checks = validatePud(pud, existing, programBaselines, obsCounts, new Set(body.window_session_ids ?? []));
      const passed = checks.every((ck) => ck.passed);
      return reply.send({ result: passed ? "passed" : "returned_to_model", checks, validator_version: VALIDATOR_VERSION });
    });

    app.post("/dream/run", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { student_id: studentId } = req.body as { student_id: string };
      const now = new Date().toISOString();
      const bundleId = newId("peb");
      const decisionId = newId("pud");
      const validationId = newId("pvr");
      const snapshotId = newId("snap");

      // ── 阶段 1（短事务，只读）：窗口 SLR + 先验 + 会话证据摘要 ──
      const read = await withTenant(pool, tenantId, async (c) => {
        const pending = await c.query(
          `select r.record_id, r.session_id, r.ser_id, r.tss_id,
                  s.payload->>'dimension_id' as dimension_id,
                  (s.payload->>'p_bkt_baseline')::float as p_bkt_baseline,
                  (s.payload->>'independent_observation_count')::int as obs_count
             from runtime_session_learning_record r
             join state_scientific_evaluation_report s on s.report_id = r.ser_id
            where r.student_id = $1 and r.dream_consumed_at is null and r.integrity_passed
            order by r.created_at`,
          [studentId],
        );
        if (pending.rows.length === 0) return { empty: true as const };
        const prior = await c.query(
          "select snapshot_id from state_student_snapshot where student_id = $1 order by published_at desc limit 1",
          [studentId],
        );
        const priorSnapshotId: string | null = prior.rows[0]?.snapshot_id ?? null;
        // Dream 改变既有结论时必须 supersede 旧 Decision（设计 §11.3），不覆盖历史
        const priorDecision = await c.query(
          "select decision_id from state_profile_update_decision where student_id = $1 order by created_at desc limit 1",
          [studentId],
        );
        const supersedesDecisionId: string | null = priorDecision.rows[0]?.decision_id ?? null;
        // Roster 权威重放输入：待处理维度的全部历史独立观测，而非仅本次窗口。
        // 这样 profile 容器/JSONL 状态重建后，程序基准仍与 DB 全历史一致；
        // supersedes 一并推送，由侧车排除被取代观测。
        const pendingDims = [...new Set(pending.rows.map((r) => r.dimension_id as string))];
        const obs = await c.query(
          `select observation_id, student_id, dimension_id, outcome, supersedes
             from runtime_state_observation o
            where o.student_id = $1 and o.dimension_id = any($2::text[])
              and o.outcome in ('success','failure')
              and o.independent
            order by o.created_at, o.observation_id`,
          [studentId, pendingDims],
        );
        // 证据索引（§11.3 Dream Context Compiler：按需回看的会话级索引）
        const sessions = await c.query(
          `select q.session_id,
                  (select jsonb_agg(jsonb_build_object('verdict', v.verdict, 'kind', v.payload->>'kind'))
                     from runtime_answer_verdict v where v.session_id = q.session_id) as verdicts,
                  (select payload from runtime_diagnostic_claim dc
                    where dc.session_id = q.session_id order by dc.created_at desc limit 1) as claim
             from runtime_question_session q where q.session_id = any($1)`,
          [pending.rows.map((r) => r.session_id)],
        );
        return {
          empty: false as const,
          pending: pending.rows,
          priorSnapshotId,
          supersedesDecisionId,
          observations: obs.rows,
          sessions: sessions.rows,
        };
      });
      if (read.empty) return reply.send({ status: "no_pending_records" });

      // ── 阶段 2（事务外）：侧车 Roster 程序基准 + Dream 画像大模型 ──
      // 程序基准（架构修订 v4 §3：pyBKT Roster 成品；失败显式 502，不静默回退）
      // 替代观测携带 supersedes 旧观测 ID（P0-8：Roster 重放排除被取代观测，与 DB 语义一致）
      const rosterBase = new Map<string, number>();
      for (const o of read.observations) {
        const up = await rosterUpdate(o.student_id, o.dimension_id, o.outcome, o.observation_id,
          o.supersedes ?? undefined);
        if (!up.ok) {
          return reply.code(502).send({ error: "roster_update_failed", detail: `${up.error}: ${up.detail ?? ""}` });
        }
      }
      const latestByDim = new Map<string, { p: number; count: number }>();
      for (const r of read.pending) {
        if (!rosterBase.has(r.dimension_id)) {
          const g = await rosterGetMastery(studentId, r.dimension_id);
          if (!g.ok) {
            return reply.code(502).send({ error: "roster_get_failed", detail: `${g.error}: ${g.detail ?? ""}` });
          }
          if (g.value.p_mastery === null) {
            return { ok: false, error: "roster_no_evidence", detail: `维度 ${r.dimension_id} 无独立有效观测可作 Roster 基准` };
          }
          rosterBase.set(r.dimension_id, g.value.p_mastery);
        }
        latestByDim.set(r.dimension_id, { p: rosterBase.get(r.dimension_id)!, count: r.obs_count });
      }

      const dreamRes = await runtime.runTask({
        taskType: "dream_profile",
        sessionRef: newId("dream"),
        tenantId,
        context: {
          profileWindow: "读取 ./input/student/profile-window.json；需要展开证据时按 database Skill 查询其中的稳定引用。",
          priorSnapshot: "读取 ./input/student/prior-snapshot.json",
          schemaNote: "p_baseline 为 pyBKT Roster 程序基准（与 SER 一致时使用 SER 值）",
        },
        workspaceFiles: [
          { workspacePath: "student/profile-window.json", content: JSON.stringify({
            records: read.pending.map((r) => ({
              record_id: r.record_id, session_id: r.session_id, ser_id: r.ser_id, tss_id: r.tss_id,
              dimension_id: r.dimension_id, p_bkt_baseline: rosterBase.get(r.dimension_id) ?? r.p_bkt_baseline,
              obs_count: r.obs_count,
            })),
            session_evidence_index: read.sessions,
          }, null, 2) },
          { workspacePath: "student/prior-snapshot.json", content: JSON.stringify({
            snapshot_id: read.priorSnapshotId,
            status: read.priorSnapshotId ? "available_by_database_reference" : "first_profile",
          }, null, 2) },
        ],
        promptText: "读取画像窗口、程序基准、会话证据索引和前序快照引用；仅在需要时通过只读数据库展开稳定引用并生成长期画像更新决策。",
        databaseScope: { studentId },
        workspaceLifecycle: "terminal",
      });
      if (!dreamRes.ok) {
        return reply.code(dreamRes.status ?? 502).send({ error: dreamRes.error, detail: dreamRes.detail });
      }
      const dreamJson = dreamRes.outputJson as {
        dimension_updates?: {
          dimension_id?: string; p_baseline?: number; p_final?: number; state_final?: string;
          evidence_ledger?: unknown[]; alternatives?: string[]; uncertainty?: string;
        }[];
        misconception_updates?: { error_cause_id?: string; state_final?: string; evidence_refs?: string[] }[];
        semantic_profile_updates?: unknown[];
        review_required?: boolean;
      };
      const updates = (dreamJson.dimension_updates ?? [])
        .filter((d) => d.dimension_id && latestByDim.has(d.dimension_id))
        .map((d) => {
          const base = latestByDim.get(d.dimension_id!)!;
          return {
            dimension_id: d.dimension_id!,
            // P0-8：不再静默替换模型自报基准——p_baseline 与 Roster 不一致由 Validator 拒绝
            p_baseline: d.p_baseline ?? base.p,
            p_final: d.p_final ?? base.p,
            state_final: d.state_final ?? masteryState(d.p_final ?? base.p, base.count),
            evidence_ledger: (d.evidence_ledger ?? []) as DimensionUpdate["evidence_ledger"],
            ...(d.alternatives ? { alternatives: d.alternatives } : {}),
            uncertainty: (d.uncertainty && ["low", "medium", "high"].includes(d.uncertainty) ? d.uncertainty : "high") as "low" | "medium" | "high",
          };
        });
      // 程序校验（设计 §9.3）：p_final 在 [0,1]、状态合法
      const invalid = updates.filter(
        (d) => !Number.isFinite(d.p_final) || d.p_final < 0 || d.p_final > 1
          || !["insufficient_evidence", "weak", "learning", "possibly_mastered", "mastered"].includes(d.state_final),
      );
      if (invalid.length > 0) {
        return reply.code(422).send({ error: "dream_output_invalid", detail: `dimension_updates 越界: ${invalid.map((d) => d.dimension_id).join(",")}` });
      }
      // 覆盖校验（P0-8）：模型漏掉待处理维度（或更新了非待处理维度）→ 立即退回，不物化
      const pendingDims = new Set(read.pending.map((r) => r.dimension_id));
      const updatedDims = new Set(updates.map((d) => d.dimension_id));
      const missingDims = [...pendingDims].filter((d) => !updatedDims.has(d));
      const strayDims = [...updatedDims].filter((d) => !pendingDims.has(d));
      if (missingDims.length > 0 || strayDims.length > 0) {
        return reply.code(422).send({
          error: "dream_output_incomplete",
          detail: `dimension_updates 未覆盖全部待处理维度（缺 ${missingDims.join(",") || "无"}；多 ${strayDims.join(",") || "无"}）`,
        });
      }

      // ── 阶段 3（写事务）：Bundle + PUD + Validation + 物化 + 消费 ──
      const evidenceIndex = read.sessions.map((s) => ({
        session_id: s.session_id,
        verdicts: s.verdicts ?? [],
        claim: s.claim ? { status: s.claim.status, candidates: s.claim.candidates, probe_history: s.claim.probe_history } : null,
      }));
      const out = await withTenant(pool, tenantId, async (c) => {
        await c.query(
          `insert into state_profile_evidence_bundle (bundle_id, tenant_id, student_id, prior_snapshot_id, trigger, payload)
           values ($1,$2,$3,$4,'teacher_request',$5)`,
          [bundleId, tenantId, studentId, read.priorSnapshotId,
           JSON.stringify({
             bundle_id: bundleId,
             student_id: studentId,
             window: { from: now, to: now, trigger: "teacher_request" },
             prior_snapshot_id: read.priorSnapshotId,
             records: read.pending.map((r) => ({ record_id: r.record_id, session_id: r.session_id, ser_id: r.ser_id, tss_id: r.tss_id })),
             evidence_index: evidenceIndex,
             roster_baselines: Object.fromEntries(rosterBase),
             permission_scope: { tenant_id: tenantId, redactions: [] },
             created_at: now,
           })],
        );

        const pud: PudPayload = {
          decision_id: decisionId,
          student_id: studentId,
          evidence_bundle_id: bundleId,
          prior_snapshot_id: read.priorSnapshotId,
          supersedes: read.supersedesDecisionId,
          baseline_report_refs: read.pending.map((r) => r.ser_id),
          teaching_summary_refs: read.pending.map((r) => r.tss_id),
          dimension_updates: updates,
          semantic_profile_updates: dreamJson.semantic_profile_updates ?? [],
          review_required: dreamJson.review_required ?? false,
          model_id: dreamRes.implementation ?? "pi.unknown",
          prompt_version: dreamRes.promptVersion ?? "unknown",
          skill_version: "profile-skill@0.3.0",
          created_at: now,
        };

        const existingRefs = new Set<string>();
        for (const r of read.pending) { existingRefs.add(r.ser_id); existingRefs.add(r.tss_id); }
        // P0-8：程序基准（Roster）、观测数与窗口会话集传入 Validator
        const obsCounts = new Map<string, number>();
        for (const [dim, v] of latestByDim) obsCounts.set(dim, v.count);
        const windowSessions = new Set(read.pending.map((r) => r.session_id));
        const checks = validatePud(pud, existingRefs, rosterBase, obsCounts, windowSessions);
        const passed = checks.every((ck) => ck.passed);

        // 模型声明需要教师复核：不物化快照、不消费 SLR（设计 §9.3：送教师复核）
        if (pud.review_required) {
          await c.query(
            `insert into state_profile_update_decision
               (decision_id, tenant_id, student_id, evidence_bundle_id, prior_snapshot_id, supersedes,
                review_required, model_id, prompt_version, skill_version, payload)
             values ($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$10)`,
            [decisionId, tenantId, studentId, bundleId, read.priorSnapshotId, read.supersedesDecisionId,
             pud.model_id, pud.prompt_version, pud.skill_version, JSON.stringify(pud)],
          );
          await c.query(
            `insert into state_profile_decision_validation
               (validation_id, tenant_id, decision_id, result, validator_version, payload)
             values ($1,$2,$3,'escalated_to_teacher',$4,$5)`,
            [validationId, tenantId, decisionId, VALIDATOR_VERSION,
             JSON.stringify({ validation_id: validationId, decision_id: decisionId, result: "escalated_to_teacher", checks, validator_version: VALIDATOR_VERSION, validated_at: now })],
          );
          return {
            status: 202 as const,
            body: {
              decision_id: decisionId,
              review_required: true,
              escalated: true,
              detail: "模型声明需教师复核：未物化快照，SLR 保留待复核后重跑",
            },
          };
        }

        const result = passed ? "passed" : "returned_to_model";

        await c.query(
          `insert into state_profile_update_decision
             (decision_id, tenant_id, student_id, evidence_bundle_id, prior_snapshot_id, supersedes,
              review_required, model_id, prompt_version, skill_version, payload)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [decisionId, tenantId, studentId, bundleId, read.priorSnapshotId, read.supersedesDecisionId,
           pud.review_required, pud.model_id, pud.prompt_version, pud.skill_version, JSON.stringify(pud)],
        );
        await c.query(
          `insert into state_profile_decision_validation
             (validation_id, tenant_id, decision_id, result, validator_version, payload)
           values ($1,$2,$3,$4,$5,$6)`,
          [validationId, tenantId, decisionId, result, VALIDATOR_VERSION,
           JSON.stringify({ validation_id: validationId, decision_id: decisionId, result, checks, validator_version: VALIDATOR_VERSION, validated_at: now })],
        );

        if (!passed) {
          return { status: 422 as const, body: { error: "validation_failed", validation_id: validationId, checks } };
        }

        // 物化：reducer 原样落库，不重新决策（ADR-004）
        const dimensions = pud.dimension_updates.map((d) => ({
          dimension_id: d.dimension_id,
          p_profile: d.p_final,
          p_bkt_baseline: d.p_baseline,
          state: d.state_final,
          uncertainty: d.uncertainty,
          independent_observation_count: latestByDim.get(d.dimension_id)?.count ?? 0,
        }));
        // 错因六档物化（P1-5/§9.7）：Dream 输出的 misconception_updates 经状态白名单校验后落库
        const misconceptionUpdates = (dreamJson.misconception_updates ?? [])
          .filter((m): m is { error_cause_id: string; state_final: string; evidence_refs?: string[] } =>
            typeof m.error_cause_id === "string"
            && ["suspected", "confirmed", "improving", "resolved", "superseded"].includes(m.state_final ?? ""));
        for (const m of misconceptionUpdates) {
          await c.query(
            `insert into state_misconception_state (tenant_id, student_id, error_cause_id, state, evidence_refs, updated_at)
             values ($1,$2,$3,$4,$5::jsonb,now())
             on conflict (student_id, error_cause_id)
             do update set state = excluded.state, evidence_refs = excluded.evidence_refs, updated_at = now()`,
            [tenantId, studentId, m.error_cause_id, m.state_final, JSON.stringify(m.evidence_refs ?? [])],
          );
        }
        const snapshotPayload = {
          snapshot_id: snapshotId,
          student_id: studentId,
          source_decision_id: decisionId,
          supersedes: read.priorSnapshotId,
          dimensions,
          misconceptions: misconceptionUpdates,
          semantic_profile: {},
          profile_lag: false,
          published_at: now,
        };
        await c.query(
          `insert into state_student_snapshot
             (snapshot_id, tenant_id, student_id, source_decision_id, supersedes, profile_lag, payload)
           values ($1,$2,$3,$4,$5,false,$6)`,
          [snapshotId, tenantId, studentId, decisionId, read.priorSnapshotId, JSON.stringify(snapshotPayload)],
        );
        for (const d of dimensions) {
          await c.query(
            `insert into state_mastery_state (tenant_id, student_id, dimension_id, p_profile, state, source_decision_id)
             values ($1,$2,$3,$4,$5,$6)
             on conflict (student_id, dimension_id)
             do update set p_profile = excluded.p_profile, state = excluded.state,
                           source_decision_id = excluded.source_decision_id, updated_at = now()`,
            [tenantId, studentId, d.dimension_id, d.p_profile, d.state, decisionId],
          );
        }
        // 只消费本次实际处理的记录（P1-3 并发守卫）：条件更新 + 行数校验，
        // 并发窗口下重复消费 → 409 回滚（本事务抛错触发 withTenant rollback）
        const consumed = await c.query(
          "update runtime_session_learning_record set dream_consumed_at = now() where record_id = any($1::text[]) and dream_consumed_at is null",
          [read.pending.map((r) => r.record_id)],
        );
        if ((consumed.rowCount ?? 0) !== read.pending.length) {
          throw new Error(`concurrent_dream_consumption: expected ${read.pending.length}, consumed ${consumed.rowCount}`);
        }

        return {
          status: 200 as const,
          body: {
            decision_id: decisionId,
            supersedes_decision: read.supersedesDecisionId,
            validation: { result, checks },
            snapshot_id: snapshotId,
            supersedes_snapshot: read.priorSnapshotId,
            consumed_records: read.pending.length,
            dimensions,
          },
        };
      });

      // 复核升级：登记教师复核任务（提交事务之后）
      if (out.status === 202) {
        const taskRes = await fetch(`${REVIEW_URL}/review/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-tenant-id": tenantId },
          body: JSON.stringify({
            queue: "student_diagnosis",
            target_type: "profile_update_decision",
            target_id: (out.body as { decision_id: string }).decision_id,
            payload: { reason: "dream_review_required" },
          }),
          signal: AbortSignal.timeout(10_000),
        }).catch(() => null);
        if (!taskRes?.ok) {
          return reply.code(502).send({ error: "review_task_registration_failed", decision_id: (out.body as { decision_id: string }).decision_id });
        }
        (out.body as { review_task_id?: string }).review_task_id = ((await taskRes.json()) as { task_id: string }).task_id;
      }

      return reply.code(out.status).send(out.body);
    });
  },
});
