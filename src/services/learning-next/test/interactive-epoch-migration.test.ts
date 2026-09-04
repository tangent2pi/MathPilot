import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { OutboxRelay, type OutboxRelayStore } from "../src/outbox-relay.ts";
import { temporalDriverExecutionId } from "../src/activities.ts";
import type { OutboxWorkflowStart } from "../src/runtime-types.ts";

test("0042 keeps Temporal identity strict and gives Interactive Epoch its own driver identity", async () => {
  const migration = await readFile(new URL("../../../../db/migrations/0042_science_v3_interactive_epoch.sql", import.meta.url), "utf8");
  assert.match(migration, /execution_driver in \('temporal_activity','interactive_epoch'\)/);
  assert.match(migration, /driver_execution_id text/);
  assert.match(migration, /execution_driver='temporal_activity'[\s\S]*workflow_id is not null[\s\S]*temporal_attempt > 0/);
  assert.match(migration, /execution_driver='interactive_epoch'[\s\S]*workflow_id is null[\s\S]*temporal_attempt is null/);
  assert.match(migration, /science_v3_foreground_request_active_thread_uidx[\s\S]*where status in \('queued','running'\)/);
  assert.match(migration, /duplicate queued\/running requests exist/);
  assert.match(migration, /join public\.science_v3_foreground_request request[\s\S]*outbox\.published_at is not null or outbox\.workflow_id is not null[\s\S]*request\.status in \('queued','running'\)/);
  assert.match(migration, /stop and drain the old foreground relay\/workers/);
  assert.match(migration, /science_v3_agent_attempt_driver_execution_uidx/);
  assert.match(migration, /set driver_execution_id = 'temporal-attempt:' \|\| agent_attempt_id/);
  const dropGuard = migration.indexOf("drop trigger science_v3_agent_attempt_guard");
  const backfill = migration.indexOf("set driver_execution_id = 'temporal-attempt:'");
  const restoreGuard = migration.indexOf("create trigger science_v3_agent_attempt_guard", backfill);
  assert.ok(dropGuard >= 0 && dropGuard < backfill, "the immutable identity guard must be removed before backfill");
  assert.ok(restoreGuard > backfill, "the immutable identity guard must be restored after backfill");
  assert.match(migration.slice(restoreGuard), /forbid_mutation_except\([\s\S]*'workspace_manifest'/);
  assert.equal(temporalDriverExecutionId("agt_temporal0001"), "temporal-attempt:agt_temporal0001");
});

test("0042 keeps pending unpublished foreground rows upgradeable", async () => {
  const migration = await readFile(new URL("../../../../db/migrations/0042_science_v3_interactive_epoch.sql", import.meta.url), "utf8");
  const guard = migration.slice(migration.indexOf("A published foreground event"), migration.indexOf("A Thread has one active foreground turn"));
  assert.match(guard, /outbox\.event_type='foreground\.message_submitted'/);
  assert.match(guard, /outbox\.published_at is not null or outbox\.workflow_id is not null/);
  assert.match(guard, /request\.status in \('queued','running'\)/);
});

test("learning read projection selection is driver-neutral", async () => {
  const readService = await readFile(new URL("../../api-next/src/learning-read/service.ts", import.meta.url), "utf8");
  assert.doesNotMatch(readService, /temporal_attempt/);
  assert.match(readService, /order by candidate\.started_at desc,candidate\.agent_attempt_id desc/);
});

test("0042 prevents foreground outbox rows from entering the Temporal relay", async () => {
  const migration = await readFile(new URL("../../../../db/migrations/0042_science_v3_interactive_epoch.sql", import.meta.url), "utf8");
  const relaySection = migration.slice(migration.indexOf("drop index if exists infra_outbox_science_v3_pending_idx"));
  assert.doesNotMatch(relaySection, /event_type in \([\s\S]*'foreground\.message_submitted'/);
  assert.match(relaySection, /mathpilot_science_v3_mark_workflow_started/);
  assert.match(relaySection, /mathpilot_science_v3_mark_workflow_start_failed/);
});

test("relay defers a stale foreground row without starting Temporal", async () => {
  const foreground: OutboxWorkflowStart = {
    schemaVersion: 3,
    eventId: "evt_foreground0001",
    tenantId: "tnt_test00001",
    operationId: "op_foreground0001",
    eventType: "foreground.message_submitted",
    aggregateRef: "conversation-thread:thr_foreground01",
    aggregateVersion: 2,
    payloadRef: "agent-artifact:art_foreground01",
    occurredAt: "2026-08-31T08:00:00.000Z",
  };
  let started = 0;
  const store: OutboxRelayStore = {
    async pending() { return [foreground]; },
    async markStarted() { started += 1; },
    async markFailed() { throw new Error("foreground rows must not be marked as Temporal failures"); },
    async close() {},
  };
  const relay = new OutboxRelay({} as never, store, { taskQueue: "learning-next-test" });
  assert.deepEqual(await relay.pollOnce(), { selected: 1, started: 0, duplicates: 0, deferred: 1, failed: 0 });
  assert.equal(started, 0);
});

test("learning actions serialize the exact tool-call retry key before side effects", async () => {
  const store = await readFile(new URL("../src/foreground-store.ts", import.meta.url), "utf8");
  assert.match(store, /pg_advisory_xact_lock\(hashtextextended\(\$1 \|\| E'\\\\0' \|\| \$2/);
});
