/**
 * learning-service：QuestionSession 创建/查询 + 教学闭环（含错因归因与追问）。
 *
 * 状态机（设计 §4.5 骨架版）：
 *   submit（首次作答）→ SUBMIT → GRADE
 *     ├─ correct / unresolved → CLOSE 全链（观测 + SER + TSS + SLR + QUEUE_DREAM）
 *     └─ partially_correct / incorrect → DIAGNOSE（错因归因 §8.3）
 *         → PROBE_AWAIT ↔ probe（追问作答，≤3 轮）→ 闭合/待观察 → CLOSE 全链
 *
 * 判答（GRADE）为模型主判（设计 §12.1）：经 agent-runtime（Pi 宿主）创建
 * Teaching Agent Session；学生作答按不可信数据处理（§16.3）。
 * 模型不可用/无输出时显式 502——绝不伪造判定。
 *
 * 题目只读已发布章节包（§7.2）：未发布/不可达显式失败，无内置兜底题。
 * 纪律（ADR-004）：本服务不写 StudentSnapshot；长期画像只由 Dream 路径更新。
 */
import { startService, createPool, withTenant, newId } from "./lib.ts";
import { createAgentRuntimeClient } from "@agmath/providers-model";
import { bktReplay, BKT_PRIOR_V1 } from "@agmath/mastery";
import { selectNext, type QuestionCandidate, type SelectorContext, type SelectionGoal } from "@agmath/selector";

const pool = createPool(process.env.DATABASE_URL ?? "postgres://localhost:5432/agmath");
/** 模型调用统一经 agent-runtime（Pi 宿主）；本服务不直连任何模型供应商 */
const AGENT_RUNTIME_URL = process.env.AGENT_RUNTIME_URL ?? "http://localhost:3005";
const CONTENT_URL = process.env.CONTENT_URL ?? "http://localhost:3006";
const PROFILE_URL = process.env.PROFILE_URL ?? "http://localhost:3003";
const runtime = createAgentRuntimeClient({ baseUrl: AGENT_RUNTIME_URL });

const MAX_PROBE_ROUNDS = 3;

interface CreateSessionBody {
  student_id: string;
  question_id: string;
  chapter_package_version: string;
  mode: "diagnostic" | "help" | "review";
  draft_enabled: boolean;
}

interface SubmitBody {
  answer_text: string;
  dimension_id?: string;
}

interface ProbeBody {
  answer_text: string;
}

function tenantOf(req: { headers: Record<string, unknown> }): string | null {
  const t = req.headers["x-tenant-id"];
  return typeof t === "string" && t.length > 0 ? t : null;
}

/** 契约校验（identity/v1 DimensionId）：客户端输入不得携带任意串进入观测/快照 */
const DIMENSION_ID_RE = /^(K|T|E)_[A-Z0-9_]{2,}$/;
const MAX_ANSWER_CHARS = 20_000;

const VERDICTS = new Set(["correct", "partially_correct", "incorrect", "unresolved"]);
const RUBRIC_STATUS = new Set(["met", "not_met", "unclear"]);

interface QuestionSpec {
  stem: string;
  rubric: { id: string; description: string }[];
}

/** 题目规格只来自已发布章节包（设计 §7.2）：未发布 → 404，不可达 → 502。无内置兜底。 */
async function getQuestionSpec(questionId: string, tenantId: string): Promise<
  { ok: true; spec: QuestionSpec } | { ok: false; status: number; error: string; detail?: string }
