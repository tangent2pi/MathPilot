import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { bundleWorkflowCode } from "@temporalio/worker";
import {
  DEFAULT_STORAGE_TEMPORAL_TASK_QUEUE,
  STORAGE_GARBAGE_COLLECTION_SCHEDULE_ID,
  createStorageGarbageCollectionActivities,
  startStorageGarbageCollectionRuntime,
  storageGarbageCollectionScheduleDefinition,
  type StorageTemporalRuntimeDependencies,
} from "../src/storage-temporal.ts";
import * as storageWorkflows from "../src/storage-workflows.ts";

test("the production Temporal activity reaches the object lifecycle owner", async () => {
  const signal = new AbortController().signal;
  const received: AbortSignal[] = [];
  const activities = createStorageGarbageCollectionActivities({
    async sweepOnce(value) { received.push(value); },
  }, () => signal);
  await activities.sweepStorageGarbage();
  assert.deepEqual(received, [signal]);
});

test("the object collector is installed as a durable non-overlapping schedule", () => {
  const definition = storageGarbageCollectionScheduleDefinition(DEFAULT_STORAGE_TEMPORAL_TASK_QUEUE);
  assert.deepEqual(definition.spec, { intervals: [{ every: "1m" }] });
  assert.equal(definition.action.type, "startWorkflow");
  assert.equal(definition.action.workflowType, "storageGarbageCollectionWorkflow");
  assert.equal(definition.action.taskQueue, DEFAULT_STORAGE_TEMPORAL_TASK_QUEUE);
  assert.equal(definition.action.workflowId, `${STORAGE_GARBAGE_COLLECTION_SCHEDULE_ID}:sweep`);
  assert.equal(definition.policies?.overlap, "SKIP");
});

test("the production workflow bundle exports the workflow scheduled by Storage", async () => {
  const definition = storageGarbageCollectionScheduleDefinition(DEFAULT_STORAGE_TEMPORAL_TASK_QUEUE);
  assert.equal(definition.action.type, "startWorkflow");
  const workflowType = definition.action.workflowType;
  assert.equal(typeof storageWorkflows[workflowType as keyof typeof storageWorkflows], "function");

  const bundle = await bundleWorkflowCode({
    workflowsPath: fileURLToPath(new URL("../src/storage-workflows.ts", import.meta.url)),
  });
  assert.ok(bundle.code.length > 0);
});

test("schedule startup failure drains the running worker before closing its connection", async () => {
  const events: string[] = [];
  let finishWorker!: () => void;
  const workerCompletion = new Promise<void>((resolve) => { finishWorker = resolve; });
  const worker = {
    run: () => workerCompletion,
    shutdown() {
      events.push("worker.shutdown");
      queueMicrotask(() => {
        events.push("worker.settled");
        finishWorker();
      });
    },
  };
  const connection = {
    async close() { events.push("connection.close"); },
  };
  const dependencies = {
    async connect() { return connection; },
    async createWorker() { return worker; },
    createClient() { return {}; },
    async ensureSchedule() {
      events.push("schedule.failed");
      throw new Error("schedule unavailable");
    },
  } as unknown as StorageTemporalRuntimeDependencies;

  await assert.rejects(
    startStorageGarbageCollectionRuntime({
      address: "temporal.invalid:7233",
      namespace: "default",
      taskQueue: DEFAULT_STORAGE_TEMPORAL_TASK_QUEUE,
      collector: { async sweepOnce() {} },
      logger: { info() {}, error() { events.push("logger.error"); } },
    }, dependencies),
    /schedule unavailable/,
  );
  assert.deepEqual(events, [
    "schedule.failed",
    "worker.shutdown",
    "worker.settled",
    "connection.close",
    "logger.error",
  ]);
});
