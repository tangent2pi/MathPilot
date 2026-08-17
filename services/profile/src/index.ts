/**
 * profile-service：画像快照查询 + Dream 消费闭环（WP-08 骨架）。
 *
 * POST /dream/run 消费该学生未处理的 SLR：
 *   SLR → ProfileEvidenceBundle → fake Dream PUD（保守：无跨题纵向证据时
 *   p_final = p_bkt_baseline）→ 确定性 Validator（引用/区间/算术/双 Session）
 *   → 通过后物化 StudentSnapshot 并更新 mastery_state。
 * 纪律（ADR-004）：Validator 只校验不修改；本服务是 StudentSnapshot 唯一写入方。
 */
import { startService, createPool, withTenant, newId } from "@agmath/service-kit";
import { masteryState } from "@agmath/mastery";

const pool = createPool(process.env.DATABASE_URL ?? "postgres://localhost:5432/agmath");

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

/** 确定性 Validator：只校验（引用/区间/算术/双 Session），不得修改 Decision */
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

      const out = await withTenant(pool, tenantId, async (c) => {
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
        if (pending.rows.length === 0) return { status: 200 as const, body: { status: "no_pending_records" } };

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

        await c.query(
          `insert into state_profile_evidence_bundle (bundle_id, tenant_id, student_id, prior_snapshot_id, trigger, payload)
           values ($1,$2,$3,$4,'teacher_request',$5)`,
          [bundleId, tenantId, studentId, priorSnapshotId,
           JSON.stringify({
             bundle_id: bundleId,
             student_id: studentId,
             window: { from: now, to: now, trigger: "teacher_request" },
             prior_snapshot_id: priorSnapshotId,
             records: pending.rows.map((r) => ({ record_id: r.record_id, session_id: r.session_id, ser_id: r.ser_id, tss_id: r.tss_id })),
             evidence_index: [],
             permission_scope: { tenant_id: tenantId, redactions: [] },
             created_at: now,
           })],
        );

        // fake Dream：每维度取最新 SER 基准；无跨题纵向证据时保持基准（设计 §9.3：证据不足不调整）
        const latestByDim = new Map<string, { p: number; count: number }>();
        for (const r of pending.rows) latestByDim.set(r.dimension_id, { p: r.p_bkt_baseline, count: r.obs_count });

        const pud: PudPayload = {
          decision_id: decisionId,
          student_id: studentId,
          evidence_bundle_id: bundleId,
          prior_snapshot_id: priorSnapshotId,
          supersedes: supersedesDecisionId,
          baseline_report_refs: pending.rows.map((r) => r.ser_id),
          teaching_summary_refs: pending.rows.map((r) => r.tss_id),
          dimension_updates: [...latestByDim.entries()].map(([dim, v]) => ({
            dimension_id: dim,
            p_baseline: v.p,
            p_final: v.p,
            state_final: masteryState(v.p, v.count),
            evidence_ledger: [],
            alternatives: ["尚无跨题纵向证据，维持程序基准"],
            uncertainty: "high" as const,
          })),
          semantic_profile_updates: [],
          review_required: false,
          model_id: "fake.dream",
          prompt_version: "fake-dream@0.1.0",
          skill_version: "profile-skill@0.1.0",
          created_at: now,
        };

        const existingRefs = new Set<string>();
        for (const r of pending.rows) { existingRefs.add(r.ser_id); existingRefs.add(r.tss_id); }
        const checks = validatePud(pud, existingRefs);
        const passed = checks.every((ck) => ck.passed);
        const result = passed ? "passed" : "returned_to_model";

        await c.query(
          `insert into state_profile_update_decision
             (decision_id, tenant_id, student_id, evidence_bundle_id, prior_snapshot_id, supersedes,
              review_required, model_id, prompt_version, skill_version, payload)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [decisionId, tenantId, studentId, bundleId, priorSnapshotId, supersedesDecisionId,
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

        // 物化：reducer 原样落库，不重新决策
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
          supersedes: priorSnapshotId,
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
          [snapshotId, tenantId, studentId, decisionId, priorSnapshotId, JSON.stringify(snapshotPayload)],
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
          [pending.rows.map((r) => r.record_id)],
        );

        return {
          status: 200 as const,
          body: {
            decision_id: decisionId,
            supersedes_decision: supersedesDecisionId,
            validation: { result, checks },
            snapshot_id: snapshotId,
            supersedes_snapshot: priorSnapshotId,
            consumed_records: pending.rows.length,
            dimensions,
          },
        };
      });

      return reply.code(out.status).send(out.body);
    });
  },
});
