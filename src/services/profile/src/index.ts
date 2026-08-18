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
import { createAgentRuntimeClient } from "@agmath/providers-model";
import { masteryState } from "@agmath/mastery";
import { planFromProfile } from "./planner.ts";
import { rosterGetMastery, rosterUpdate } from "./bkt-sidecar.ts";

const pool = createPool(process.env.DATABASE_URL ?? "postgres://localhost:5432/agmath");
/** 模型调用统一经 agent-runtime（Pi 宿主）；本服务不直连任何模型供应商 */
const AGENT_RUNTIME_URL = process.env.AGENT_RUNTIME_URL ?? "http://localhost:3005";
const REVIEW_URL = process.env.REVIEW_URL ?? "http://localhost:3008";
const runtime = createAgentRuntimeClient({ baseUrl: AGENT_RUNTIME_URL });

/** 版本化证据码 LR 区间（设计 §9.4，首版 prior_only 专家先验） */
const EVIDENCE_CODE_LR: Record<string, [number, number]> = {
  TRANSFER_SUCCESS_DISTINCT_CONTEXT: [2.0, 4.0],
  SELF_CORRECTION_RECURS: [1.3, 2.0],
  METHOD_STABLE_ACROSS_CONTEXTS: [1.3, 2.0],
  HINT_DEPENDENCY_DECLINES: [1.1, 1.5],
  REPEATED_MISCONCEPTION: [0.25, 0.5],
  TRANSFER_FAILURE_DISTINCT_CONTEXT: [0.25, 0.5],
  METHOD_INSTABILITY: [0.5, 0.8],
};

const VALIDATOR_VERSION = "profile-validator-0.1.0";

interface DimensionUpdate {
  dimension_id: string;
  p_baseline: number;
  p_final: number;
  state_final: string;
  evidence_ledger: {
    code: string;
    rubric_bin: string;
    lr_used: number;
    session_refs: string[];
    evidence_refs: string[];
    counterevidence_refs?: string[];
    explanation: string;
  }[];
  alternatives?: string[];
  uncertainty: "low" | "medium" | "high";
}

interface PudPayload {
  decision_id: string;
  student_id: string;
  evidence_bundle_id?: string;
  prior_snapshot_id: string | null;
  supersedes?: string | null;
  baseline_report_refs: string[];
  teaching_summary_refs: string[];
  dimension_updates: DimensionUpdate[];
  semantic_profile_updates: unknown[];
  review_required: boolean;
  model_id: string;
  prompt_version: string;
  skill_version: string;
  created_at: string;
}

interface ValidationCheck {
  check: string;
  passed: boolean;
  failures?: string[];
}

function logit(p: number): number {
  const c = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  return Math.log(c / (1 - c));
}