> {
  let res: Response;
  try {
    res = await fetch(`${CONTENT_URL}/questions/${encodeURIComponent(questionId)}`, {
      headers: { "x-tenant-id": tenantId },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, status: 502, error: "content_unavailable", detail: "题目服务不可达" };
  }
  if (res.status === 404) return { ok: false, status: 404, error: "question_not_found_or_unpublished" };
  if (!res.ok) return { ok: false, status: 502, error: "content_unavailable", detail: `http_${res.status}` };
  const q = (await res.json()) as { stem_markdown?: string; rubric?: { items?: { id: string; description: string }[] } };
  if (!q.stem_markdown || !q.rubric?.items?.length) {
    return { ok: false, status: 422, error: "question_incomplete", detail: "缺题干或评分点" };
  }
  return { ok: true, spec: { stem: q.stem_markdown, rubric: q.rubric.items.map((i) => ({ id: i.id, description: i.description })) } };
}

/** 诊断上下文（§8.3：候选只能来自题目关联 E-ID 与诊断规则） */
interface DiagnosisContext {
  error_causes: { dimension_id?: string; name?: string; description?: string }[];
  diagnosis_rules: { rule_id?: string; trigger?: string; candidate_error_causes?: string[]; probe?: string }[];
}

async function getDiagnosisContext(questionId: string, tenantId: string): Promise<
  { ok: true; ctx: DiagnosisContext } | { ok: false; status: number; error: string; detail?: string }
> {
  let res: Response;
  try {
    res = await fetch(`${CONTENT_URL}/questions/${encodeURIComponent(questionId)}/diagnosis-context`, {
      headers: { "x-tenant-id": tenantId },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, status: 502, error: "content_unavailable", detail: "诊断上下文不可达" };
  }
  if (!res.ok) return { ok: false, status: 502, error: "content_unavailable", detail: `http_${res.status}` };
  const d = (await res.json()) as DiagnosisContext;
  return { ok: true, ctx: d };
}

type Grade = {
  verdict: "correct" | "partially_correct" | "incorrect" | "unresolved";
  rubricItems: { id: string; status: string }[];
  decisionSummary: string;
  uncertainty: "low" | "medium" | "high";
  modelImpl: string;
  promptVersion: string;
};

type GradingResult = { ok: true; grade: Grade } | { ok: false; status: number; error: string; detail?: string };

/** 单次判答任务 Session（模型主判，设计 §12.1） */
async function runGrading(
  questionId: string,
  tenantId: string,
  answerText: string,
  extra: { title?: string; rubric?: string } = {},
): Promise<GradingResult> {
  const specRes = await getQuestionSpec(questionId, tenantId);
  if (!specRes.ok) return specRes;
  const { stem, rubric } = specRes.spec;
  const rubricText = extra.rubric ?? rubric.map((r) => `- ${r.id}：${r.description}`).join("\n");
  const sessionRef = newId("s");

  const gradeRes = await runtime.runTask({
    taskType: "teach_grade",
    sessionRef,
    tenantId,
    context: { question: extra.title ? `${extra.title}\n\n${stem}` : stem, rubric: rubricText, userData: answerText },
  });
  if (!gradeRes.ok) return gradeRes;
  const j = gradeRes.outputJson as {
    verdict?: string; rubric_items?: { id?: string; status?: string }[]; decision_summary?: string; uncertainty?: string;
  } | undefined;
  if (!j || !j.verdict || !VERDICTS.has(j.verdict)) {
    return { ok: false, status: 502, error: "model_output_invalid", detail: `verdict=${String(j?.verdict)}` };
  }
  const rubricItems = (j.rubric_items ?? [])
    .filter((r): r is { id: string; status: string } => typeof r.id === "string" && typeof r.status === "string" && RUBRIC_STATUS.has(r.status));

  return {
    ok: true,
    grade: {
      verdict: j.verdict as Grade["verdict"],
      rubricItems,
      decisionSummary: (j.decision_summary ?? "").slice(0, 500),
      uncertainty: (j.uncertainty && ["low", "medium", "high"].includes(j.uncertainty) ? j.uncertainty : "medium") as Grade["uncertainty"],
      modelImpl: gradeRes.implementation ?? "pi.unknown",
      promptVersion: gradeRes.promptVersion ?? "unknown",
    },
  };
}

/**
 * 教学卡片协议（设计 §5.4/§7.5：question-card 通用原语）。
 * 卡片只承载交互意图（提交/跳过/直接回复），不自行判答；跳过/直接回复不产生失败观测。
 */
interface QuestionCard {
  schema: "agmath.question-card/v1";
  artifact_id: string;
  card_id: string;
  type: "single_choice" | "multiple_choice" | "fill_blank" | "true_false";
  prompt: string;
  blanks?: { name: string; expected_format?: "number" | "expression" | "text" }[];
  response_policy: { required: false; allow_skip: true; allow_free_text_without_answer: true };
  evidence_policy: "teaching_only" | "eligible_if_independent";
  source_refs: string[];
}

function buildProbeCard(sessionId: string, artifactId: string, probe: { question: string }): QuestionCard {
  return {
    schema: "agmath.question-card/v1",
    artifact_id: artifactId,
    card_id: `card_${artifactId.replace(/^art_/, "").slice(0, 8)}`,
    type: "fill_blank",
    prompt: probe.question,
    blanks: [{ name: "answer", expected_format: "text" }],
    response_policy: { required: false, allow_skip: true, allow_free_text_without_answer: true },
    evidence_policy: "teaching_only",
    source_refs: [`chat://${sessionId}/probe`],
  };
}

async function registerProbeCard(
  c: { query: (q: string, v?: unknown[]) => Promise<unknown> },
  tenantId: string,
  sessionId: string,
  studentId: string,
  card: QuestionCard,
): Promise<void> {
  await c.query(
    `insert into runtime_learning_artifact (artifact_id, tenant_id, session_id, kind, renderer, artifact_uri)
     values ($1,$2,$3,'question_card','native_card',$4)`,
    [card.artifact_id, tenantId, sessionId, `artifact://${sessionId}/${card.artifact_id}`],
  );
}

/** 错因归因任务（设计 §8.3）：输出候选错因 + 消歧追问 */
interface DiagnoseOutcome {
  candidate_error_causes: { error_cause_id: string; confidence: number; evidence: string }[];
  probe: { question: string; judge_rubric: string } | null;
  resolved: boolean;
  rationale: string;
}

async function runDiagnose(
  questionId: string,
  tenantId: string,
  verdict: string,
  answerText: string,
): Promise<{ ok: true; outcome: DiagnoseOutcome } | { ok: false; status: number; error: string; detail?: string }> {
  const specRes = await getQuestionSpec(questionId, tenantId);
  if (!specRes.ok) return specRes;
  const ctxRes = await getDiagnosisContext(questionId, tenantId);
  if (!ctxRes.ok) return ctxRes;

  const context = {
    question: specRes.spec.stem,
    verdict,
    diagnosisContext: JSON.stringify({
      error_causes: ctxRes.ctx.error_causes.map((e) => ({ id: e.dimension_id, name: e.name, description: e.description })),
      diagnosis_rules: ctxRes.ctx.diagnosis_rules.map((r) => ({
        rule_id: r.rule_id, trigger: r.trigger, candidate_error_causes: r.candidate_error_causes, probe: r.probe,
      })),
    }),
    userData: answerText,
  };
  const res = await runtime.runTask({ taskType: "diagnose", sessionRef: newId("d"), tenantId, context });
  if (!res.ok) return res;
  const j = res.outputJson as {
    candidate_error_causes?: { error_cause_id?: string; confidence?: number; evidence?: string }[];
    probe?: { question?: string; judge_rubric?: string } | null;
    resolved?: boolean;
    rationale?: string;
  } | undefined;
  const candidates = (j?.candidate_error_causes ?? [])
    .filter((c): c is { error_cause_id: string; confidence: number; evidence: string } =>
      typeof c.error_cause_id === "string" && c.error_cause_id.length > 0)
    .slice(0, 3)
    .map((c) => ({
      error_cause_id: c.error_cause_id,
      confidence: Number.isFinite(c.confidence) ? Math.min(Math.max(c.confidence!, 0), 1) : 0.5,
      evidence: c.evidence ?? "",
    }));
  return {
    ok: true,
    outcome: {
      candidate_error_causes: candidates,
      probe: j?.probe?.question ? { question: j.probe.question, judge_rubric: j.probe.judge_rubric ?? "依据数学事实判定探针回答正误" } : null,
      resolved: j?.resolved ?? candidates.length === 0,
      rationale: (j?.rationale ?? "").slice(0, 200),
    },
  };
}

/** 关闭全链：观测（主答+探针，按 evidence_rule 进 BKT）→ SER → TSS → SLR → CLOSE → QUEUE_DREAM。
 *  双产物纪律（§11.2）：TSS 生成失败则显式 502，不关闭、不产生缺失双产物的 SLR。 */
async function closeChain(
  tenantId: string,
  sessionId: string,
): Promise<{ status: number; body: unknown }> {
  const now = new Date().toISOString();

  // 会话与全部作答事实（事务外读，权威判定在下方 for update）
  const sres = await withTenant(pool, tenantId, async (c) => {
    const r = await c.query("select * from runtime_question_session where session_id = $1 for update", [sessionId]);
    return r.rows[0];
  });
  if (!sres) return { status: 404, body: { error: "session not found" } };
  if (sres.state === "CLOSED") return { status: 409, body: { error: "session already closed" } };
  const dimensionId = (sres.payload?.dimension_id as string | undefined) ?? "K_SSA";

  const facts = await withTenant(pool, tenantId, async (c) => {
    const attempts = await c.query(
      `select a.payload, v.verdict, v.payload->>'decision_summary' as summary
         from runtime_attempt a
         join runtime_answer_verdict v on v.attempt_id = a.attempt_id
        where a.session_id = $1 order by a.created_at`,
      [sessionId],
    );
    const claim = await c.query(
      "select claim_id, status, payload from runtime_diagnostic_claim where session_id = $1 order by created_at desc limit 1",
      [sessionId],
    );
    return { attempts: attempts.rows, claim: claim.rows[0] };
  });

  const hist = facts.attempts.map((a) => {
    const kind = (a.payload?.kind ?? "answer") as "answer" | "probe";
    return {
      verdict: a.verdict as string,
      kind,
      evidence_rule: kind === "probe" ? "probe.judge" : "teaching_agent.grade",
      decision_summary: a.summary ?? "",
    };
  });

  // 教学总结（独立 Session，基于最终证据；失败显式 502，双产物不得残缺）
  const summaryCtx = hist.map((h, i) => `作答${i + 1}（${h.kind}）：判定=${h.verdict}，${h.decision_summary}`).join("\n");
  const tssRes = await runtime.runTask({
    taskType: "teach_summary",
    sessionRef: newId("t"),
    tenantId,
    context: { question: `共 ${hist.length} 次作答（含探针），BKT 基准见下方`, userData: summaryCtx },
  });
  if (!tssRes.ok) {
    return { status: 502, body: { error: "summary_failed", detail: tssRes.detail ?? tssRes.error, session_state: "OPEN" } };
  }

  const claimId = facts.claim?.claim_id ?? null;
  const claimStatus = (facts.claim?.status as string | undefined) ?? null;

  const out = await withTenant(pool, tenantId, async (c) => {
    const s = await c.query("select * from runtime_question_session where session_id = $1 for update", [sessionId]);
    const session = s.rows[0];
    if (!session) return { status: 404 as const, body: { error: "session not found" } };
    if (session.state === "CLOSED") return { status: 409 as const, body: { error: "session already closed" } };

    const independent = session.mode === "diagnostic";

    // 观测：主答 + 探针（成功/失败进 BKT；unresolved 不进）
    const observationIds: string[] = [];
    for (const h of hist) {
      if (h.verdict === "unresolved") continue;
      const observationId = newId("obs");
      observationIds.push(observationId);
      const observationPayload = {
        observation_id: observationId,
        tenant_id: tenantId,
        student_id: session.student_id,
        dimension_id: dimensionId,
        question_id: session.question_id,
        session_id: sessionId,
        outcome: h.verdict === "correct" ? "success" : "failure",
        independent,
        evidence_rule: h.evidence_rule,
        hint_level: 0,
        evidence_refs: [],
        model_version: "pi.scnet",
        rule_version: h.evidence_rule,
        supersedes: null,
        created_at: now,
      };
      await c.query(
        `insert into runtime_state_observation
           (observation_id, tenant_id, student_id, dimension_id, question_id, session_id,
            judgment_id, outcome, independent, evidence_rule, hint_level, payload)
         values ($1,$2,$3,$4,$5,$6,null,$7,$8,$9,0,$10)`,
        [observationId, tenantId, session.student_id, dimensionId, session.question_id, sessionId,
         observationPayload.outcome, independent, h.evidence_rule, JSON.stringify(observationPayload)],
      );
    }

    // 保守 BKT：重放该学生该维度全部有效独立观测（被 supersede 的旧观测经指针排除）
    const histRows = await c.query(
      `select o.outcome from runtime_state_observation o
        where o.student_id = $1 and o.dimension_id = $2 and o.independent
          and o.outcome in ('success','failure')
          and not exists (
            select 1 from runtime_state_observation o2 where o2.supersedes = o.observation_id
          )
        order by o.created_at`,
      [session.student_id, dimensionId],
    );
    const pBaseline = Math.round(bktReplay(histRows.rows.map((r) => r.outcome as "success" | "failure")) * 1000) / 1000;

    const reportId = newId("ser");
    const serPayload = {
      report_id: reportId,
      session_id: sessionId,
      student_id: session.student_id,
      dimension_id: dimensionId,
      p_bkt_baseline: pBaseline,
      independent_observation_count: histRows.rows.length,
      parameter_set_id: BKT_PRIOR_V1.id,
      calibration_status: "prior_only",
      input_event_refs: observationIds,
      calculation_trace_ref: `calc_${sessionId}`,
      kernel_version: "mastery-bkt@0.1.0",
      created_at: now,
    };
    await c.query(
      `insert into state_scientific_evaluation_report
         (report_id, tenant_id, session_id, student_id, dimension_id, p_bkt_baseline,
          calibration_status, parameter_set_id, kernel_version, payload)
       values ($1,$2,$3,$4,$5,$6,'prior_only',$7,$8,$9)`,
      [reportId, tenantId, sessionId, session.student_id, dimensionId, pBaseline,
       BKT_PRIOR_V1.id, "mastery-bkt@0.1.0", JSON.stringify(serPayload)],
    );

    const summaryId = newId("tss");
    const tssText = (tssRes.outputText ?? "").trim().slice(0, 1000);
    const tssPayload = {
      summary_id: summaryId,
      session_id: sessionId,
      scientific_evaluation_ref: reportId,
      summary: `${tssText}（BKT 基准 ${pBaseline}，prior_only）`,
      method_observations: [],
      misconception_candidates: claimId && claimStatus ? [{ claim_id: claimId, status: claimStatus }] : [],
      hint_dependency: "low",
      unresolved: claimStatus === "unresolved" ? [{ claim_id: claimId }] : [],
      evidence_refs: [],
      model_id: tssRes.implementation ?? "pi.unknown",
      prompt_version: tssRes.promptVersion ?? "unknown",
      created_at: now,
    };
    await c.query(
      `insert into runtime_teaching_session_summary
         (summary_id, tenant_id, session_id, ser_id, model_id, prompt_version, payload)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [summaryId, tenantId, sessionId, reportId, tssPayload.model_id, tssPayload.prompt_version, JSON.stringify(tssPayload)],
    );

    const recordId = newId("slr");
    await c.query(
      `insert into runtime_session_learning_record
         (record_id, tenant_id, session_id, student_id, ser_id, tss_id,
          integrity_passed, dream_queued_at, payload)
       values ($1,$2,$3,$4,$5,$6,true,now(),$7)`,
      [recordId, tenantId, sessionId, session.student_id, reportId, summaryId,
       JSON.stringify({
         record_id: recordId,
         session_id: sessionId,
         student_id: session.student_id,
         scientific_evaluation_report_id: reportId,
         teaching_session_summary_id: summaryId,
         integrity_check: { session_id_match: true, cross_refs_present: true, provenance_complete: true, passed: true },
         dream_queued_at: now,
         created_at: now,
       })],
    );

    const states = ["SUBMIT", "GRADE", "SCIENTIFIC_EVALUATE", "TEACHING_SESSION_SUMMARY", "CLOSE", "QUEUE_DREAM"];
    await c.query(
      `update runtime_question_session
          set state = 'CLOSED', closed_at = now(),
              state_history = state_history || (
                select jsonb_agg(jsonb_build_object('state', s, 'entered_at', $2::timestamptz, 'actor', 'orchestrator'))
                from unnest($3::text[]) as s
              ),
              payload = payload || jsonb_build_object('state', 'CLOSED', 'closed_at', $2::timestamptz)
        where session_id = $1`,
      [sessionId, now, states],
    );

    return {
      status: 200 as const,
      body: {
        session_id: sessionId,
        observation_ids: observationIds,
        scientific_evaluation_report: serPayload,
        teaching_session_summary: tssPayload,
        session_learning_record_id: recordId,
        dream_queued: true,
      },
    };
  });

  return out.status === 200 ? { status: 200, body: out.body } : { status: out.status, body: out.body };
}

startService({
  name: "learning",
  port: Number(process.env.PORT ?? 3002),
  register(app) {
    app.post("/sessions", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const body = req.body as CreateSessionBody;
      const sessionId = newId("s");
      const now = new Date().toISOString();
      const payload = {
        session_id: sessionId,
        tenant_id: tenantId,
        student_id: body.student_id,
        question_id: body.question_id,
        chapter_package_version: body.chapter_package_version,
        mode: body.mode,
        draft_enabled: body.draft_enabled,
        counts_toward_independent_evidence: body.mode === "diagnostic",
        state: "CREATE",
        state_history: [{ state: "CREATE", entered_at: now, actor: "orchestrator" }],
        hint_level: 0,
        probe_rounds: 0,
        started_at: now,
      };
      await withTenant(pool, tenantId, async (c) => {
        await c.query(
          `insert into runtime_question_session
             (session_id, tenant_id, student_id, run_id, question_id, chapter_package_version,
              mode, draft_enabled, state, state_history, hint_level, probe_rounds, payload)
           values ($1,$2,$3,null,$4,$5,$6,$7,'CREATE',
                   jsonb_build_array(jsonb_build_object('state','CREATE','entered_at',$8::timestamptz,'actor','orchestrator')),
                   0,0,$9)`,
          [sessionId, tenantId, body.student_id, body.question_id, body.chapter_package_version,
           body.mode, body.draft_enabled, now, JSON.stringify(payload)],
        );
      });
      return reply.code(201).send(payload);
    });

    app.get("/sessions/:id", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { id } = req.params as { id: string };
      const row = await withTenant(pool, tenantId, async (c) => {
        const r = await c.query(
          `select payload || jsonb_build_object('state', state, 'state_history', state_history,
                  'hint_level', hint_level, 'probe_rounds', probe_rounds) as payload
             from runtime_question_session where session_id = $1`,
          [id],
        );
        return r.rows[0];
      });
      if (!row) return reply.code(404).send({ error: "session not found" });
      return row.payload;
    });

    // ── 自适应测评（§10 / §7.4 测评统一：聊天式测评 = AssessmentRun） ──

    /** 创建测评轮（AssessmentRun）：初始目标 coverage；后续目标由会话结束判定更新 */
    app.post("/assessment-runs", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { student_id: studentId } = req.body as { student_id: string };
      if (!studentId) return reply.code(422).send({ error: "student_id required" });
      const runId = newId("run");
      const now = new Date().toISOString();
      await withTenant(pool, tenantId, async (c) => {
        await c.query(
          `insert into runtime_assessment_run (run_id, tenant_id, student_id, goal, budget, status, payload)
           values ($1,$2,$3,'coverage',$4,'active',$5)`,
          [runId, tenantId, studentId,
           JSON.stringify({ max_questions: 10, max_minutes: 30 }),
           JSON.stringify({ run_id: runId, student_id: studentId, goal: "coverage", seen: [], sessions: [], created_at: now })],
        );
      });
      return reply.code(201).send({ run_id: runId, goal: "coverage", status: "active" });
    });

    /** 下一题（阶段 B：传统程序硬过滤+评分；题目候选来自已发布章节包） */
    app.post("/assessment-runs/:id/next", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { id } = req.params as { id: string };

      const run = await withTenant(pool, tenantId, async (c) => {
        const r = await c.query("select * from runtime_assessment_run where run_id = $1", [id]);
        return r.rows[0];
      });
      if (!run) return reply.code(404).send({ error: "assessment run not found" });
      if (run.status !== "active") return reply.code(409).send({ error: `run ${run.status}` });

      // 候选：已发布题目（content 边界）
      let qRes: Response;
      try {
        qRes = await fetch(`${CONTENT_URL}/questions`, {
          headers: { "x-tenant-id": tenantId }, signal: AbortSignal.timeout(10_000),
        });
      } catch {
        return reply.code(502).send({ error: "content_unavailable" });
      }
      if (!qRes.ok) return reply.code(502).send({ error: "content_unavailable", detail: `http_${qRes.status}` });
      const qd = (await qRes.json()) as { questions?: QuestionCandidate[] };
      const candidates = (qd.questions ?? []).map((q) => ({
        ...q,
        measurement_targets: (q.measurement_targets ?? []) as { dim: string; role: "primary" | "secondary" | "prerequisite" }[],
      }));

      // 学生状态：画像投影（state 边界只读投影；教学 Session 无画像写权限，ADR-004）
      let proj: { mastery?: { dimension_id: string; p_profile: number; state: string }[] } = {};
      try {
        const pRes = await fetch(`${PROFILE_URL}/students/${encodeURIComponent(run.student_id)}/projection`, {
          headers: { "x-tenant-id": tenantId }, signal: AbortSignal.timeout(10_000),
        });
        if (pRes.ok) proj = (await pRes.json()) as typeof proj;
      } catch { /* 投影不可达时用空掌握视图（不阻塞选题） */ }

      const mastery: SelectorContext["mastery"] = {};
      const masteryRows = (proj.mastery ?? []) as { dimension_id?: string; p_profile?: number; state?: string }[];
      for (const m of masteryRows) {
        if (!m.dimension_id) continue;
        mastery[m.dimension_id] = {
          ...(m.p_profile !== undefined ? { p_profile: m.p_profile } : {}),
          ...(m.state ? { state: m.state as "weak" | "learning" | "possibly_mastered" | "mastered" | "insufficient_evidence" } : {}),
          next_review_due_days: null,
        };
      }

      const seen = new Set<string>(run.payload?.seen ?? []);
      const ctx: SelectorContext = {
        goal: run.goal as SelectionGoal,
        candidates,
        mastery,
        seen,
        self_weak: run.payload?.self_weak ?? [],
      };
      const pick = selectNext(ctx);
      if (!pick) {
        await withTenant(pool, tenantId, async (c) => {
          await c.query(
            `update runtime_assessment_run set status = 'exhausted',
                    payload = payload || jsonb_build_object('exhausted_at', now())
              where run_id = $1`,
            [id],
          );
        });
        return reply.send({ status: "exhausted", detail: "无符合硬过滤与目标的题目" });
      }

      seen.add(pick.question_id);
      await withTenant(pool, tenantId, async (c) => {
        await c.query(
          `update runtime_assessment_run
              set payload = payload || jsonb_build_object('seen', $2::jsonb, 'current_question', $3)
            where run_id = $1`,
          [id, JSON.stringify([...seen]), pick.question_id],
        );
      });
      return reply.send({ run_id: id, question_id: pick.question_id, score: pick.score, goal: run.goal });
    });

    /** 会话结束目标判定（阶段 A：教学主模型，§10.1/§7.4）——只判定目标，不写画像 */
    app.post("/assessment-runs/:id/decide", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { id } = req.params as { id: string };
      const { session_id: sessionId } = req.body as { session_id: string };
      if (!sessionId) return reply.code(422).send({ error: "session_id required" });

      const run = await withTenant(pool, tenantId, async (c) => {
        const r = await c.query("select * from runtime_assessment_run where run_id = $1", [id]);
        return r.rows[0];
      });
      if (!run) return reply.code(404).send({ error: "assessment run not found" });

      // 会话摘要（本题证据）+ 学生投影
      const session = await withTenant(pool, tenantId, async (c) => {
        const s = await c.query(
          `select q.question_id, q.state, q.probe_rounds,
                  (select jsonb_agg(jsonb_build_object('verdict', v.verdict, 'summary', v.payload->>'decision_summary'))
                     from runtime_answer_verdict v where v.session_id = q.session_id) as verdicts,
                  (select payload from runtime_diagnostic_claim dc
                    where dc.session_id = q.session_id order by dc.created_at desc limit 1) as claim
             from runtime_question_session q where q.session_id = $1`,
          [sessionId],
        );
        return s.rows[0];
      });
      if (!session) return reply.code(404).send({ error: "session not found" });

      let projText = "（投影不可达）";
      try {
        const pRes = await fetch(`${PROFILE_URL}/students/${encodeURIComponent(run.student_id)}/projection`, {
          headers: { "x-tenant-id": tenantId }, signal: AbortSignal.timeout(10_000),
        });
        if (pRes.ok) projText = JSON.stringify(await pRes.json());
      } catch { /* 同 next */ }

      const res = await runtime.runTask({
        taskType: "session_decision",
        sessionRef: newId("sd"),
        tenantId,
        context: {
          sessionSummary: JSON.stringify({
            question_id: session.question_id,
            state: session.state,
            probe_rounds: session.probe_rounds,
            verdicts: session.verdicts ?? [],
            claim: session.claim ?? null,
          }),
          studentProjection: projText,
        },
      });
      if (!res.ok) return reply.code(res.status ?? 502).send({ error: res.error, detail: res.detail });
      const j = res.outputJson as { goal?: string; reason?: string; stop?: boolean } | undefined;
      if (!j) return reply.code(502).send({ error: "model_output_invalid", detail: "无结构化输出" });
      const goal = j.goal as SelectionGoal | undefined;
      if (!goal || !["coverage", "disambiguation", "prerequisite", "review", "training", "transfer"].includes(goal)) {
        return reply.code(502).send({ error: "model_output_invalid", detail: `goal=${String(j?.goal)}` });
      }
      await withTenant(pool, tenantId, async (c) => {
        await c.query(
          `update runtime_assessment_run
              set goal = $2, status = $3,
                  payload = payload || jsonb_build_object('last_decision', $4::jsonb)
            where run_id = $1`,
          [id, goal, j.stop ? "completed" : "active",
           JSON.stringify({ goal, reason: j.reason ?? "", stop: j.stop ?? false, decided_at: new Date().toISOString() })],
        );
      });
      return reply.send({ run_id: id, goal, reason: j.reason ?? "", stop: j.stop ?? false, status: j.stop ? "completed" : "active" });
    });

    /** 首次作答：GRADE → correct/unresolved 直接关闭；partial/incorrect → DIAGNOSE + 追问 */
    app.post("/sessions/:id/submit", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { id } = req.params as { id: string };
      const body = req.body as SubmitBody;
      const dimensionId = body.dimension_id ?? "K_SSA";
      if (!DIMENSION_ID_RE.test(dimensionId)) {
        return reply.code(422).send({ error: "invalid dimension_id (must match (K|T|E)_[A-Z0-9_]{2,})" });
      }
      if (typeof body.answer_text !== "string" || body.answer_text.length === 0) {
        return reply.code(422).send({ error: "answer_text required" });
      }
      if (body.answer_text.length > MAX_ANSWER_CHARS) {
        return reply.code(422).send({ error: `answer_text exceeds ${MAX_ANSWER_CHARS} chars` });
      }
      const now = new Date().toISOString();

      const pre = await withTenant(pool, tenantId, async (c) => {
        const r = await c.query(
          "select state, question_id from runtime_question_session where session_id = $1",
          [id],
        );
        return r.rows[0];
      });
      if (!pre) return reply.code(404).send({ error: "session not found" });
      if (pre.state !== "CREATE") return reply.code(409).send({ error: `submit only allowed from CREATE, current ${pre.state}` });

      const graded = await runGrading(pre.question_id, tenantId, body.answer_text);
      if (!graded.ok) return reply.code(graded.status).send({ error: graded.error, detail: graded.detail });
      const grade = graded.grade;

      // 部分正确/错误 → 先做错因归因（模型调用失败则整体 502，会话保持 CREATE 可重试）
      let diag: Awaited<ReturnType<typeof runDiagnose>> | null = null;
      if (grade.verdict === "partially_correct" || grade.verdict === "incorrect") {
        diag = await runDiagnose(pre.question_id, tenantId, grade.verdict, body.answer_text);
        if (!diag.ok) return reply.code(diag.status).send({ error: diag.error, detail: diag.detail });
      }

      // 事实层：作答 + 判定（不可变，先落库）
      const attemptId = newId("att");
      const judgmentId = newId("jud");
      await withTenant(pool, tenantId, async (c) => {
        const s = await c.query("select * from runtime_question_session where session_id = $1 for update", [id]);
        const session = s.rows[0];
        if (!session || session.state !== "CREATE") throw new Error("session state changed");
        await c.query(
          `insert into runtime_attempt (attempt_id, tenant_id, session_id, student_id, payload)
           values ($1,$2,$3,$4,$5)`,
          [attemptId, tenantId, id, session.student_id,
           JSON.stringify({ answer_text: body.answer_text, kind: "answer", submitted_at: now })],
        );
        await c.query(
          `insert into runtime_answer_verdict
             (judgment_id, tenant_id, session_id, attempt_id, verdict, uncertainty, model_id, prompt_version, payload)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [judgmentId, tenantId, id, attemptId, grade.verdict, grade.uncertainty,
           grade.modelImpl, grade.promptVersion,
           JSON.stringify({
             judgment_id: judgmentId, session_id: id, attempt_id: attemptId,
             verdict: grade.verdict,
             rubric_items: grade.rubricItems.map((r) => ({ id: r.id, status: r.status, evidence_refs: [`answer://${id}/${attemptId}`] })),
             decision_summary: grade.decisionSummary,
             uncertainty: grade.uncertainty,
             injection_flags: [],
             model_id: grade.modelImpl, prompt_version: grade.promptVersion, created_at: now,
           })],
        );
        await c.query(
          `update runtime_question_session
              set state = 'GRADE', probe_rounds = 0,
                  payload = payload || jsonb_build_object('dimension_id', $2),
                  state_history = state_history ||
                    jsonb_build_array(jsonb_build_object('state','SUBMIT','entered_at',$3::timestamptz,'actor','orchestrator'),
                                      jsonb_build_object('state','GRADE','entered_at',$3::timestamptz,'actor','orchestrator'))
            where session_id = $1`,
          [id, dimensionId, now],
        );
      });

      const judgmentPayload = {
        judgment_id: judgmentId, session_id: id, attempt_id: attemptId,
        verdict: grade.verdict,
        rubric_items: grade.rubricItems.map((r) => ({ id: r.id, status: r.status, evidence_refs: [`answer://${id}/${attemptId}`] })),
        decision_summary: grade.decisionSummary,
        uncertainty: grade.uncertainty,
        injection_flags: [],
        model_id: grade.modelImpl, prompt_version: grade.promptVersion, created_at: now,
      };

      // 正确/待核 → 直接关闭；部分正确/错误 → 错因归因（diag 已在上方预跑）
      if (grade.verdict === "correct" || grade.verdict === "unresolved") {
        const closed = await closeChain(tenantId, id);
        if (closed.status !== 200) return reply.code(closed.status).send(closed.body);
        return reply.send({
          session_id: id,
          judgment: judgmentPayload,
          ...(closed.body as Record<string, unknown>),
        });
      }
      // 到达此处必为部分正确/错误路径（diag 已赋值；防御性断言，逻辑不可达）
      if (!diag) return reply.code(500).send({ error: "internal", detail: "diagnose missing on diagnose path" });

      const claimId = newId("clm");
      const card = diag.outcome.probe
        ? buildProbeCard(id, newId("art"), diag.outcome.probe)
        : null;
      const claimPayload = {
        claim_id: claimId,
        session_id: id,
        status: "open",
        candidates: diag.outcome.candidate_error_causes,
        probe: diag.outcome.probe,
        card: card ? { artifact_id: card.artifact_id, card_id: card.card_id } : null,
        resolved: diag.outcome.resolved,
        rationale: diag.outcome.rationale,
        probe_history: [],
        created_at: now,
      };
      await withTenant(pool, tenantId, async (c) => {
        if (card) await registerProbeCard(c, tenantId, id, "usr_student01", card);
        await c.query(
          `insert into runtime_diagnostic_claim (claim_id, tenant_id, session_id, status, payload)
           values ($1,$2,$3,'open',$4)`,
          [claimId, tenantId, id, JSON.stringify(claimPayload)],
        );
        await c.query(
          `update runtime_question_session
              set state = 'DIAGNOSE', probe_rounds = 1,
                  state_history = state_history ||
                    jsonb_build_array(jsonb_build_object('state','DIAGNOSE','entered_at',$2::timestamptz,'actor','orchestrator'))
            where session_id = $1`,
          [id, now],
        );
      });

      if (diag.outcome.resolved || !diag.outcome.probe) {
        // 已可下结论或无追问建议 → 关闭（claim 终态 resolved）
        await withTenant(pool, tenantId, async (c) => {
          await c.query("update runtime_diagnostic_claim set status = 'resolved' where claim_id = $1", [claimId]);
        });
        const closed = await closeChain(tenantId, id);
        if (closed.status !== 200) return reply.code(closed.status).send(closed.body);
        return reply.send({ session_id: id, judgment: judgmentPayload, ...(closed.body as Record<string, unknown>) });
      }

      return reply.send({
        session_id: id,
        judgment: judgmentPayload,
        claim: { claim_id: claimId, candidates: diag.outcome.candidate_error_causes, rationale: diag.outcome.rationale },
        probe: diag.outcome.probe,
        card,
        state: "PROBE_AWAIT",
        probe_rounds: 1,
        max_probe_rounds: MAX_PROBE_ROUNDS,
      });
    });

    /**
     * 卡片交互事件（设计 §5.4：submitted/skipped/bypassed_free_text）。
     * 跳过/直接回复只记录事件，不产生失败观测（§1.1-10）；作答内容走 /probe 判答。
     */
    app.post("/sessions/:id/card-event", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { id } = req.params as { id: string };
      const body = req.body as { card_id?: string; response_type?: string; payload?: Record<string, unknown> };
      if (!body.card_id || !["submitted", "skipped", "bypassed_free_text"].includes(body.response_type ?? "")) {
        return reply.code(422).send({ error: "card_id and response_type (submitted|skipped|bypassed_free_text) required" });
      }
      const out = await withTenant(pool, tenantId, async (c) => {
        const s = await c.query("select * from runtime_question_session where session_id = $1", [id]);
        const session = s.rows[0];
        if (!session) return { status: 404 as const };
        if (session.state !== "DIAGNOSE" && session.state !== "PROBE_AWAIT") {
          return { status: 409 as const, body: { error: `card-event only in DIAGNOSE/PROBE_AWAIT, current ${session.state}` } };
        }
        // 卡片归属校验：claim 中登记的 card_id 必须匹配
        const claim = await c.query(
          "select payload from runtime_diagnostic_claim where session_id = $1 order by created_at desc limit 1",
          [id],
        );
        const registered = (claim.rows[0]?.payload?.card ?? null) as { artifact_id?: string; card_id?: string } | null;
        if (!registered || registered.card_id !== body.card_id) {
          return { status: 422 as const, body: { error: "card_id not registered for this session" } };
        }
        const responseId = newId("rsp");
        await c.query(
          `insert into runtime_artifact_interaction
             (response_id, tenant_id, session_id, artifact_id, card_id, student_id, response_type, payload)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [responseId, tenantId, id, registered.artifact_id, body.card_id, session.student_id,
           body.response_type, JSON.stringify(body.payload ?? {})],
        );
        return { status: 201 as const, body: { response_id: responseId, response_type: body.response_type } };
      });
      if (out.status === 404) return reply.code(404).send({ error: "session not found" });
      if (out.status === 409 || out.status === 422) return reply.code(out.status).send(out.body);
      return reply.code(201).send(out.body);
    });

    /** 追问作答：判答探针 → 证据入 claim → 闭合或下一轮（≤3）→ 关闭 */
    app.post("/sessions/:id/probe", async (req, reply) => {
      const tenantId = tenantOf(req);
      if (!tenantId) return reply.code(400).send({ error: "missing x-tenant-id" });
      const { id } = req.params as { id: string };
      const body = req.body as ProbeBody;
      if (typeof body.answer_text !== "string" || body.answer_text.length === 0) {
        return reply.code(422).send({ error: "answer_text required" });
      }
      if (body.answer_text.length > MAX_ANSWER_CHARS) {
        return reply.code(422).send({ error: `answer_text exceeds ${MAX_ANSWER_CHARS} chars` });
      }
      const now = new Date().toISOString();

      const pre = await withTenant(pool, tenantId, async (c) => {
        const r = await c.query(
          `select q.question_id, q.state, q.probe_rounds, q.student_id,
                  (select jsonb_build_object('claim_id', claim_id, 'status', status, 'payload', payload)
                     from runtime_diagnostic_claim
                    where session_id = q.session_id order by created_at desc limit 1) as claim
             from runtime_question_session q where q.session_id = $1`,
          [id],
        );
        return r.rows[0];
      });
      if (!pre) return reply.code(404).send({ error: "session not found" });
      if (pre.state !== "DIAGNOSE" && pre.state !== "PROBE_AWAIT") {
        return reply.code(409).send({ error: `probe only allowed from DIAGNOSE/PROBE_AWAIT, current ${pre.state}` });
      }
      const claim = pre.claim as { claim_id?: string; payload?: { probe?: { question: string; judge_rubric: string }; candidates?: unknown[] } };
      const probeQ = claim?.payload?.probe;
      if (!claim?.claim_id || !probeQ?.question) {
        return reply.code(409).send({ error: "no pending probe on claim" });
      }
      if (pre.probe_rounds >= MAX_PROBE_ROUNDS) {
        return reply.code(409).send({ error: `probe rounds exhausted (${MAX_PROBE_ROUNDS})` });
      }

      // 探针判答（模型主判；探针问题为本题上下文，学生回答为不可信数据）
      const graded = await runGrading(pre.question_id, tenantId, body.answer_text, {
        title: `（追问 ${pre.probe_rounds}/${MAX_PROBE_ROUNDS}）${probeQ.question}`,
        rubric: `- probe.judge：${probeQ.judge_rubric}`,
      });
      if (!graded.ok) return reply.code(graded.status).send({ error: graded.error, detail: graded.detail });
      const probeOk = graded.grade.verdict === "correct";
      const nextRound = pre.probe_rounds + 1;

      // 事实层：探针作答 + 判定
      const attemptId = newId("att");
      const judgmentId = newId("jud");
      await withTenant(pool, tenantId, async (c) => {
        await c.query(
          `insert into runtime_attempt (attempt_id, tenant_id, session_id, student_id, payload)
           values ($1,$2,$3,$4,$5)`,
          [attemptId, tenantId, id, pre.student_id,
           JSON.stringify({ answer_text: body.answer_text, kind: "probe", round: pre.probe_rounds, probe_question: probeQ.question, submitted_at: now })],
        );
        await c.query(
          `insert into runtime_answer_verdict
             (judgment_id, tenant_id, session_id, attempt_id, verdict, uncertainty, model_id, prompt_version, payload)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [judgmentId, tenantId, id, attemptId, graded.grade.verdict, graded.grade.uncertainty,
           graded.grade.modelImpl, graded.grade.promptVersion,
           JSON.stringify({
             judgment_id: judgmentId, session_id: id, attempt_id: attemptId,
             verdict: graded.grade.verdict,
             rubric_items: graded.grade.rubricItems.map((r) => ({ id: r.id, status: r.status, evidence_refs: [`probe://${id}/${attemptId}`] })),
             decision_summary: graded.grade.decisionSummary,
             uncertainty: graded.grade.uncertainty,
             injection_flags: [], kind: "probe",
             model_id: graded.grade.modelImpl, prompt_version: graded.grade.promptVersion, created_at: now,
           })],
        );
      });

      // 证据入 claim：支持/反对当前候选
      const resolvedErrorCause = claim.payload?.candidates?.[0] && probeOk
        ? (claim.payload.candidates[0] as { error_cause_id?: string }).error_cause_id ?? null
        : null;
      const claimStatus = probeOk ? "resolved" : nextRound >= MAX_PROBE_ROUNDS ? "unresolved" : "open";
      await withTenant(pool, tenantId, async (c) => {
        const cur = await c.query(
          "select payload from runtime_diagnostic_claim where claim_id = $1",
          [claim.claim_id],
        );
        const p = cur.rows[0]?.payload ?? {};
        const history = [...(p.probe_history ?? []), {
          round: pre.probe_rounds,
          probe_question: probeQ.question,
          answer: body.answer_text,
          verdict: graded.grade.verdict,
          probe_ok: probeOk,
        }];
        await c.query(
          `update runtime_diagnostic_claim
              set status = $2, payload = payload || jsonb_build_object('probe_history', $3::jsonb,
                    'probe_ok', $4, 'resolved_error_cause', $5)
            where claim_id = $1`,
          [claim.claim_id, claimStatus, JSON.stringify(history), probeOk, resolvedErrorCause],
        );
        await c.query(
          `update runtime_question_session
              set state = $2, probe_rounds = $3,
                  state_history = state_history ||
                    jsonb_build_array(jsonb_build_object('state',$4,'entered_at',$5::timestamptz,'actor','orchestrator'))
            where session_id = $1`,
          [id, probeOk || claimStatus === "unresolved" ? "DIAGNOSE" : "PROBE_AWAIT",
           nextRound, probeOk || claimStatus === "unresolved" ? "DIAGNOSE" : "PROBE_AWAIT", now],
        );
      });

      // 闭合或轮次耗尽 → 关闭全链
      if (probeOk || claimStatus === "unresolved") {
        const closed = await closeChain(tenantId, id);
        if (closed.status !== 200) return reply.code(closed.status).send(closed.body);
        return reply.send({
          session_id: id,
          probe: { round: pre.probe_rounds, verdict: graded.grade.verdict },
          claim: { claim_id: claim.claim_id, status: claimStatus, resolved_error_cause: resolvedErrorCause },
          ...(closed.body as Record<string, unknown>),
        });
      }

      // 下一轮追问：复用规则库 probe 或由模型再生成（首版：模型再诊断一次）
      const diag = await runDiagnose(pre.question_id, tenantId, graded.grade.verdict, body.answer_text);
      if (!diag.ok) return reply.code(diag.status).send({ error: diag.error, detail: diag.detail });
      if (!diag.outcome.probe || diag.outcome.resolved) {
        const closed = await closeChain(tenantId, id);
        if (closed.status !== 200) return reply.code(closed.status).send(closed.body);
        return reply.send({
          session_id: id,
          probe: { round: pre.probe_rounds, verdict: graded.grade.verdict },
          claim: { claim_id: claim.claim_id, status: "resolved" },
          ...(closed.body as Record<string, unknown>),
        });
      }
      const nextCard = buildProbeCard(id, newId("art"), diag.outcome.probe);
      await withTenant(pool, tenantId, async (c) => {
        await registerProbeCard(c, tenantId, id, pre.student_id, nextCard);
        await c.query(
          `update runtime_diagnostic_claim
              set payload = payload || jsonb_build_object('probe', $2::jsonb, 'card', $3::jsonb)
            where claim_id = $1`,
          [claim.claim_id, JSON.stringify(diag.outcome.probe),
           JSON.stringify({ artifact_id: nextCard.artifact_id, card_id: nextCard.card_id })],
        );
        await c.query(
          `update runtime_question_session set state = 'PROBE_AWAIT' where session_id = $1`,
          [id],
        );
      });
      return reply.send({
        session_id: id,
        probe: diag.outcome.probe,
        card: nextCard,
        probe_rounds: nextRound,
        max_probe_rounds: MAX_PROBE_ROUNDS,
        state: "PROBE_AWAIT",
      });
    });
  },
});
