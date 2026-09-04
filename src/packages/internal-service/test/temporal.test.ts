import assert from "node:assert/strict";
import test from "node:test";
import {
  ScheduleAlreadyRunning,
  ScheduleOverlapPolicy,
  type Client,
  type ScheduleUpdateOptions,
} from "@temporalio/client";
import { reconcileTemporalSchedule } from "../src/temporal.ts";

const definition: ScheduleUpdateOptions = {
  spec: { intervals: [{ every: "1m" }] },
  action: {
    type: "startWorkflow",
    workflowType: "testWorkflow",
    args: [],
    taskQueue: "test-queue",
  },
  policies: { overlap: ScheduleOverlapPolicy.SKIP },
  state: {},
};

test("a shared Temporal reconciler creates a missing schedule", async () => {
  const created: unknown[] = [];
  const schedules = {
    async create(value: unknown) { created.push(value); },
    getHandle() { throw new Error("unexpected update"); },
  } as unknown as Client["schedule"];
  await reconcileTemporalSchedule(schedules, "schedule-id", definition);
  assert.deepEqual(created, [{ scheduleId: "schedule-id", ...definition }]);
});

test("a shared Temporal reconciler updates definitions without clearing an operator pause", async () => {
  let updated: ScheduleUpdateOptions | undefined;
  const schedules = {
    async create() { throw new ScheduleAlreadyRunning("already exists", "schedule-id"); },
    getHandle() {
      return {
        async update(updater: (previous: unknown) => ScheduleUpdateOptions) {
          updated = updater({ state: { paused: true, note: "maintenance", remainingActions: 7 } });
        },
      };
    },
  } as unknown as Client["schedule"];
  await reconcileTemporalSchedule(schedules, "schedule-id", definition);
  assert.deepEqual(updated?.state, { paused: true, note: "maintenance", remainingActions: 7 });
});
