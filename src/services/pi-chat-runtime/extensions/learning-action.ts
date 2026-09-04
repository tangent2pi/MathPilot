import {
  LEARNING_ACTION_TOOL_PARAMETERS,
  parseBoundedLearningAction,
} from "@mathpilot/contracts";
import { configuredInternalService } from "@mathpilot/internal-service";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readHostPrincipal } from "./lib/host-principal.ts";
import {
  readActiveInteractiveReceipt,
  recordAcceptedTeachingArtifact,
} from "./lib/interactive-turn-state.ts";

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;

const responseBody = async (response: Response): Promise<JsonObject> => {
  const value = await response.json().catch(() => undefined);
  const result = object(value);
  if (!response.ok || !result || typeof result.accepted !== "boolean" || typeof result.action !== "string") {
    throw new Error(`learning action was not accepted by the host (${response.status})`);
  }
  return result;
};

/** Identity and attempt bindings are read only from the sibling 0700 host
 * state. The model-visible tool schema contains the bounded action itself and
 * cannot supply tenant/user/attempt/operation fields. */
export default function learningActionExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "learning_action",
    label: "Learning action",
    description: "Submit one bounded MathPilot learning-domain action. Identity and the active attempt are injected by the host.",
    promptSnippet: "Submit a bounded learning action through the canonical host",
    promptGuidelines: [
      "Use present_validated_artifact only for a complete, student-visible math derivation that is supported by the current frozen input.",
      "Do not include tenant, user, thread, attempt, operation, event, or tool-call identity fields; the host supplies them.",
    ],
    parameters: LEARNING_ACTION_TOOL_PARAMETERS,
    executionMode: "sequential",
    async execute(toolCallId, params, signal, _onUpdate, context) {
      const action = parseBoundedLearningAction(params);
      const [principal, receipt] = await Promise.all([
        readHostPrincipal(context.cwd),
        readActiveInteractiveReceipt(context.cwd),
      ]);
      const response = await configuredInternalService("pi-chat-runtime").request(
        "pi-to-learning",
        principal,
        `/internal/interactive/attempts/${encodeURIComponent(receipt.agent_attempt_id)}/actions/${encodeURIComponent(toolCallId)}`,
        {
          method: "POST",
          json: {
            operation_id: receipt.operation_id,
            foreground_request_id: receipt.foreground_request_id,
            conversation_thread_id: receipt.conversation_thread_id,
            foreground_epoch_id: receipt.foreground_epoch_id,
            triggering_message_id: receipt.triggering_message_id,
            input_ref: receipt.input_ref,
            driver_execution_id: receipt.driver_execution_id,
            action,
          },
          ...(signal ? { signal } : {}),
          timeoutMs: 2 * 60_000,
        },
      );
      const result = await responseBody(response);
      if (action.action === "present_validated_artifact" && result.accepted === true) {
        if (typeof result.result_ref !== "string" || !result.result_ref || result.result_ref.length > 1024) {
          throw new Error("accepted teaching artifact is missing its canonical reference");
        }
        await recordAcceptedTeachingArtifact(context.cwd, receipt.agent_attempt_id, {
          tool_call_id: toolCallId,
          artifact_ref: result.result_ref,
          artifact_schema: action.artifact_schema,
          summary: action.summary,
        });
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });
}

