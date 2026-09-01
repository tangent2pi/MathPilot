import {
  Client,
  ScheduleOverlapPolicy,
  type ScheduleOptionsStartWorkflowAction,
  type ScheduleUpdateOptions,
} from "@temporalio/client";
import { reconcileTemporalSchedule } from "@mathpilot/internal-service/temporal";
import type { ScheduledDreamTickInput } from "./runtime-types.ts";

type ScheduledDreamWorkflow = (input: ScheduledDreamTickInput) => Promise<void>;

const tenantPattern = /^tnt_[A-Za-z0-9]{8,}$/;

const scheduleDefinition = (
  scheduleId: string,
  tenantId: string,
  phase: "rem" | "deep",
  taskQueue: string,
): ScheduleUpdateOptions<ScheduleOptionsStartWorkflowAction<ScheduledDreamWorkflow>> => ({
  spec: {
    calendars: phase === "rem"
      ? [{ hour: 3, minute: 0 }]
      : [{ dayOfWeek: "SUNDAY", hour: 4, minute: 0 }],
    timezone: "Asia/Shanghai",
  },
  action: {
    type: "startWorkflow",
    workflowType: "scheduledDreamTickWorkflow",
    args: [{ tenantId, phase }],
    taskQueue,
    workflowId: `${scheduleId}:tick`,
    workflowExecutionTimeout: "30m",
  },
  policies: {
    overlap: phase === "rem" ? ScheduleOverlapPolicy.SKIP : ScheduleOverlapPolicy.BUFFER_ONE,
    catchupWindow: "1h",
    pauseOnFailure: false,
  },
  state: {},
});

export async function ensureDreamSchedules(client: Client, tenantIds: readonly string[], taskQueue: string): Promise<void> {
  for (const tenantId of tenantIds) {
    if (!tenantPattern.test(tenantId)) throw new Error(`invalid Dream schedule tenant ${tenantId}`);
    for (const phase of ["rem", "deep"] as const) {
      const scheduleId = `mathpilot:${tenantId}:dream:${phase}`;
      const definition = scheduleDefinition(scheduleId, tenantId, phase, taskQueue);
      await reconcileTemporalSchedule(client.schedule, scheduleId, definition);
    }
  }
}
