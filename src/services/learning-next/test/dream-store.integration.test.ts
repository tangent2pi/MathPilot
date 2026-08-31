import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresDreamStore } from "../src/dream-store.ts";

const databaseUrl = process.env.DREAM_STORE_TEST_DATABASE_URL;
const TENANT = "tnt_flowtest01";
const STUDENT = "stu_flowtest01";
const TEACHER = "usr_flowteacher01";

const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

interface RunFixture {
  phase: "light" | "rem" | "deep";
  dreamRunId: string;
  operationId: string;
  eventId: string;
  inputArtifactId: string;
  outputArtifactId: string;
  input: Record<string, unknown>;
}

async function seedSucceededAttempt(
  pool: pg.Pool,
  run: RunFixture,
  output: unknown,
): Promise<void> {
  const outputSchema = run.phase === "light" ? "light-output" : run.phase === "rem" ? "rem-output" : "annotation-change-set";
  const outputRef = `agent-artifact:${run.outputArtifactId}`;
  await pool.query(
    `insert into science_v3_agent_artifact(
       artifact_id,tenant_id,operation_id,artifact_kind,schema_uri,payload,sha256
     ) values($1,$2,$3,'structured_output',$4,$5::jsonb,$6)`,
    [run.outputArtifactId, TENANT, run.operationId,
      `https://schemas.mathpilot.dev/science-v3/${outputSchema}/v1`, JSON.stringify(output), sha(output)],
  );
  await pool.query(
    `insert into science_v3_agent_attempt(
       agent_attempt_id,tenant_id,operation_id,workflow_id,workflow_run_id,
       temporal_activity_id,task_type,task_spec_version,temporal_attempt,status,
       input_ref,output_ref,model_policy_id,resolved_model_id,prompt_version,skill_ref,
       input_tokens,output_tokens,completed_at
     ) values($1,$2,$3,$4,$5,$6,$7,'v1',1,'succeeded',$8,$9,$10,$11,$12,$13,10,5,clock_timestamp())`,
    [`agt_${run.dreamRunId.slice(4)}`, TENANT, run.operationId, `dream:${run.phase}:${run.dreamRunId}`,
      `run-${run.dreamRunId}`, `activity-${run.dreamRunId}`, run.phase,
      `agent-artifact:${run.inputArtifactId}`, outputRef, `${run.phase}-model-v1`,
      "deepseek-v4-flash-vision-exp", `${run.phase}-prompt-v1`, `skill:dream-${run.phase}@v1`],
  );
}

async function seedLightRun(
  pool: pg.Pool,
  index: number,
): Promise<{ run: RunFixture; output: Record<string, unknown> }> {
  const suffix = String(index).padStart(2, "0");
  const questionSessionId = `qsn_science00${index}`;
  const attemptId = `att_science00${index}`;
  const judgmentId = `jdg_science00${index}`;
  const operationId = `op_dreamlight${suffix}`;
  const eventId = `evt_dreamlight${suffix}`;
  const inputArtifactId = `art_dreamlightin${suffix}`;
  const outputArtifactId = `art_dreamlightout${suffix}`;
  const dreamRunId = `drm_dreamlight${suffix}`;
  const supportRef = index === 3 ? `judgment://${judgmentId}` : `attempt://${attemptId}`;
  const input = {
    schema_version: 3,
    compiler_version: "light-compiler-v1",
    dream_run_id: dreamRunId,
    student_id: STUDENT,
    question_session_id: questionSessionId,
    question_closure_ref: `question-closure:qcl_dreamlight${suffix}`,
    frozen_context: {
      question_revision_id: "qrev_flowtest_v1",
      measurement_contract: { dimension_revision_ids: ["krev_flowtest_v1"] },
    },
    effective_attempts: [{ attempt_ref: `attempt://${attemptId}` }],
    judgments: [{ fact_ref: `judgment://${judgmentId}`, dimension_revision_ids: ["krev_flowtest_v1"] }],
    observations: [],
    error_evidence: [],
    projection_refs: [],
    source_manifest: [`attempt://${attemptId}`, `judgment://${judgmentId}`],
    prior_annotations: [],
    closed_at: `2026-01-0${index}T00:02:00Z`,
    history_is_untrusted_data: true,
  };
  const output = {
    schema_version: 3,
    status: "ready",
    dream_run_id: dreamRunId,
    student_id: STUDENT,
    question_session_id: questionSessionId,
    dimensions: ["krev_flowtest_v1"],
    error_causes: [],
    observed_behaviors: [index === 3 ? "出现一次反例" : "独立完成"],
    method_signals: ["先整理再代入"],
    hint_dependency: "none",
    self_correction: index === 3 ? "failed" : "successful",
    transfer_context: index === 1
      ? { representation: "symbolic", difficulty: "near" }
      : index === 2
        ? { representation: "verbal", difficulty: "near" }
        : { representation: "symbolic", difficulty: "far" },
    supports: [supportRef],
    counters: [],
    unresolved: [],
    source_refs: [`attempt://${attemptId}`, `judgment://${judgmentId}`],
    summary: `Light fixture ${index}`,
  };
  await pool.query(
    `insert into science_v3_operation(
       operation_id,tenant_id,requested_by_user_id,kind,status,user_message,version
     ) values($1,$2,$3,'dream','succeeded','Light fixture complete',2)`,
    [operationId, TENANT, TEACHER],
  );
  await pool.query(
    `insert into science_v3_agent_artifact(
       artifact_id,tenant_id,operation_id,artifact_kind,schema_uri,payload,sha256
     ) values($1,$2,$3,'input_bundle','https://schemas.mathpilot.dev/science-v3/light-input/v1',$4::jsonb,$5)`,
    [inputArtifactId, TENANT, operationId, JSON.stringify(input), sha(input)],
  );
  await pool.query(
    `insert into infra_outbox(
       event_id,tenant_id,aggregate_type,aggregate_id,event_type,payload,occurred_at,
       aggregate_version,payload_ref,operation_id
     ) values($1,$2,'question-session',$3,'question.closed','{}'::jsonb,clock_timestamp(),2,$4,$5)`,
    [eventId, TENANT, questionSessionId, `agent-artifact:${inputArtifactId}`, operationId],
  );
  await pool.query(
    `insert into science_v3_dream_run(
       dream_run_id,tenant_id,student_id,operation_id,source_event_id,phase,window_ref,
       compiler_version,policy_version,input_artifact_id
     ) values($1,$2,$3,$4,$5,'light',$6,'light-compiler-v1','deep-gate-v1',$7)`,
    [dreamRunId, TENANT, STUDENT, operationId, eventId, `question-session:${questionSessionId}`, inputArtifactId],
  );
  const run = { phase: "light" as const, dreamRunId, operationId, eventId, inputArtifactId, outputArtifactId, input };
  await seedSucceededAttempt(pool, run, output);
  return { run, output };
}

