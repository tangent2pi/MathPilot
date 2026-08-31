import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { PostgresQuestionStore } from "../src/question-store.ts";
import { replayMastery, type BktParameters } from "../src/scientific-core.ts";
import { compileAndProjectQuestion } from "../src/scientific-store.ts";

const databaseUrl = process.env.SCIENTIFIC_STORE_TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;

const bktParameters: BktParameters = {
  parameterSetId: "bkt-oatutor-prior-v1",
  prior: 0.3,
  learn: 0,
  slip: 0.1,
  guess: 0.2,
  calibrationStatus: "prior_only",
  thresholds: { minimumIndependentCount: 2,weak: 0.4,learning: 0.8,mastered: 0.95 },
};

integration("scientific facts replay atomically and teacher correction replaces rather than double-counts", async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl! });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.current_tenant','tnt_flowtest01',true)");
    for (const [questionSessionId,projectedAt] of [
      ["qsn_science001","2026-01-01T00:02:00.000Z"],
      ["qsn_science002","2026-01-03T00:02:00.000Z"],
      ["qsn_science003","2026-01-06T00:02:00.000Z"],
    ] as const) {
      await compileAndProjectQuestion(client,{
        tenantId: "tnt_flowtest01",
        questionSessionId,
        frozenAttemptSequence: 1,
        projectedAt,
      });
    }
    await client.query("commit");

    await client.query("begin");
    await client.query(
      "select set_config('app.current_tenant','tnt_flowtest01',true),set_config('app.current_user','usr_flowteacher01',true)",
    );
    const before = await client.query<{
      p_mastery: string;
      independent_count: number;
      input_observation_ids: string[];
    }>(
      `select p_mastery,independent_count,input_observation_ids
         from science_v3_mastery_projection
        where tenant_id='tnt_flowtest01' and student_id='stu_flowtest01'
          and dimension_id='K_FLOW_TEST' and lineage_version=1`,
    );
    assert.ok(Math.abs(Number(before.rows[0]?.p_mastery) - 0.5203426124197005) < 1e-12);
    assert.equal(before.rows[0]?.independent_count,3);
    assert.equal((await client.query("select count(*)::int as count from science_v3_delayed_review_event")).rows[0].count,2);
    assert.equal((await client.query("select review_count from science_v3_retention_projection")).rows[0].review_count,2);

    await client.query("set local role mathpilot_app");
    await client.query("savepoint reject_student_correction");
    await client.query("select set_config('app.current_user','usr_flowstudent01',true)");
    await assert.rejects(
      client.query(
        `select * from mathpilot_science_v3_record_teacher_correction(
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16
        )`,
        [
          "tnt_flowtest01","tcor_rejected01","op_rejectedfix1","evt_rejectedfix1","idem.rejectedfix1",
          "usr_flowstudent01","jdg_science003","jdg_rejectedfix1","correct",
          JSON.stringify([{ rubric_item_id: "rubric_flowtest01",status: "met",evidence_refs: ["answer://msg_science003/part-1"] }]),
          JSON.stringify([{ dimension_revision_id: "krev_flowtest_v1",rubric_item_id: "rubric_flowtest01",outcome: "success" }]),
          "low","Unauthorized correction.",["answer://msg_science003/part-1"],"Unauthorized.","2026-01-06T23:00:00.000Z",
        ],
      ),
      /teacher role required/,
    );
    await client.query("rollback to savepoint reject_student_correction");
    await client.query("select set_config('app.current_user','usr_flowteacher01',true)");

    await client.query(
      `select * from mathpilot_science_v3_record_teacher_correction(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16
      )`,
      [
        "tnt_flowtest01","tcor_science001","op_sciencefix01","evt_sciencefix01","idem.sciencefix01",
        "usr_flowteacher01","jdg_science003","jdg_sciencefix01","correct",
        JSON.stringify([{ rubric_item_id: "rubric_flowtest01",status: "met",evidence_refs: ["answer://msg_science003/part-1"] }]),
        JSON.stringify([{ dimension_revision_id: "krev_flowtest_v1",rubric_item_id: "rubric_flowtest01",outcome: "success" }]),
        "low","Teacher verified the response as correct.",["answer://msg_science003/part-1"],
        "The original Judgment used the wrong answer key.","2026-01-07T00:00:00.000Z",
      ],
    );
    await client.query("reset role");
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  const store = new PostgresQuestionStore(databaseUrl!);
  try {
    const input = {
      schemaVersion: 3 as const,
      tenantId: "tnt_flowtest01",
      operationId: "op_sciencefix01",
      eventId: "evt_sciencefix01",
      studentId: "stu_flowtest01",
      teacherCorrectionId: "tcor_science001",
      aggregateVersion: 2,
      inputRef: "teacher-correction:tcor_science001",
    };
    const first = await store.replayCorrection(input);
    const replay = await store.replayCorrection(input);
    assert.deepEqual(replay,first);
  } finally {
    await store.close();
  }

  const check = new pg.Pool({ connectionString: databaseUrl! });
  try {
    const client = await check.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.current_tenant','tnt_flowtest01',true)");
      const projection = await client.query<{
        p_mastery: string;
        independent_count: number;
        input_observation_ids: string[];
      }>(
        `select p_mastery,independent_count,input_observation_ids
           from science_v3_mastery_projection
          where tenant_id='tnt_flowtest01' and student_id='stu_flowtest01'
            and dimension_id='K_FLOW_TEST' and lineage_version=1`,
      );
      const expected = replayMastery(["success","success","success"].map((outcome,index) => ({
        observationId: `obs_expected${index}`,
        outcome: outcome as "success",
        occurredAt: new Date(Date.UTC(2026,0,index * 2 + 1)).toISOString(),
      })),bktParameters).pMastery;
      assert.ok(Math.abs(Number(projection.rows[0]?.p_mastery) - expected) < 1e-12);
      assert.equal(projection.rows[0]?.independent_count,3);
      const sourceJudgments = await client.query<{ judgment_id: string }>(
        `select j.judgment_id
           from unnest($1::text[]) ids(observation_id)
           join science_v3_observation o using (observation_id)
           join science_v3_judgment j on j.tenant_id=o.tenant_id and j.judgment_id=o.judgment_id
          order by j.judgment_id`,
        [projection.rows[0]?.input_observation_ids ?? []],
      );
      assert.deepEqual(sourceJudgments.rows.map((row) => row.judgment_id),[
        "jdg_science001","jdg_science002","jdg_sciencefix01",
      ]);
      assert.equal((await client.query("select count(*)::int as count from science_v3_operation_result where operation_id='op_sciencefix01'")).rows[0].count,1);
      assert.equal((await client.query("select status from science_v3_operation where operation_id='op_sciencefix01'")).rows[0].status,"succeeded");
      assert.equal((await client.query("select review_count from science_v3_retention_projection")).rows[0].review_count,2);
      await client.query("commit");
    } finally {
      client.release();
    }
  } finally {
    await check.end();
  }
  await pool.end();
});
