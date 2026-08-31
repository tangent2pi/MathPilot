import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { TASK_REGISTRY } from "../src/task-registry.ts";
import { compileWorkspaceProjection } from "../src/workspace-projection.ts";

const databaseUrl = process.env.WORKSPACE_PROJECTION_TEST_DATABASE_URL;

test("WorkspaceProjection exposes only same-account science-v3 user-visible state", {
  skip: databaseUrl ? false : "WORKSPACE_PROJECTION_TEST_DATABASE_URL is not set",
}, async () => {
  assert.ok(databaseUrl);
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.current_tenant','tnt_flowtest01',true)");
    const projection = await compileWorkspaceProjection(client, {
      tenantId: "tnt_flowtest01",
      operationId: "op_flowcut0001",
      conversationThreadId: "thr_flowtest01",
      foregroundEpochId: "fge_flowtest01",
      taskSpec: TASK_REGISTRY.foreground_teaching,
    });
    const byPath = new Map(projection.files.map((file) => [file.path, file.content]));
    assert.ok(byPath.has("AGENT_CONTEXT.md"));
    assert.ok(byPath.has("current/scientific-state.json"));
    assert.match(byPath.get("current/question.md")!, /Compute the test value/);
    const all = projection.files.map((file) => `${file.path}\n${file.content}`).join("\n");
    assert.match(all, /thr_flowtest01/);
    assert.doesNotMatch(all, /thr_flowtest02/);
    assert.doesNotMatch(all, /The test value is one/);
    assert.doesNotMatch(all, /dream_diary_entry/);
    assert.doesNotMatch(all, /agent_attempt_id/);
    const capabilities = JSON.parse(byPath.get("capabilities.json")!) as { read_only: boolean; writable_paths: unknown[] };
    assert.equal(capabilities.read_only, true);
    assert.deepEqual(capabilities.writable_paths, []);
    await client.query("rollback");
  } finally {
    client.release();
    await pool.end();
  }
});
