import type { InternalServiceRuntime } from "@mathpilot/internal-service";
import { internalServiceContext, internalServiceGuard, sendProblem, type ProblemInput } from "@mathpilot/internal-service/fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getTaskSpec } from "./task-registry.ts";
import {
  parseBoundedLearningAction,
  parseInteractiveAttemptBinding,
  parseInteractivePrepareResponse,
} from "@mathpilot/contracts";
import type { PostgresForegroundStore } from "./foreground-store.ts";
import type { RuntimeStore } from "./runtime-store.ts";
import type {
  InteractiveAttemptPrepareInput,
} from "./runtime-types.ts";

const id = (value: unknown, pattern: RegExp, label: string): string => {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
};
const text = (value: unknown, maximum: number, label: string): string => {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) throw new Error(`${label} is invalid`);
  return value;
};
const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
};
const exact = (value: Record<string, unknown>, keys: readonly string[], label: string): void => {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`${label} contains unsupported fields`);
};
const stringId = (value: unknown, prefix: string, label: string): string =>
  id(value, new RegExp(`^${prefix}_[A-Za-z0-9]{8,}$`), label);
type Receipt = Omit<InteractiveAttemptPrepareInput, "tenantId" | "actorUserId" | "agentAttemptId">;

const bindingKeys = [
  "operation_id", "foreground_request_id", "conversation_thread_id", "foreground_epoch_id",
  "triggering_message_id", "input_ref", "driver_execution_id",
] as const;

const receipt = (raw: Record<string, unknown>): Receipt => {
  const value = parseInteractiveAttemptBinding({
    operation_id: raw.operation_id,
    foreground_request_id: raw.foreground_request_id,
    conversation_thread_id: raw.conversation_thread_id,
    foreground_epoch_id: raw.foreground_epoch_id,
    triggering_message_id: raw.triggering_message_id,
    input_ref: raw.input_ref,
    driver_execution_id: raw.driver_execution_id,
  });
  return {
    operationId: value.operation_id,
    foregroundRequestId: value.foreground_request_id,
    conversationThreadId: value.conversation_thread_id,
    foregroundEpochId: value.foreground_epoch_id,
    triggeringMessageId: value.triggering_message_id,
    inputRef: value.input_ref,
    driverExecutionId: value.driver_execution_id,
  };
};

const pathParams = (request: FastifyRequest): { agentAttemptId: string } => ({
  agentAttemptId: stringId((request.params as { agentAttemptId?: unknown }).agentAttemptId, "agt", "agent_attempt_id"),
});

const reject = (reply: FastifyReply, error: unknown, code = "invalid_interactive_request"): FastifyReply => {
  const mapped = interactiveEpochProblem(error);
  if (mapped) return sendProblem(reply, mapped);
  if (error instanceof Error && error.message.includes("invalid")) {
    return sendProblem(reply, { status: 422, code, title: error.message });
  }
  throw error;
};

const bundleHasReceipt = (bundle: unknown, value: Receipt): void => {
  const raw = object(bundle, "frozen input bundle");
  const context = raw.context && typeof raw.context === "object" && !Array.isArray(raw.context)
    ? raw.context as Record<string, unknown> : {};
  const pick = (key: string): unknown => raw[key] ?? context[key];
  if (pick("conversation_thread_id") !== value.conversationThreadId
    || pick("foreground_epoch_id") !== value.foregroundEpochId
    || pick("triggering_message_id") !== value.triggeringMessageId) {
    throw new Error("frozen input identity does not match the receipt");
  }
};

export function interactiveEpochProblem(error: unknown): ProblemInput | undefined {
  const message = error instanceof Error ? error.message : "";
  if (!message) return undefined;
  if (message.includes("authorization") || message.includes("owner")) {
    return { status: 403, code: "interactive_authorization_denied", title: "Interactive request is not authorized" };
  }
  if (message.includes("conflict") || message.includes("already") || message.includes("no longer")
    || message.includes("terminal") || message.includes("writable") || message.includes("does not match")
    || message.includes("does not exist") || message.includes("expired")) {
    return { status: 409, code: "interactive_state_conflict", title: "Interactive request conflicts with the current state" };
  }
  if (message.includes("invalid") || message.includes("must") || message.includes("schema")
    || message.includes("identity")) {
    return { status: 422, code: "invalid_interactive_request", title: "Interactive request is invalid" };
  }
  const pgError = error as { code?: string };
  if (pgError.code === "23505" || pgError.code === "23514") {
    return { status: 409, code: "interactive_state_conflict", title: "Interactive request conflicts with the current state" };
  }
  return undefined;
}

