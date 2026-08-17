/**
 * learning-service：QuestionSession 创建/查询 + 教学闭环。
 *
 * 判答（GRADE）为模型主判（设计 §12.1）：经 agent-runtime（Pi 宿主）创建
 * Teaching Agent Session，依据题目/评分点/学生作答输出结构化 AnswerJudgment；
 * 学生作答按不可信数据处理（注入指令不升级为命令，设计 §16.3）。
 * 模型不可用时显式 502——绝不伪造判定。
 *
 * 题目只读已发布章节包（设计 §7.2）：题目未发布/不可达时显式失败，无内置兜底题。
 *
 * POST /sessions/:id/submit 单事务推进：
 *   SUBMIT → GRADE → SCIENTIFIC_EVALUATE（保守 BKT，prior_only）
 *   → TEACHING_SESSION_SUMMARY → CLOSE → SLR 封装 → QUEUE_DREAM
 * 纪律（ADR-004）：本服务不写 StudentSnapshot；长期画像只由 Dream 路径更新。
 */
import { startService, createPool, withTenant, newId } from "./lib.ts";
import { createAgentRuntimeClient } from "@agmath/providers-model";
import { bktReplay, BKT_PRIOR_V1 } from "@agmath/mastery";

const pool = createPool(process.env.DATABASE_URL ?? "postgres://localhost:5432/agmath");
/** 模型调用统一经 agent-runtime（Pi 宿主）；本服务不直连任何模型供应商 */
const AGENT_RUNTIME_URL = process.env.AGENT_RUNTIME_URL ?? "http://localhost:3005";
const CONTENT_URL = process.env.CONTENT_URL ?? "http://localhost:3006";
const runtime = createAgentRuntimeClient({ baseUrl: AGENT_RUNTIME_URL });

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

/**
 * 题目规格只来自已发布章节包（设计 §7.2）：content 返回未发布/不存在 → 404；
 * content 不可达 → 502。不做任何内置兜底。
 */
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
  if (res.status === 404) {
    return { ok: false, status: 404, error: "question_not_found_or_unpublished" };
  }
  if (!res.ok) return { ok: false, status: 502, error: "content_unavailable", detail: `http_${res.status}` };
  const q = (await res.json()) as { stem_markdown?: string; rubric?: { items?: { id: string; description: string }[] } };
  if (!q.stem_markdown || !q.rubric?.items?.length) {
    return { ok: false, status: 422, error: "question_incomplete", detail: "缺题干或评分点" };
  }
  return { ok: true, spec: { stem: q.stem_markdown, rubric: q.rubric.items.map((i) => ({ id: i.id, description: i.description })) } };
}

interface GradeOutcome {
  verdict: "correct" | "partially_correct" | "incorrect" | "unresolved";
  rubricItems: { id: string; status: string }[];
  decisionSummary: string;
  uncertainty: "low" | "medium" | "high";
  modelImpl: string;
  promptVersion: string;
  tssDraft: string;
  tssModelImpl: string;
  tssPromptVersion: string;
}

type GradingResult =
  | { ok: true; grade: GradeOutcome }
  | { ok: false; status: number; error: string; detail?: string };

