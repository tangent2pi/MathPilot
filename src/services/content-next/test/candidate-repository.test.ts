import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "@mathpilot/content-integrity/node";
import type pg from "pg";
import {
  CandidateRepository,
  type CandidateInput,
  type CandidateSummary,
} from "../src/candidate-repository.ts";
import type { Principal } from "../src/lib.ts";

const principal: Principal = Object.freeze({
  tenantId: "tnt_candidate",
  userId: "usr_candidate_teacher",
  roles: ["teacher"],
});

const candidateResult = {
  questions: [{
    question_id: "Q_candidate",
    question_type: { id: "T_candidate" },
    stem_markdown: "1 + 1 = ?",
  }],
};
const resultSha256 = canonicalJson(candidateResult, 4 * 1024 * 1024).sha256;
const sourceSha256 = "e".repeat(64);

interface QueryCall {
  text: string;
  values: readonly unknown[];
}

interface DescriptorRow {
  object_id: unknown;
  version_id: unknown;
  sha256: unknown;
  byte_size: unknown;
  mime_type: unknown;
  original_name: unknown;
  source_version_id: unknown;
  source_sha256: unknown;
  source_byte_size: unknown;
  source_mime_type: unknown;
}

function sourceClaimRow(): DescriptorRow & { workspace_path: string } {
  return {
    workspace_path: "input/original/source.pdf",
    object_id: "obj_source123",
    version_id: "version-source",
    sha256: sourceSha256,
    byte_size: "1024",
    mime_type: "application/pdf",
    original_name: "source.pdf",
    source_version_id: "source-version-source",
    source_sha256: "f".repeat(64),
    source_byte_size: "1024",
    source_mime_type: "application/pdf",
  };
}

function candidateInput(): CandidateInput {
  return {
    phase: "ktq",
    threadId: "thr_candidate",
    toolCallId: "call_candidate",
    resultSha256,
    resultObjectId: "obj_result123",
    receiptObjectId: "obj_receipt123",
    sourceObjects: [{
      workspacePath: "input/original/source.pdf",
      objectId: "obj_source123",
      versionId: "version-source",
      sha256: sourceSha256,
    }],
    result: candidateResult,
  };
}

function fakePool(
  sourceDescriptor: DescriptorRow & { workspace_path: string } = sourceClaimRow(),
  replay?: {
    candidate: CandidateSummary & {
      result_object_id: string;
      receipt_object_id: string;
      result_sha256: string;
      input_candidate_set_id: string | null;
      supersedes_candidate_set_id: string | null;
    };
    sources: Array<{ workspace_path: string; object_id: string; version_id: string; sha256: string }>;
  },
): { pool: pg.Pool; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const client = {
    async query(text: string, values: readonly unknown[] = []) {
      calls.push({ text, values });
      const sql = text.replace(/\s+/g, " ").trim();
      let rows: unknown[] = [];
      if (sql.includes("from identity_user_role")) {
        rows = [{ role: "teacher" }];
      } else if (sql.includes("respond_tool_call_id=$4")) {
        rows = replay ? [replay.candidate] : [];
      } else if (sql.includes("from content_candidate_source_object") && sql.includes("order by workspace_path")) {
        rows = replay?.sources ?? [];
      } else if (sql.includes("mathpilot_content_bind_candidate_source_object")) {
        rows = [sourceDescriptor];
      } else if (sql.includes("max(sequence_no)")) {
        rows = [{ sequence_no: 1 }];
      } else if (sql.includes("max(revision_no)")) {
        rows = [{ revision_no: 1 }];
      } else if (sql.includes("max(item_order)")) {
        rows = [{ item_order: 0 }];
      } else if (sql.includes("from content_candidate_set s where candidate_set_id=$1")) {
        rows = [{
          candidate_set_id: String(values[0]),
          phase: "ktq",
          owner_teacher_user_id: principal.userId,
          thread_id: "thr_candidate",
          sequence_no: 1,
          status: "pending_review",
          item_count: 2,
          created_at: "2026-09-01T00:00:00.000Z",
          decided_at: null,
        } satisfies CandidateSummary];
      }
      return { rows };
    },
    release() {},
  };
  return {
    pool: { connect: async () => client } as unknown as pg.Pool,
    calls,
  };
}

