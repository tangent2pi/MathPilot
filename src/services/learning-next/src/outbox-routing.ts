import { directTaskTypeForEvent } from "./task-registry.ts";
import type {
  AgentTaskWorkflowInput,
  FinalizeQuestionWorkflowInput,
  OutboxWorkflowStart,
  ScientificReplayWorkflowInput,
  TaskType,
} from "./runtime-types.ts";

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

export interface FinalizeQuestionWorkflowRoute {
  workflowType: "finalizeQuestionWorkflow";
  taskType?: undefined;
}

export interface ScientificReplayWorkflowRoute {
  workflowType: "replayScientificStateWorkflow";
  taskType?: undefined;
}

export function directWorkflowRoute(eventType: string): DirectWorkflowRoute | FinalizeQuestionWorkflowRoute | ScientificReplayWorkflowRoute | undefined {
  if (eventType === "question.cut_requested") return { workflowType: "finalizeQuestionWorkflow" };
  if (eventType === "teacher.correction_recorded") return { workflowType: "replayScientificStateWorkflow" };
  const taskType = directTaskTypeForEvent(eventType);
  if (!(taskType in DIRECT_WORKFLOW_TYPES)) throw new Error(`task ${taskType} has no direct outbox Workflow`);
  return {
    taskType: taskType as keyof typeof DIRECT_WORKFLOW_TYPES,
    workflowType: DIRECT_WORKFLOW_TYPES[taskType as keyof typeof DIRECT_WORKFLOW_TYPES],
  };
}

export function workflowInputFromOutbox(event: OutboxWorkflowStart, taskType: TaskType): AgentTaskWorkflowInput {
  if (event.eventType === "foreground.message_submitted") {
    throw new Error("foreground.message_submitted is Interactive Epoch only and cannot enter Temporal");
  }
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
    ...(["question.closed","dream.rem_requested","dream.deep_requested"].includes(event.eventType)
      ? { resultOwnership: "parent" as const } : {}),
  };
}

export function finalizeQuestionInputFromOutbox(event: OutboxWorkflowStart): FinalizeQuestionWorkflowInput {
  const match = /^question-session:(qsn_[A-Za-z0-9]{8,})$/.exec(event.aggregateRef);
  if (!match || event.eventType !== "question.cut_requested") throw new Error("invalid question cut outbox envelope");
  return {
    schemaVersion: 3,
    tenantId: event.tenantId,
    operationId: event.operationId,
    eventId: event.eventId,
    questionSessionId: match[1]!,
    aggregateVersion: event.aggregateVersion,
    inputRef: event.payloadRef,
  };
}

export function scientificReplayInputFromOutbox(event: OutboxWorkflowStart): ScientificReplayWorkflowInput {
  const student = /^student:(stu_[A-Za-z0-9]{8,})$/.exec(event.aggregateRef);
  const correction = /^teacher-correction:(tcor_[A-Za-z0-9]{8,})$/.exec(event.payloadRef);
  if (!student || !correction || event.eventType !== "teacher.correction_recorded") {
    throw new Error("invalid teacher correction outbox envelope");
  }
  return {
    schemaVersion: 3,
    tenantId: event.tenantId,
    operationId: event.operationId,
    eventId: event.eventId,
    studentId: student[1]!,
    teacherCorrectionId: correction[1]!,
    aggregateVersion: event.aggregateVersion,
    inputRef: event.payloadRef,
  };
}
