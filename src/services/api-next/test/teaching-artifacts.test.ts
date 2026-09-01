import assert from "node:assert/strict";
import test from "node:test";
import {
  MATH_DERIVATION_ARTIFACT_SCHEMA,
  MATH_DERIVATION_ARTIFACT_SCHEMA_URI,
} from "@mathpilot/contracts";
import type pg from "pg";
import { canonicalJson } from "@mathpilot/content-integrity/node";
import {
  materializeTeachingArtifacts,
  teachingArtifactKey,
} from "../src/learning-read/teaching-artifacts.ts";

const artifactRef = "agent-artifact:art_derivation01";
const referencePart = {
  type: "teaching_artifact" as const,
  artifact_ref: artifactRef,
  artifact_schema: MATH_DERIVATION_ARTIFACT_SCHEMA,
  summary: "逐步配方求解。",
};

test("teaching artifact hydration is bound to the authorized foreground chain and one message", async () => {
  let queryText = "";
  let queryValues: unknown[] = [];
  const payload = {
    schema_version: 3,
    artifact_schema: MATH_DERIVATION_ARTIFACT_SCHEMA,
    summary: referencePart.summary,
    content: {
      schema: MATH_DERIVATION_ARTIFACT_SCHEMA,
      label: "配方法",
      secret_payload: "must-not-project",
      steps: [{ expression: "(x+3)^2=4", note: "两边同时补 9", private_state: 1 }],
    },
  };
  const client = {
    async query(text: string, values: unknown[]) {
      queryText = text;
      queryValues = values;
      return { rows: [{
        message_id: "msg_response01",
        artifact_ref: artifactRef,
        artifact_schema: MATH_DERIVATION_ARTIFACT_SCHEMA,
        summary: referencePart.summary,
        payload,
        sha256:canonicalJson(payload).sha256,
      }] };
    },
  } as unknown as pg.PoolClient;

  const materialized = await materializeTeachingArtifacts(client, {
    tenantId: "tnt_default",
    threadId: "thr_authorized01",
    studentId: "stu_authorized01",
    studentUserId: "usr_authorized01",
  }, [
    { message_id: "msg_response01", parts: [referencePart] },
    { message_id: "msg_response02", parts: [referencePart] },
  ]);

  for (const requiredJoin of [
    "science_v3_canonical_message",
    "science_v3_foreground_request",
    "science_v3_operation",
    "science_v3_learning_action",
    "science_v3_agent_attempt",
    "science_v3_agent_artifact",
  ]) assert.match(queryText, new RegExp(requiredJoin));
  assert.match(queryText, /operation\.requested_by_user_id=\$4/);
  assert.match(queryText, /request\.student_id=\$3/);
  assert.match(queryText, /attempt\.output_ref=request\.output_ref/);
  assert.match(queryText, /artifact\.expires_at is null or artifact\.expires_at>now\(\)/);
  assert.deepEqual(queryValues, [
    "tnt_default",
    "thr_authorized01",
    "stu_authorized01",
    "usr_authorized01",
    MATH_DERIVATION_ARTIFACT_SCHEMA_URI,
    ["msg_response01", "msg_response02"],
    MATH_DERIVATION_ARTIFACT_SCHEMA,
  ]);
  assert.deepEqual(materialized.get(teachingArtifactKey("msg_response01", artifactRef)), {
    schema: MATH_DERIVATION_ARTIFACT_SCHEMA,
    summary: referencePart.summary,
    presentation: {
      schema: MATH_DERIVATION_ARTIFACT_SCHEMA,
      label: "配方法",
      steps: [{ expression: "(x+3)^2=4", note: "两边同时补 9" }],
    },
  });
  assert.equal(materialized.has(teachingArtifactKey("msg_response02", artifactRef)), false);
});

test("messages without the registered artifact schema do not query artifact storage", async () => {
  const client = {
    async query() { throw new Error("query must not run"); },
  } as unknown as pg.PoolClient;
  const result = await materializeTeachingArtifacts(client, {
    tenantId: "tnt_default",
    threadId: "thr_authorized01",
    studentId: "stu_authorized01",
    studentUserId: "usr_authorized01",
  }, [{
    message_id: "msg_plaintext01",
    parts: [{ type: "text", text: "普通消息" }],
  }]);
  assert.equal(result.size, 0);
});