test("candidate registration delegates audit retention to the candidate row and binds sources through one DB adapter", async () => {
  const { pool, calls } = fakePool();
  const candidate = await new CandidateRepository(pool).register(principal, candidateInput());

  assert.equal(candidate.candidate_set_id.startsWith("cset_"), true);
  const claimCalls = calls.filter((call) => call.text.includes("mathpilot_content_claim_candidate_audit_object"));
  assert.equal(claimCalls.length, 0);
  const sourceClaimCalls = calls.filter((call) => call.text.includes("mathpilot_content_bind_candidate_source_object"));
  assert.equal(sourceClaimCalls.length, 1);
  assert.deepEqual(sourceClaimCalls[0]!.values.slice(0, 6), [
    principal.tenantId,
    principal.userId,
    ["input/original/source.pdf"],
    ["obj_source123"],
    ["version-source"],
    [sourceSha256],
  ]);
  assert.equal(sourceClaimCalls[0]!.values[6], candidate.candidate_set_id);
  assert.equal(calls.some((call) => call.text.includes("insert into content_candidate_source_object")), false);
  assert.ok(calls.findIndex((call) => call.text.includes("insert into content_candidate_set"))
    < calls.findIndex((call) => call.text.includes("mathpilot_content_bind_candidate_source_object")));
  assert.equal(calls.some((call) => /select object_id,purpose,state/i.test(call.text)), false);
  assert.equal(calls.at(-1)?.text, "commit");
});

test("candidate replay compares frozen sources and lineage while allowing replacement audit uploads", async () => {
  const existing = {
    candidate_set_id: "cset_existing01",
    phase: "ktq" as const,
    owner_teacher_user_id: principal.userId,
    thread_id: "thr_candidate",
    sequence_no: 1,
    status: "pending_review",
    item_count: 2,
    created_at: "2026-09-01T00:00:00.000Z",
    decided_at: null,
    result_object_id: "obj_original_result",
    receipt_object_id: "obj_original_receipt",
    result_sha256: resultSha256,
    input_candidate_set_id: null,
    supersedes_candidate_set_id: null,
  };
  const frozenSources = [{
    workspace_path: "input/original/source.pdf",
    object_id: "obj_source123",
    version_id: "version-source",
    sha256: sourceSha256,
  }];
  const replayInput = {
    ...candidateInput(),
    resultObjectId: "obj_retry_result1",
    receiptObjectId: "obj_retry_receipt1",
  };
  const accepted = fakePool(sourceClaimRow(), { candidate: existing, sources: frozenSources });
  const replayed = await new CandidateRepository(accepted.pool).register(principal, replayInput);
  assert.equal(replayed.created, false);
  assert.equal(replayed.result_object_id, existing.result_object_id);
  assert.equal(accepted.calls.some((call) => call.text.includes("mathpilot_content_bind_candidate_source_object")), false);

  const changed = fakePool(sourceClaimRow(), { candidate: existing, sources: frozenSources });
  await assert.rejects(
    new CandidateRepository(changed.pool).register(principal, {
      ...replayInput,
      sourceObjects: [{ ...replayInput.sourceObjects[0]!, sha256: "a".repeat(64) }],
    }),
    /already bound to different candidate content/,
  );
  assert.equal(changed.calls.at(-1)?.text, "rollback");
});

test("candidate registration rejects a bound source descriptor that does not freeze exact object bytes", async (t) => {
  const invalidRows: Array<{ name: string; mutate: (row: DescriptorRow) => void }> = [
    { name: "version", mutate: (row) => { row.version_id = null; } },
    { name: "hash", mutate: (row) => { row.sha256 = "not-a-sha256"; } },
    { name: "MIME", mutate: (row) => { row.mime_type = null; } },
    { name: "size", mutate: (row) => { row.byte_size = "0"; } },
  ];

  for (const invalid of invalidRows) {
    await t.test(invalid.name, async () => {
      const source = sourceClaimRow();
      invalid.mutate(source);
      const { pool, calls } = fakePool(source);

      await assert.rejects(
        new CandidateRepository(pool).register(principal, candidateInput()),
        /candidate source object|immutable descriptor|invalid byte_size/,
      );
      assert.equal(calls.some((call) => call.text.includes("insert into content_candidate_set")), true);
      assert.equal(calls.at(-1)?.text, "rollback");
    });
  }
});

test("candidate registration rejects a non-image descriptor used as a question image", async () => {
  const result = {
    questions: [{
      ...candidateResult.questions[0],
      image_refs: ["input/original/source.pdf"],
    }],
  };
  const input = {
    ...candidateInput(),
    result,
    resultSha256: canonicalJson(result, 4 * 1024 * 1024).sha256,
  };
  const { pool, calls } = fakePool();
  await assert.rejects(
    new CandidateRepository(pool).register(principal, input),
    /question image is backed by a non-image object/,
  );
  assert.equal(calls.at(-1)?.text, "rollback");
});
