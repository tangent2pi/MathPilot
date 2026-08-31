import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresSelectionStore } from "../src/selection-store.ts";

const databaseUrl = process.env.SELECTION_STORE_TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;

integration("Selector searches only safe normalized candidates and atomically opens one QuestionSession", async () => {
  const store = new PostgresSelectionStore(databaseUrl!);
  const pool = new pg.Pool({ connectionString: databaseUrl!,max: 1 });
  try {
    const page = await store.searchCatalog({
      tenantId: "tnt_selecttest1",
      operationId: "op_selecttest01",
      agentAttemptId: "agt_selecttest01",
      toolCallId: "catalog-call-1",
      query: "面积",
      limit: 10,
    });
    assert.equal(page.candidates.length,1);
    assert.equal(page.candidates[0]?.question_revision_id,"qrev_selecttest1");
    assert.equal(page.candidates[0]?.measurement_eligibility,"formal");
    assert.equal("answer" in (page.candidates[0] ?? {}),false);
    assert.equal("analysis" in (page.candidates[0] ?? {}),false);

    const decision = {
      schema_version: 3,
      decision_type: "selected",
      intent_id: "int_selecttest1",
      intent_revision: 1,
      chosen_question_revision_id: "qrev_selecttest1",
      satisfied_requirements: ["正式测量面积"],
      unsatisfied_preferences: [],
      scientific_purpose: "measure",
      target_dimensions: ["krev_selecttest1"],
      target_error_causes: [],
      evidence_refs: [page.page_ref],
      decision_summary: "该题具有正式 rubric 与面积测量目标。",
    };
    const payload = JSON.stringify(decision);
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.current_tenant','tnt_selecttest1',true)");
      await client.query(
        `insert into science_v3_agent_artifact(
           artifact_id,tenant_id,operation_id,artifact_kind,schema_uri,payload,sha256
         ) values('art_selectoutput1','tnt_selecttest1','op_selecttest01','structured_output',
           'https://schemas.mathpilot.dev/science-v3/selection-decision/v1',$1::jsonb,$2)`,
        [payload,createHash("sha256").update(payload).digest("hex")],
      );
      await client.query(
        `update science_v3_agent_attempt
            set status='succeeded',output_ref='agent-artifact:art_selectoutput1',
                resolved_model_id='deepseek-v4-flash-vision-exp',input_tokens=10,output_tokens=5,
                completed_at=clock_timestamp()
          where agent_attempt_id='agt_selecttest01'`,
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    const input = {
      tenantId: "tnt_selecttest1",
      operationId: "op_selecttest01",
      eventId: "evt_selecttest01",
      outputRef: "agent-artifact:art_selectoutput1",
    } as const;
    const committed = await store.commitDecision(input);
    assert.equal(committed.status,"selected");
    assert.deepEqual(await store.commitDecision(input),committed);

    const facts = (await pool.query<{
      lifecycle: string;
      operation_status: string;
      parts: unknown;
      opened_count: string;
    }>(
      `select session.lifecycle,operation.status as operation_status,message.parts,
              (select count(*) from science_v3_question_opened opened
                where opened.question_session_id=session.question_session_id) as opened_count
         from science_v3_question_session session
         join science_v3_operation operation on operation.operation_id='op_selecttest01'
         join science_v3_canonical_message message on message.question_session_id=session.question_session_id
        where session.selection_intent_id='int_selecttest1'`,
    )).rows[0]!;
    assert.equal(facts.lifecycle,"active");
    assert.equal(facts.operation_status,"succeeded");
    assert.equal(Number(facts.opened_count),1);
    const serializedParts = JSON.stringify(facts.parts);
    assert.equal(serializedParts.includes("答案为 4"),false);
    assert.equal(serializedParts.includes("is_correct"),false);

    const stale = await store.commitDecision({
      tenantId: "tnt_selecttest1",
      operationId: "op_selectstale1",
      eventId: "evt_selectstale1",
      outputRef: "agent-artifact:art_selectstaleout1",
    });
    assert.deepEqual(stale,{ status: "stale_intent",latestIntentRevision: 2 });
  } finally {
    await Promise.allSettled([store.close(),pool.end()]);
  }
});