async function loadQueuedRun(pool: pg.Pool, phase: "rem" | "deep"): Promise<RunFixture> {
  const row = (await pool.query<{
    dream_run_id: string;
    operation_id: string;
    source_event_id: string;
    input_artifact_id: string;
    payload: Record<string, unknown>;
  }>(
    `select run.dream_run_id,run.operation_id,run.source_event_id,run.input_artifact_id,artifact.payload
       from science_v3_dream_run run join science_v3_agent_artifact artifact
         on artifact.tenant_id=run.tenant_id and artifact.artifact_id=run.input_artifact_id
      where run.tenant_id=$1 and run.student_id=$2 and run.phase=$3 and run.status='queued'
      order by run.created_at desc limit 1`,
    [TENANT, STUDENT, phase],
  )).rows[0];
  assert.ok(row, `${phase} run was not enqueued`);
  return {
    phase,
    dreamRunId: row.dream_run_id,
    operationId: row.operation_id,
    eventId: row.source_event_id,
    inputArtifactId: row.input_artifact_id,
    outputArtifactId: `art_${phase}fixtureout1`,
    input: row.payload,
  };
}

async function markOperationRunning(pool: pg.Pool, operationId: string): Promise<void> {
  await pool.query(
    `update science_v3_operation
        set status='running',user_message='fixture running',updated_at=clock_timestamp(),version=version+1
      where tenant_id=$1 and operation_id=$2 and status='accepted'`,
    [TENANT, operationId],
  );
}

