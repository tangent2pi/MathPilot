import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { PostgresQuestionStore } from "../src/question-store.ts";

const connectionString = process.env.QUESTION_STORE_TEST_DATABASE_URL;

test("QuestionStore records bounded unresolved grading and commits one closure", {
  skip: connectionString ? false : "QUESTION_STORE_TEST_DATABASE_URL is not set",
}, async () => {
  assert.ok(connectionString);
  const store = new PostgresQuestionStore(connectionString);
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    const prepared = await store.prepareFinalization({
      schemaVersion: 3,
      tenantId: "tnt_flowtest01",
      operationId: "op_flowcut0001",
      eventId: "evt_flowcut0001",
      cutRequestId: "cut_flowtest01",
      questionSessionId: "qsn_flowtest01",
      aggregateVersion: 3,
      inputRef: "agent-artifact:art_flowcut0001",
    });
    assert.equal(prepared.gradeTasks.length, 1);
    const grade = prepared.gradeTasks[0]!;
    assert.equal(grade.attemptId, "att_flowtest01");
    assert.equal(grade.workflowInput.resultOwnership, "parent");

    await store.recordUnresolvedJudgment({
      tenantId: "tnt_flowtest01",
      cutRequestId: "cut_flowtest01",
      questionSessionId: "qsn_flowtest01",
      attemptId: grade.attemptId,
      judgmentId: grade.judgmentId,
      reason: "bounded grading test failure",
    });
    const input = {
      tenantId: "tnt_flowtest01",
      operationId: "op_flowcut0001",
      eventId: "evt_flowcut0001",
      cutRequestId: "cut_flowtest01",
      questionSessionId: "qsn_flowtest01",
    } as const;
    const first = await store.commitClosure(input);
    const replay = await store.commitClosure(input);
    assert.deepEqual(replay, first);
    assert.equal(first.status, "closed");
    assert.equal(first.sessionVersion, 4);
    assert.equal(first.judgmentRefs.length, 1);
    assert.deepEqual(first.observationRefs, []);

    const evidence = await pool.query<{
      lifecycle: string;
      active_epochs: string;
      closure_count: string;
      closed_events: string;
      operation_results: string;
      operation_status: string;
    }>(
      `select q.lifecycle,
              (select count(*) from science_v3_foreground_agent_epoch e
                where e.active_question_session_id=q.question_session_id and e.ended_at is null) as active_epochs,
              (select count(*) from science_v3_question_closure c
                where c.question_session_id=q.question_session_id) as closure_count,
              (select count(*) from infra_outbox o
                where o.aggregate_id=q.question_session_id and o.event_type='question.closed') as closed_events,
              (select count(*) from science_v3_operation_result r
                where r.operation_id='op_flowcut0001') as operation_results,
              (select status from science_v3_operation where operation_id='op_flowcut0001') as operation_status
         from science_v3_question_session q where q.question_session_id='qsn_flowtest01'`,
    );
    const row = evidence.rows[0]!;
    assert.equal(row.lifecycle, "closed");
    assert.equal(Number(row.active_epochs), 0);
    assert.equal(Number(row.closure_count), 1);
    assert.equal(Number(row.closed_events), 1);
    assert.equal(Number(row.operation_results), 1);
    assert.equal(row.operation_status, "succeeded");
  } finally {
    await Promise.allSettled([store.close(), pool.end()]);
  }
});
