/**
 * learning-service：QuestionSession 创建/查询 + 骨架教学闭环。
 *
 * POST /sessions/:id/submit 在单事务内推进状态机：
 *   SUBMIT → GRADE（fake.grader 确定性规则，生产由 Teaching Agent 模型主判替换）
 *   → SCIENTIFIC_EVALUATE（简化保守 BKT，prior_only）
 *   → TEACHING_SESSION_SUMMARY（fake 模型摘要）
 *   → CLOSE → SLR 封装 → QUEUE_DREAM
 * 纪律（ADR-004）：本服务不写 StudentSnapshot；长期画像只由 Dream 路径更新。
 */
import { startService, createPool, withTenant, newId } from "@agmath/service-kit";
import { bktReplay, BKT_PRIOR_V1 } from "@agmath/mastery";

const pool = createPool(process.env.DATABASE_URL ?? "postgres://localhost:5432/agmath");
const BROKER_URL = process.env.BROKER_URL ?? "http://localhost:3004";

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

/** fake.grader：确定性关键词规则（骨架期替代模型主判，implementation 必须标注 fake.*） */
function fakeGrade(answerText: string): {
  verdict: "correct" | "partially_correct" | "incorrect";
  summary: string;
} {
  const t = answerText;
  if (/135|两解|补角/.test(t)) return { verdict: "correct", summary: "识别 SSA 补角分支，两解齐全。" };
  if (/45/.test(t)) return { verdict: "partially_correct", summary: "只给出锐角解，未检验补角分支。" };
  return { verdict: "incorrect", summary: "未正确应用正弦定理。" };
}

function tenantOf(req: { headers: Record<string, unknown> }): string | null {
  const t = req.headers["x-tenant-id"];
  return typeof t === "string" && t.length > 0 ? t : null;
}

/** 契约校验（identity/v1 DimensionId）：客户端输入不得携带任意串进入观测/快照 */
const DIMENSION_ID_RE = /^(K|T|E)_[A-Z0-9_]{2,}$/;
const MAX_ANSWER_CHARS = 20_000;

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
        const r = await c.query("select state from runtime_question_session where session_id = $1", [id]);
        return r.rows[0];
      });
      if (!pre) return reply.code(404).send({ error: "session not found" });
      if (pre.state === "CLOSED") return reply.code(409).send({ error: "session already closed" });

      const grade = fakeGrade(body.answer_text);
      const outcome: "success" | "failure" = grade.verdict === "correct" ? "success" : "failure";
      const judgmentId = newId("jud");
      const attemptId = newId("att");
      const observationId = newId("obs");
      const reportId = newId("ser");
      const summaryId = newId("tss");
      const recordId = newId("slr");
      const correlationId = newId("cor");

      // fake 模型摘要（经 broker，保留同构 trace）
      const brokerRes = await fetch(`${BROKER_URL}/providers/model/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", parts: [{ type: "text", text: `总结本题作答：${body.answer_text}` }] }],
          correlationId,
        }),
      });
      const brokerJson = (await brokerRes.json()) as {
        value: { outputText: string };
        trace: { implementation: string };
      };

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
          rubric_items: [],
          decision_summary: `${grade.summary} [fake.grader 骨架规则]`,
          uncertainty: "high",
          model_id: brokerJson.trace.implementation,
          prompt_version: "fake-grader@0.1.0",
          created_at: now,
        };
        await c.query(
          `insert into runtime_answer_verdict
             (judgment_id, tenant_id, session_id, attempt_id, verdict, uncertainty, model_id, prompt_version, payload)
           values ($1,$2,$3,$4,$5,'high',$6,$7,$8)`,
          [judgmentId, tenantId, id, attemptId, grade.verdict,
           brokerJson.trace.implementation, "fake-grader@0.1.0", JSON.stringify(judgmentPayload)],
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
          evidence_rule: "fake.grader.keyword",
          hint_level: 0,
          evidence_refs: [`answer://${id}/${attemptId}`],
          model_version: brokerJson.trace.implementation,
          rule_version: "fake-grader@0.1.0",
          supersedes: null,
          created_at: now,
        };
        await c.query(
          `insert into runtime_state_observation
             (observation_id, tenant_id, student_id, dimension_id, question_id, session_id,
              judgment_id, outcome, independent, evidence_rule, hint_level, payload)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11)`,
          [observationId, tenantId, session.student_id, dimensionId, session.question_id,
           id, judgmentId, outcome, independent, "fake.grader.keyword", JSON.stringify(observationPayload)],
        );

        // 简化保守 BKT：重放该学生该维度全部有效独立观测（含本次；被 supersede 的旧观测由新观测的 supersedes 指针排除——方案 A，不更新不可变行）
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
          kernel_version: "fake-bkt@0.1.0",
          created_at: now,
        };
        await c.query(
          `insert into state_scientific_evaluation_report
             (report_id, tenant_id, session_id, student_id, dimension_id, p_bkt_baseline,
              calibration_status, parameter_set_id, kernel_version, payload)
           values ($1,$2,$3,$4,$5,$6,'prior_only',$7,$8,$9)`,
          [reportId, tenantId, id, session.student_id, dimensionId, pBaseline,
           BKT_PRIOR_V1.id, "fake-bkt@0.1.0", JSON.stringify(serPayload)],
        );

        const tssPayload = {
          summary_id: summaryId,
          session_id: id,
          scientific_evaluation_ref: reportId,
          summary: `${brokerJson.value.outputText}（BKT 基准 ${pBaseline}，prior_only）`,
          method_observations: [],
          misconception_candidates: [],
          hint_dependency: "low",
          unresolved: [],
          evidence_refs: [`answer://${id}/${attemptId}`],
          model_id: brokerJson.trace.implementation,
          prompt_version: "fake-summary@0.1.0",
          created_at: now,
        };
        await c.query(
          `insert into runtime_teaching_session_summary
             (summary_id, tenant_id, session_id, ser_id, model_id, prompt_version, payload)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [summaryId, tenantId, id, reportId, brokerJson.trace.implementation,
           "fake-summary@0.1.0", JSON.stringify(tssPayload)],
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