test("DreamStore commits Light -> REM -> Deep and rolls back the latest semantic change", {
  skip: databaseUrl ? false : "DREAM_STORE_TEST_DATABASE_URL is not set",
}, async () => {
  assert.ok(databaseUrl);
  const store = new PostgresDreamStore(databaseUrl);
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    for (let index = 1; index <= 3; index += 1) {
      const { run } = await seedLightRun(pool, index);
      await store.beginRun({
        tenantId: TENANT, operationId: run.operationId, eventId: run.eventId,
        inputRef: `agent-artifact:${run.inputArtifactId}`, phase: "light",
      });
      const result = await store.commitLight({
        tenantId: TENANT, operationId: run.operationId, eventId: run.eventId,
        inputRef: `agent-artifact:${run.inputArtifactId}`,
        outputRef: `agent-artifact:${run.outputArtifactId}`, phase: "light",
      });
      assert.equal(result.status, "completed");
    }

    const rem = await loadQueuedRun(pool, "rem");
    const lightAtoms = rem.input.light_atoms as Array<Record<string, unknown>>;
    const remWindow = rem.input.window as Record<string, unknown>;
    assert.equal(lightAtoms.length, 3);
    const remOutput = {
      schema_version: 3,
      dream_run_id: rem.dreamRunId,
      window_id: rem.input.window_id,
      student_id: STUDENT,
      candidates: [{
        candidate_id: "remc_modelfixture1",
        target_kind: "dimension",
        target_ref: "dimension:krev_flowtest_v1",
        proposed_claim: "多种表述下通常能先整理再代入，但保留一个反例。",
        proposed_scope: { topic: "flow_test" },
        support_atom_refs: lightAtoms.slice(0, 2).map((atom) => atom.atom_ref),
        counter_atom_refs: [lightAtoms[2]!.atom_ref],
        contradictions: ["第三题出现一次反例"],
        actionability: "安排一次近迁移复核。",
        distinct_session_count: Number(remWindow.distinct_session_count),
        context_diversity: Number(remWindow.context_diversity),
        recency: "mixed",
        source_trust: "verified_facts",
        recommended_action: "deep_review",
      }],
      summary: "REM fixture candidate",
    };
    await store.beginRun({
      tenantId: TENANT, operationId: rem.operationId, eventId: rem.eventId,
      inputRef: `agent-artifact:${rem.inputArtifactId}`, phase: "rem",
    });
    await markOperationRunning(pool, rem.operationId);
    await seedSucceededAttempt(pool, rem, remOutput);
    const remResult = await store.commitRem({
      tenantId: TENANT, operationId: rem.operationId, eventId: rem.eventId,
      inputRef: `agent-artifact:${rem.inputArtifactId}`,
      outputRef: `agent-artifact:${rem.outputArtifactId}`, phase: "rem",
    });
    assert.equal(remResult.status, "completed");

    const deep = await loadQueuedRun(pool, "deep");
    const candidate = (deep.input.gated_candidates as Array<Record<string, unknown>>)[0]!;
    const expectedVersion = Number(deep.input.expected_annotation_set_version);
    const deepOutput = {
      schema_version: 3,
      change_set_id: "acs_modelfixture1",
      student_id: STUDENT,
      dream_run_id: deep.dreamRunId,
      expected_annotation_set_version: expectedVersion,
      operations: [{
        op: "add",
        annotation: {
          target_kind: "dimension",
          target_ref: candidate.target_ref,
          claim: candidate.claim,
          scope: candidate.scope,
          support_refs: candidate.support_refs,
          counter_refs: candidate.counter_refs,
          confidence: "medium",
          trend: "mixed",
          action_hint: candidate.actionability,
          valid_from: "2026-08-31T00:00:00Z",
        },
      }],
      source_refs: [candidate.candidate_ref],
      policy_version: "deep-gate-v1",
      model_id: "deepseek-v4-flash-vision-exp",
      prompt_version: "deep-prompt-v1",
      skill_version: "dream-deep@v1",
      created_at: "2026-08-31T00:00:00Z",
    };
    await store.beginRun({
      tenantId: TENANT, operationId: deep.operationId, eventId: deep.eventId,
      inputRef: `agent-artifact:${deep.inputArtifactId}`, phase: "deep",
    });
    await markOperationRunning(pool, deep.operationId);
    await seedSucceededAttempt(pool, deep, deepOutput);
    const deepResult = await store.commitDeep({
      tenantId: TENANT, operationId: deep.operationId, eventId: deep.eventId,
      inputRef: `agent-artifact:${deep.inputArtifactId}`,
      outputRef: `agent-artifact:${deep.outputArtifactId}`, phase: "deep",
    });
    assert.equal(deepResult.status, "completed");
    const changeSetId = deepResult.resourceRefs[0]!.slice("annotation-change-set:".length);
    const beforeRollback = await pool.query<{ version: string; active: string; diary: string }>(
      `select head.version,
              (select count(*) from science_v3_semantic_annotation annotation
                where annotation.tenant_id=head.tenant_id and annotation.student_id=head.student_id
                  and not exists(select 1 from science_v3_annotation_supersession supersession
                                  where supersession.tenant_id=annotation.tenant_id
                                    and supersession.superseded_annotation_id=annotation.annotation_id)) as active,
              (select count(*) from science_v3_dream_diary_entry diary
                where diary.tenant_id=head.tenant_id and diary.student_id=head.student_id) as diary
         from science_v3_annotation_set_head head
        where head.tenant_id=$1 and head.student_id=$2`,
      [TENANT, STUDENT],
    );
    assert.equal(Number(beforeRollback.rows[0]!.version), 1);
    assert.equal(Number(beforeRollback.rows[0]!.active), 1);
    assert.equal(Number(beforeRollback.rows[0]!.diary), 5);

    const rollback = await store.rollbackChangeSet({
      tenantId: TENANT,
      changeSetId,
      actorUserId: TEACHER,
      reason: "integration test rollback",
    });
    assert.equal(rollback.fromSetVersion, 1);
    assert.equal(rollback.toSetVersion, 2);
    assert.equal(rollback.retiredAnnotationIds.length, 1);
    assert.deepEqual(rollback.restoredAnnotationIds, []);
  } finally {
    await Promise.allSettled([store.close(), pool.end()]);
  }
});