export function registerInteractiveEpochRoutes(
  app: FastifyInstance,
  foregroundStore: PostgresForegroundStore,
  runtimeStore: RuntimeStore,
  internalService: InternalServiceRuntime,
): void {
  const fromPi = internalServiceGuard(internalService, ["pi-to-learning"]);

  app.post("/internal/interactive/attempts/:agentAttemptId/prepare", { preHandler: fromPi }, async (request, reply) => {
    try {
      const raw = object(request.body, "prepare body");
      exact(raw, bindingKeys, "prepare body");
      const binding = receipt(raw);
      const actor = internalServiceContext(request).actor;
      const prepared = await foregroundStore.prepareInteractiveEpoch({
        ...binding,
        ...pathParams(request),
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
      });
      const taskSpec = getTaskSpec("foreground_teaching", "v1");
      const preparedContext = await runtimeStore.loadInteractiveContext({
        tenantId: actor.tenantId,
        operationId: prepared.operationId,
        inputRef: prepared.inputRef,
        conversationThreadId: prepared.conversationThreadId,
        foregroundEpochId: prepared.foregroundEpochId,
        triggeringMessageId: prepared.triggeringMessageId,
      }, taskSpec);
      const inputBundle = preparedContext.inputBundle;
      bundleHasReceipt(inputBundle, binding);
      const workspaceProjection = preparedContext.workspaceProjection;
      if (prepared.attemptStatus === "started") {
        await runtimeStore.recordWorkspaceProjection(prepared.agentAttemptId, actor.tenantId, workspaceProjection);
      }
      return reply.code(200).send(parseInteractivePrepareResponse({
        schema: "mathpilot.interactive-prepare/v1",
        frozen_input: inputBundle,
        workspace_projection: workspaceProjection,
      }));
    } catch (error) {
      return reject(reply, error);
    }
  });

  app.post("/internal/interactive/attempts/:agentAttemptId/actions/:toolCallId", { preHandler: fromPi }, async (request, reply) => {
    try {
      const raw = object(request.body, "action body");
      exact(raw, [...bindingKeys, "action"], "action body");
      const binding = receipt(raw);
      const actor = internalServiceContext(request).actor;
      const action = parseBoundedLearningAction(raw.action);
      const params = pathParams(request);
      const toolCallId = text((request.params as { toolCallId?: unknown }).toolCallId, 255, "tool_call_id");
      const result = await foregroundStore.executeAction({
        ...binding,
        ...params,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        toolCallId,
        action,
      });
      return reply.code(200).send({ agent_attempt_id: params.agentAttemptId, ...result });
    } catch (error) {
      return reject(reply, error);
    }
  });

  app.post("/internal/interactive/attempts/:agentAttemptId/complete", { preHandler: fromPi }, async (request, reply) => {
    try {
      const raw = object(request.body, "complete body");
      exact(raw, [...bindingKeys, "event_id", "output", "resolved_model_id",
        "input_tokens", "output_tokens"], "complete body");
      const binding = receipt(raw);
      const actor = internalServiceContext(request).actor;
      const eventId = stringId(raw.event_id, "evt", "event_id");
      const resolvedModelId = text(raw.resolved_model_id, 255, "resolved_model_id");
      const inputTokens = raw.input_tokens;
      const outputTokens = raw.output_tokens;
      if (!Number.isSafeInteger(inputTokens) || (inputTokens as number) < 0
        || !Number.isSafeInteger(outputTokens) || (outputTokens as number) < 0) throw new Error("token counts are invalid");
      const result = await foregroundStore.completeInteractiveEpoch({
        ...binding,
        ...pathParams(request),
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        eventId,
        output: raw.output,
        resolvedModelId,
        inputTokens: inputTokens as number,
        outputTokens: outputTokens as number,
      });
      return reply.code(result.created ? 201 : 200).send({
        agent_attempt_id: (request.params as { agentAttemptId: string }).agentAttemptId,
        status: "succeeded",
        output_ref: result.outputRef,
        response_message_id: result.responseMessageId,
        thread_version: result.threadVersion,
        created: result.created,
      });
    } catch (error) {
      return reject(reply, error);
    }
  });

  app.post("/internal/interactive/attempts/:agentAttemptId/terminal", { preHandler: fromPi }, async (request, reply) => {
    try {
      const raw = object(request.body, "terminal body");
      exact(raw, [...bindingKeys, "status", "error_code", "error_detail"], "terminal body");
      const binding = receipt(raw);
      const actor = internalServiceContext(request).actor;
      if (raw.status !== "failed" && raw.status !== "cancelled") throw new Error("terminal status is invalid");
      if (typeof raw.error_detail !== "string" || raw.error_detail.length > 2_000) throw new Error("error_detail is invalid");
      const result = await foregroundStore.terminateInteractiveEpoch({
        ...binding,
        ...pathParams(request),
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        status: raw.status,
        errorCode: text(raw.error_code, 160, "error_code"),
        errorDetail: raw.error_detail,
      });
      return reply.code(200).send({
        agent_attempt_id: (request.params as { agentAttemptId: string }).agentAttemptId,
        status: result.status,
        request_status: result.requestStatus,
      });
    } catch (error) {
      return reject(reply, error);
    }
  });
}