/** 确定性 Validator：只校验（引用/区间/算术/双 Session），不得修改 Decision（设计 §9.4） */
function validatePud(pud: PudPayload, existingRefs: Set<string>): ValidationCheck[] {
  const refFailures: string[] = [];
  for (const r of [...pud.baseline_report_refs, ...pud.teaching_summary_refs]) {
    if (!existingRefs.has(r)) refFailures.push(r);
  }

  const lrFailures: string[] = [];
  const arithFailures: string[] = [];
  const sessionFailures: string[] = [];
  const codeSeen = new Set<string>();
  const dupFailures: string[] = [];

  for (const du of pud.dimension_updates) {
    let sumLogLr = 0;
    for (const e of du.evidence_ledger) {
      const range = EVIDENCE_CODE_LR[e.code];
      if (!range) lrFailures.push(`${e.code}: unknown evidence code`);
      else if (e.lr_used < range[0] || e.lr_used > range[1]) {
        lrFailures.push(`${e.code}: lr ${e.lr_used} outside [${range[0]}, ${range[1]}]`);
      }
      if (codeSeen.has(`${du.dimension_id}:${e.code}`)) {
        dupFailures.push(`${du.dimension_id}:${e.code} double counted`);
      }
      codeSeen.add(`${du.dimension_id}:${e.code}`);
      sumLogLr += Math.log(e.lr_used);
      if (Math.abs(du.p_final - du.p_baseline) > 1e-9 && e.session_refs.length < 2) {
        sessionFailures.push(`${du.dimension_id}: numeric update requires >=2 distinct sessions`);
      }
    }
    const expected = 1 / (1 + Math.exp(-(logit(du.p_baseline) + sumLogLr)));
    if (Math.abs(expected - du.p_final) > 0.01) {
      arithFailures.push(`${du.dimension_id}: p_final ${du.p_final} != recomputed ${expected.toFixed(4)}`);
    }
  }

  return [
    { check: "refs_exist_and_authorized", passed: refFailures.length === 0, ...(refFailures.length ? { failures: refFailures } : {}) },
    { check: "provenance_complete", passed: Boolean(pud.model_id && pud.prompt_version && pud.skill_version) },
    { check: "lr_within_allowed_range", passed: lrFailures.length === 0, ...(lrFailures.length ? { failures: lrFailures } : {}) },
    { check: "arithmetic_recomputable", passed: arithFailures.length === 0, ...(arithFailures.length ? { failures: arithFailures } : {}) },
    { check: "no_double_counting", passed: dupFailures.length === 0, ...(dupFailures.length ? { failures: dupFailures } : {}) },
    { check: "min_two_sessions_per_numeric_update", passed: sessionFailures.length === 0, ...(sessionFailures.length ? { failures: sessionFailures } : {}) },
    { check: "update_magnitude_review_threshold", passed: pud.dimension_updates.every((d) => Math.abs(d.p_final - d.p_baseline) < 0.5) || pud.review_required },
  ];
}

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
        const [profile, snapshot, mastery, retention, misconceptions] = await Promise.all([
          c.query("select payload from state_student_profile where student_id = $1", [studentId]),
          c.query(
            "select payload from state_student_snapshot where student_id = $1 order by published_at desc limit 1",
            [studentId],
          ),
          c.query(
            "select dimension_id, p_profile, state, updated_at from state_mastery_state where student_id = $1",
            [studentId],
          ),
          c.query(
            "select dimension_id, i90_posterior, next_review_due, stable from state_retention_state where student_id = $1",
            [studentId],
          ),
          c.query(
            "select error_cause_id, state, evidence_refs, updated_at from state_misconception_state where student_id = $1 order by updated_at desc",
            [studentId],
          ),
        ]);
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
        const [profile, mastery, snapshot] = await Promise.all([
          c.query("select payload from state_student_profile where student_id = $1", [studentId]),
          c.query(
            "select dimension_id, p_profile, state from state_mastery_state where student_id = $1",
            [studentId],
          ),
          c.query(
            "select payload from state_student_snapshot where student_id = $1 order by published_at desc limit 1",
            [studentId],
          ),
        ]);
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
          studentProfile: JSON.stringify({
            grade: facts.profile.grade,
            target_score: facts.profile.target_score,
            current_score: facts.profile.current_score,
            weekly_hours: facts.profile.weekly_hours,
            self_weak: facts.profile.self_weak,
          }),
          planDraft: JSON.stringify(tasks.map((t, i) => ({ task_index: i, ...t }))),
        },
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

    /** 独立校验入口（评测/黄金集用）：对给定 PUD 跑 Validator，不写库 */
    app.post("/dream/validate", async (req, reply) => {
      const tenantId = tenantOf(req) ?? "tnt_dev00001";
      const pud = req.body as PudPayload;
      // refs_exist 以库中实际存在为准
      const existing = new Set<string>();
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
      }).catch(() => undefined);
      const checks = validatePud(pud, existing);
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
        // 窗口观测（供侧车 Roster 推送与证据索引）
        const obs = await c.query(
          `select observation_id, student_id, dimension_id, outcome
             from runtime_state_observation o
            where o.student_id = $1 and o.session_id = any($2)
              and o.outcome in ('success','failure')
              and o.independent
              and not exists (
                select 1 from runtime_state_observation o2 where o2.supersedes = o.observation_id
              )`,
          [studentId, pending.rows.map((r) => r.session_id)],
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
      const rosterBase = new Map<string, number>();
      for (const o of read.observations) {
        const up = await rosterUpdate(o.student_id, o.dimension_id, o.outcome, o.observation_id);
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
          rosterBase.set(r.dimension_id, g.value.p_mastery ?? r.p_bkt_baseline);
        }
        latestByDim.set(r.dimension_id, { p: rosterBase.get(r.dimension_id)!, count: r.obs_count });
      }

      const dreamRes = await runtime.runTask({
        taskType: "dream_profile",
        sessionRef: newId("dream"),
        tenantId,
        context: {
          profileWindow: JSON.stringify({
            records: read.pending.map((r) => ({
              record_id: r.record_id, session_id: r.session_id, ser_id: r.ser_id, tss_id: r.tss_id,
              dimension_id: r.dimension_id, p_bkt_baseline: rosterBase.get(r.dimension_id) ?? r.p_bkt_baseline,
              obs_count: r.obs_count,
            })),
          }),
          priorSnapshot: read.priorSnapshotId ? `上一个快照：${read.priorSnapshotId}` : "（首次画像，无前快照）",
          schemaNote: "p_baseline 为 pyBKT Roster 程序基准（与 SER 一致时使用 SER 值）",
        },
      });
      if (!dreamRes.ok) {
        return reply.code(dreamRes.status ?? 502).send({ error: dreamRes.error, detail: dreamRes.detail });
      }
      const dreamJson = dreamRes.outputJson as {
        dimension_updates?: {
          dimension_id?: string; p_baseline?: number; p_final?: number; state_final?: string;
          evidence_ledger?: unknown[]; alternatives?: string[]; uncertainty?: string;
        }[];
        semantic_profile_updates?: unknown[];
        review_required?: boolean;
      };
      const updates = (dreamJson.dimension_updates ?? [])
        .filter((d) => d.dimension_id && latestByDim.has(d.dimension_id))
        .map((d) => {
          const base = latestByDim.get(d.dimension_id!)!;
          return {
            dimension_id: d.dimension_id!,
            p_baseline: Math.abs((d.p_baseline ?? base.p) - base.p) < 0.001 ? base.p : (d.p_baseline ?? base.p),
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
        const checks = validatePud(pud, existingRefs);
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
        const snapshotPayload = {
          snapshot_id: snapshotId,
          student_id: studentId,
          source_decision_id: decisionId,
          supersedes: read.priorSnapshotId,
          dimensions,
          misconceptions: [],
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
        // 只消费本次实际处理的记录：TOCTOU 窗口内新入队或 integrity 失败的 SLR 绝不能被静默标记
        await c.query(
          "update runtime_session_learning_record set dream_consumed_at = now() where record_id = any($1::text[])",
          [read.pending.map((r) => r.record_id)],
        );

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
