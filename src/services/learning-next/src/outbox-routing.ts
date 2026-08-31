import { directTaskTypeForEvent } from "./task-registry.ts";
import type { AgentTaskWorkflowInput, OutboxWorkflowStart, TaskType } from "./runtime-types.ts";

export const DIRECT_WORKFLOW_TYPES = {
  select_question: "selectQuestionWorkflow",
  light: "lightWorkflow",
  rem: "remSweepWorkflow",
  deep: "deepConsolidationWorkflow",
} as const;

export interface DirectWorkflowRoute {
  workflowType: (typeof DIRECT_WORKFLOW_TYPES)[keyof typeof DIRECT_WORKFLOW_TYPES];
  taskType: keyof typeof DIRECT_WORKFLOW_TYPES;
}

export function directWorkflowRoute(eventType: string): DirectWorkflowRoute | undefined {
  if (eventType === "question.cut_requested" || eventType === "teacher.correction_recorded") return undefined;
  const taskType = directTaskTypeForEvent(eventType);
  if (!(taskType in DIRECT_WORKFLOW_TYPES)) throw new Error(`task ${taskType} has no direct outbox Workflow`);
  return {
    taskType: taskType as keyof typeof DIRECT_WORKFLOW_TYPES,
    workflowType: DIRECT_WORKFLOW_TYPES[taskType as keyof typeof DIRECT_WORKFLOW_TYPES],
  };
}

export function workflowInputFromOutbox(event: OutboxWorkflowStart, taskType: TaskType): AgentTaskWorkflowInput {
  return {
    schemaVersion: 3,
    tenantId: event.tenantId,
    operationId: event.operationId,
    eventId: event.eventId,
    aggregateRef: event.aggregateRef,
    aggregateVersion: event.aggregateVersion,
    taskType,
    taskSpecVersion: "v1",
    inputRef: event.payloadRef,
    idempotencyKey: event.eventId,
    revision: event.aggregateVersion,
  };
}