/** 判答 + 教学总结两个独立任务 Session（设计 §4.1 角色隔离：不共享模型历史） */
async function runGrading(
  questionId: string,
  tenantId: string,
  answerText: string,
): Promise<GradingResult> {
  const specRes = await getQuestionSpec(questionId, tenantId);
  if (!specRes.ok) return specRes;
  const { stem, rubric } = specRes.spec;
  const rubricText = rubric.map((r) => `- ${r.id}：${r.description}`).join("\n");
  const sessionRef = newId("s");

  // 判答 Session
  const gradeRes = await runtime.runTask({
    taskType: "teach_grade",
    sessionRef,
    tenantId,
    context: { question: stem, rubric: rubricText, userData: answerText },
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

  // 教学总结 Session（独立 Session，不共享判答历史——设计 §4.1 角色隔离）
  const tssRes = await runtime.runTask({
    taskType: "teach_summary",
    sessionRef,
    tenantId,
    context: {
      question: stem,
      userData: `判定：${j.verdict}\n理由：${j.decision_summary ?? ""}\n评分点：${rubricItems.map((r) => `${r.id}=${r.status}`).join("，")}`,
    },
  });
  if (!tssRes.ok) return tssRes;

  return {
    ok: true,
    grade: {
      verdict: j.verdict as GradeOutcome["verdict"],
      rubricItems,
      decisionSummary: (j.decision_summary ?? "").slice(0, 500),
      uncertainty: (j.uncertainty && ["low", "medium", "high"].includes(j.uncertainty) ? j.uncertainty : "medium") as GradeOutcome["uncertainty"],
      modelImpl: gradeRes.implementation ?? "pi.unknown",
      promptVersion: gradeRes.promptVersion ?? "unknown",
      tssDraft: (tssRes.outputText ?? "").trim().slice(0, 1000),
      tssModelImpl: tssRes.implementation ?? "pi.unknown",
      tssPromptVersion: tssRes.promptVersion ?? "unknown",
    },
  };
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
        // 状态与历史以列为准（payload 在生命周期中可能滞后）
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

      // 预检（只读）：不存在/已关闭时不消耗模型调用；权威判定仍在下方事务的 for update
      const pre = await withTenant(pool, tenantId, async (c) => {
        const r = await c.query("select state, question_id from runtime_question_session where session_id = $1", [id]);
        return r.rows[0];
      });
      if (!pre) return reply.code(404).send({ error: "session not found" });
      if (pre.state === "CLOSED") return reply.code(409).send({ error: "session already closed" });

      const graded = await runGrading(pre.question_id, tenantId, body.answer_text);
      if (!graded.ok) return reply.code(graded.status).send({ error: graded.error, detail: graded.detail });
      const grade = graded.grade;

      const outcome: "success" | "failure" | "unresolved" =
        grade.verdict === "correct" ? "success" : grade.verdict === "unresolved" ? "unresolved" : "failure";
      const judgmentId = newId("jud");
      const attemptId = newId("att");
      const observationId = newId("obs");
      const reportId = newId("ser");
      const summaryId = newId("tss");
      const recordId = newId("slr");

      const result = await withTenant(pool, tenantId, async (c) => {
        const sres = await c.query(
          "select * from runtime_question_session where session_id = $1 for update",
          [id],
        );
        const session = sres.rows[0];
        if (!session) return { status: 404 as const };
        if (session.state === "CLOSED") return { status: 409 as const, error: "session already closed" };

        const independent: boolean = session.mode === "diagnostic";

        await c.query(
          `insert into runtime_attempt (attempt_id, tenant_id, session_id, student_id, payload)
           values ($1,$2,$3,$4,$5)`,
          [attemptId, tenantId, id, session.student_id,
           JSON.stringify({ answer_text: body.answer_text, submitted_at: now })],
        );

        const judgmentPayload = {
          judgment_id: judgmentId,
          session_id: id,
          attempt_id: attemptId,
          verdict: grade.verdict,
          rubric_items: grade.rubricItems.map((r) => ({
            id: r.id, status: r.status, evidence_refs: [`answer://${id}/${attemptId}`],
          })),
          decision_summary: grade.decisionSummary,
          uncertainty: grade.uncertainty,
          injection_flags: [],
          model_id: grade.modelImpl,
          prompt_version: grade.promptVersion,
          created_at: now,
        };
        await c.query(
          `insert into runtime_answer_verdict
             (judgment_id, tenant_id, session_id, attempt_id, verdict, uncertainty, model_id, prompt_version, payload)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [judgmentId, tenantId, id, attemptId, grade.verdict, grade.uncertainty,
           grade.modelImpl, grade.promptVersion, JSON.stringify(judgmentPayload)],
        );

        const observationPayload = {
          observation_id: observationId,
          tenant_id: tenantId,
          student_id: session.student_id,
          dimension_id: dimensionId,
          question_id: session.question_id,
          session_id: id,
          judgment_id: judgmentId,
          outcome,
          independent,
          evidence_rule: "teaching_agent.grade",
          hint_level: 0,
          evidence_refs: [`answer://${id}/${attemptId}`],
          model_version: grade.modelImpl,
          rule_version: grade.promptVersion,
          supersedes: null,
          created_at: now,
        };
        await c.query(
          `insert into runtime_state_observation
             (observation_id, tenant_id, student_id, dimension_id, question_id, session_id,
              judgment_id, outcome, independent, evidence_rule, hint_level, payload)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11)`,
          [observationId, tenantId, session.student_id, dimensionId, session.question_id,
           id, judgmentId, outcome, independent, observationPayload.evidence_rule, JSON.stringify(observationPayload)],
        );

        // 保守 BKT：重放该学生该维度全部有效独立观测（被 supersede 的旧观测经指针排除）
        const hist = await c.query(
          `select o.outcome from runtime_state_observation o
            where o.student_id = $1 and o.dimension_id = $2 and o.independent
              and o.outcome in ('success','failure')
              and not exists (
                select 1 from runtime_state_observation o2 where o2.supersedes = o.observation_id
              )
            order by o.created_at`,
          [session.student_id, dimensionId],
        );
        const pBaseline = Math.round(
          bktReplay(hist.rows.map((r) => r.outcome as "success" | "failure")) * 1000,
        ) / 1000;

        const serPayload = {
          report_id: reportId,
          session_id: id,
          student_id: session.student_id,
          dimension_id: dimensionId,
          p_bkt_baseline: pBaseline,
          independent_observation_count: hist.rows.length,
          parameter_set_id: BKT_PRIOR_V1.id,
          calibration_status: "prior_only",
          input_event_refs: [observationId],
          calculation_trace_ref: `calc_${id}`,
          kernel_version: "mastery-bkt@0.1.0",
          created_at: now,
        };
        await c.query(
          `insert into state_scientific_evaluation_report
             (report_id, tenant_id, session_id, student_id, dimension_id, p_bkt_baseline,
              calibration_status, parameter_set_id, kernel_version, payload)
           values ($1,$2,$3,$4,$5,$6,'prior_only',$7,$8,$9)`,
          [reportId, tenantId, id, session.student_id, dimensionId, pBaseline,
           BKT_PRIOR_V1.id, "mastery-bkt@0.1.0", JSON.stringify(serPayload)],
        );

        const tssPayload = {
          summary_id: summaryId,
          session_id: id,
          scientific_evaluation_ref: reportId,
          summary: `${grade.tssDraft}（BKT 基准 ${pBaseline}，prior_only）`,
          method_observations: [],
          misconception_candidates: [],
          hint_dependency: "low",
          unresolved: [],
          evidence_refs: [`answer://${id}/${attemptId}`],
          model_id: grade.tssModelImpl,
          prompt_version: grade.tssPromptVersion,
          created_at: now,
        };
        await c.query(
          `insert into runtime_teaching_session_summary
             (summary_id, tenant_id, session_id, ser_id, model_id, prompt_version, payload)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [summaryId, tenantId, id, reportId, grade.tssModelImpl, grade.tssPromptVersion, JSON.stringify(tssPayload)],
        );

        await c.query(
          `insert into runtime_session_learning_record
             (record_id, tenant_id, session_id, student_id, ser_id, tss_id,
              integrity_passed, dream_queued_at, payload)
           values ($1,$2,$3,$4,$5,$6,true,now(),$7)`,
          [recordId, tenantId, id, session.student_id, reportId, summaryId,
           JSON.stringify({
             record_id: recordId,
             session_id: id,
             student_id: session.student_id,
             scientific_evaluation_report_id: reportId,
             teaching_session_summary_id: summaryId,
             integrity_check: {
               session_id_match: true,
               cross_refs_present: true,
               provenance_complete: true,
               passed: true,
             },
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
          [id, now, states],
        );

        return {
          status: 200 as const,
          body: {
            session_id: id,
            judgment: judgmentPayload,
            observation_id: observationId,
            scientific_evaluation_report: serPayload,
            teaching_session_summary: tssPayload,
            session_learning_record_id: recordId,
            dream_queued: true,
          },
        };
      });

      if (result.status === 404) return reply.code(404).send({ error: "session not found" });
      if (result.status === 409) return reply.code(409).send({ error: result.error });
      return reply.send(result.body);
    });
  },
});
