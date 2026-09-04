import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "@mathpilot/content-integrity/node";
import { MAX_CANONICAL_MIRROR_TRANSCRIPT_MESSAGES } from "@mathpilot/contracts";
import type { InternalActor, InternalServiceRuntime } from "@mathpilot/internal-service";
import { internalServiceContext, internalServiceGuard, sendProblem } from "@mathpilot/internal-service/fastify";
import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  PiAgentMessage,
  PiClient,
  PiClientEvent,
  PiHostUiResponse,
  PiSendMessageInput,
  PiThreadMetadata,
  PiThreadSnapshot,
} from "@assistant-ui/react-pi";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { clearHostPrincipal, hostStateDirectory, writeHostPrincipal } from "../extensions/lib/host-principal.ts";
import { readAcceptedTeachingArtifacts } from "../extensions/lib/interactive-turn-state.ts";
import {
  PiInteractiveLearningBridge,
  type InteractivePublicPart,
} from "./pi-interactive-bridge.ts";
import {
  parseInteractiveAdmissionReceipt,
  type InteractiveAdmissionReceipt,
} from "../extensions/lib/interactive-receipt.ts";
import { localThreadAvailable, reconcileLegacyPiThreadSession, workspaceOf } from "./pi-chat-routes.ts";
import type { PiChatRuntime } from "./pi-chat-server.ts";
import type { CanonicalSessionAppender } from "./pi-canonical-sync.ts";
import {
  appendCanonicalLink,
  appendCanonicalVisible,
  parseCanonicalSyncMessage,
  type CanonicalSyncMessage,
} from "./pi-canonical-sync.ts";
import { assemblePiChatWorkspace, bindPiThreadWorkspace } from "./pi-chat-workspace.ts";
import { ensurePiSessionFile } from "./pi-session-files.ts";
import type { PiExecutionLease, PiPrincipal, PiThreadRecord, PiThreadStore } from "./pi-thread-store.ts";

const THREAD_ID = /^thr_[A-Za-z0-9]{8,}$/;
const DRIVER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const MAX_PROMPT_BYTES = 200_000;
const MARKER_SCHEMA = "mathpilot.pi-interactive-turn/v1" as const;

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
const exactKeys = (value: JsonObject, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const reject = (reply: FastifyReply, status: number, code: string, title: string) =>
  sendProblem(reply, { status, code, title });

const principalOf = (actor: InternalActor): PiPrincipal => ({
  tenantId: actor.tenantId,
  userId: actor.userId,
  roles: [...actor.roles],
});

const threadIdOf = (value: unknown): string | undefined =>
  typeof value === "string" && THREAD_ID.test(value) ? value : undefined;

const publicMetadata = (metadata: PiThreadMetadata): PiThreadMetadata => {
  const { workspacePath: _workspacePath, sessionFile: _sessionFile, parentSessionPath: _parent, ...safe } = metadata;
  return {
    ...safe,
    config: {
      ...(safe.config ?? {}),
      thinkingLevel: "high",
    },
  };
};

const publicSnapshot = (snapshot: PiThreadSnapshot): PiThreadSnapshot => ({
  ...snapshot,
  metadata: publicMetadata(snapshot.metadata),
});

const publicEvent = (event: PiClientEvent): PiClientEvent => event.type === "snapshot"
  ? { ...event, snapshot: publicSnapshot(event.snapshot) }
  : event;

export const parseSendInput = (value: unknown, canonicalHasAttachment = false): PiSendMessageInput => {
  const input = object(value);
  if (!input || !exactKeys(input, [
    "content",
    ...(Object.hasOwn(input, "streamingBehavior") ? ["streamingBehavior"] : []),
  ]) || typeof input.content !== "string" || (!input.content.trim() && !canonicalHasAttachment)
    || Buffer.byteLength(input.content, "utf8") > MAX_PROMPT_BYTES
    || (input.streamingBehavior !== undefined && input.streamingBehavior !== "followUp" && input.streamingBehavior !== "steer")) {
    throw new Error("Pi message input is invalid");
  }
  return input as PiSendMessageInput;
};

type TurnMarkerStatus = "prepared" | "sending" | "sent" | "completion_pending" | "completed" | "failed" | "cancelled";
export const isDurableDispatchAcknowledgement = (status: TurnMarkerStatus): boolean =>
  ["sending", "sent", "completion_pending", "completed", "failed", "cancelled"].includes(status);
type PendingCallback =
  | {
      kind: "complete";
      output: JsonObject;
      resolved_model_id: string;
      input_tokens: number;
      output_tokens: number;
    }
  | {
      kind: "terminal";
      status: "failed" | "cancelled";
      error_code: string;
      error_detail: string;
    };
type TurnMarker = {
  schema: typeof MARKER_SCHEMA;
  status: TurnMarkerStatus;
  actor: InternalActor;
  receipt: InteractiveAdmissionReceipt;
  input: PiSendMessageInput;
  canonical_message: CanonicalSyncMessage;
  canonical_title: string;
  input_sha256: string;
  baseline_message_count: number;
  input_observed: boolean;
  updated_at: string;
  pending_callback?: PendingCallback;
};

const markerDirectory = (workspace: string): string => path.join(hostStateDirectory(workspace), "interactive-turns");
const markerPath = (workspace: string, driverId: string): string => {
  if (!DRIVER_ID.test(driverId)) throw new Error("interactive driver id is invalid");
  return path.join(markerDirectory(workspace), `${driverId}.json`);
};

export const clearTerminalTurnState = async (workspace: string, driverId: string): Promise<void> => {
  // Clear the ambient actor capability first. If deletion of the pending
  // marker is interrupted, recovery can still replay its signed callback from
  // the marker itself without leaving a model-readable principal behind.
  await clearHostPrincipal(workspace);
  await rm(markerPath(workspace, driverId), { force: true });
};

const parseMarker = (value: unknown): TurnMarker => {
  const raw = object(value);
  if (!raw || raw.schema !== MARKER_SCHEMA
    || !new Set<TurnMarkerStatus>(["prepared", "sending", "sent", "completion_pending", "completed", "failed", "cancelled"]).has(raw.status as TurnMarkerStatus)
    || !object(raw.actor) || typeof raw.input_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.input_sha256)
    || !Number.isSafeInteger(raw.baseline_message_count) || Number(raw.baseline_message_count) < 0
    || typeof raw.input_observed !== "boolean"
    || typeof raw.updated_at !== "string") throw new Error("interactive turn marker is invalid");
  const actor = raw.actor as JsonObject;
  if (typeof actor.tenantId !== "string" || typeof actor.userId !== "string" || !Array.isArray(actor.roles)) {
    throw new Error("interactive turn marker actor is invalid");
  }
  const pending = object(raw.pending_callback);
  let pendingCallback: PendingCallback | undefined;
  if (pending) {
    if (pending.kind === "complete" && object(pending.output)
      && typeof pending.resolved_model_id === "string"
      && Number.isSafeInteger(pending.input_tokens) && Number(pending.input_tokens) >= 0
      && Number.isSafeInteger(pending.output_tokens) && Number(pending.output_tokens) >= 0) {
      pendingCallback = {
        kind: "complete", output: pending.output as JsonObject,
        resolved_model_id: pending.resolved_model_id,
        input_tokens: Number(pending.input_tokens), output_tokens: Number(pending.output_tokens),
      };
    } else if (pending.kind === "terminal"
      && (pending.status === "failed" || pending.status === "cancelled")
      && typeof pending.error_code === "string" && typeof pending.error_detail === "string") {
      pendingCallback = {
        kind: "terminal", status: pending.status,
        error_code: pending.error_code, error_detail: pending.error_detail,
      };
    } else throw new Error("interactive pending callback is invalid");
  }
  if (raw.status === "completion_pending" && !pendingCallback) throw new Error("interactive pending callback is missing");
  const canonicalMessage = parseCanonicalSyncMessage(raw.canonical_message);
  return {
    schema: MARKER_SCHEMA,
    status: raw.status as TurnMarkerStatus,
    actor: { tenantId: actor.tenantId, userId: actor.userId, roles: actor.roles as InternalActor["roles"] },
    receipt: parseInteractiveAdmissionReceipt(raw.receipt),
    input: parseSendInput(raw.input, canonicalMessage.parts.some((part) => part.type === "attachment")),
    canonical_message: canonicalMessage,
    canonical_title: typeof raw.canonical_title === "string" && raw.canonical_title.trim() && raw.canonical_title.length <= 120
      ? raw.canonical_title.trim() : (() => { throw new Error("interactive canonical title is invalid"); })(),
    input_sha256: raw.input_sha256,
    baseline_message_count: Number(raw.baseline_message_count),
    input_observed: raw.input_observed,
    updated_at: raw.updated_at,
    ...(pendingCallback ? { pending_callback: pendingCallback } : {}),
  };
};

const readMarker = async (workspace: string, driverId: string): Promise<TurnMarker | undefined> => {
  try { return parseMarker(JSON.parse(await readFile(markerPath(workspace, driverId), "utf8")) as unknown); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const writeMarker = async (workspace: string, marker: TurnMarker): Promise<void> => {
  const directory = markerDirectory(workspace);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = markerPath(workspace, marker.receipt.driver_execution_id);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await rename(temporary, destination);
  await chmod(destination, 0o600);
};

const activeMarker = async (workspace: string): Promise<TurnMarker | undefined> => {
  const directory = markerDirectory(workspace);
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const marker = parseMarker(JSON.parse(await readFile(path.join(directory, entry.name), "utf8")) as unknown);
    if (["prepared", "sending", "sent", "completion_pending"].includes(marker.status)) return marker;
  }
  return undefined;
};

const inputDigest = (input: PiSendMessageInput, canonicalMessage: CanonicalSyncMessage, canonicalTitle: string): string =>
  createHash("sha256").update(canonicalJson({
    input, canonical_message: canonicalMessage, canonical_title: canonicalTitle,
  }).json, "utf8").digest("hex");

const userContent = (message: PiAgentMessage | undefined): string | undefined => {
  if (!message) return undefined;
  if (message.role !== "user") return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content.flatMap((part) => {
    const value = object(part);
    return value?.type === "text" && typeof value.text === "string" ? [value.text] : [];
  }).join("");
};

export const nativeInputPresent = (
  snapshot: PiThreadSnapshot,
  baseline: number,
  input: PiSendMessageInput,
): boolean => userContent(snapshot.messages[baseline]) === input.content;

export const canonicalUserLinkEligible = (
  snapshot: PiThreadSnapshot,
  inputObserved: boolean,
  baseline: number,
  input: PiSendMessageInput,
): boolean => inputObserved && nativeInputPresent(snapshot, baseline, input);

const snapshotContainsInput = (snapshot: PiThreadSnapshot, marker: TurnMarker): boolean =>
  canonicalUserLinkEligible(snapshot, marker.input_observed, marker.baseline_message_count, marker.input);

export const publicTextParts = (snapshot: PiThreadSnapshot, baseline: number, maximum = 16): InteractivePublicPart[] => {
  const parts: InteractivePublicPart[] = [];
  for (const message of snapshot.messages.slice(baseline)) {
    if (message.role !== "assistant") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const candidate of content) {
      const block = object(candidate);
      if (block?.type !== "text" || typeof block.text !== "string" || !block.text.trim()) continue;
      for (let offset = 0; offset < block.text.length; offset += 50_000) {
        parts.push({ type: "text", text: block.text.slice(offset, offset + 50_000) });
        if (parts.length === maximum) return parts;
      }
    }
  }
  return parts;
};

const lastAssistant = (snapshot: PiThreadSnapshot, baseline: number): JsonObject | undefined =>
  [...snapshot.messages.slice(baseline)].reverse().find((message) => message.role === "assistant") as JsonObject | undefined;

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

type ActiveTurn = {
  unsubscribe: () => void;
  lease: PiExecutionLease;
  marker: TurnMarker;
  armed: boolean;
  ended: boolean;
  finishing: boolean;
};

const ensureHighThinking = async (pi: PiClient, threadId: string): Promise<PiThreadSnapshot> => {
  let snapshot = await pi.getThread(threadId);
  if (snapshot.metadata.config?.thinkingLevel !== "high") {
    await pi.setThinkingLevel(threadId, "high");
    snapshot = await pi.getThread(threadId);
  }
  return snapshot;
};

const provisionLocks = new Map<string, Promise<PiThreadSnapshot>>();

const parseCanonicalMessages = (value: unknown): CanonicalSyncMessage[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CANONICAL_MIRROR_TRANSCRIPT_MESSAGES) {
    throw new Error("canonical transcript is invalid");
  }
  return value.map(parseCanonicalSyncMessage);
};

const managerAppender = (manager: SessionManager): CanonicalSessionAppender => ({
  manager,
  async appendCustomMessage(message) {
    manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
  },
});

const linkedCanonicalIds = (
  session: CanonicalSessionAppender,
  messages: readonly CanonicalSyncMessage[],
): Set<string> => {
  const linked = new Set<string>();
  for (const entry of session.manager.getEntries()) {
    if (entry.type !== "custom_message" || entry.customType !== "mathpilot.canonical-link/v1") continue;
    const details = object(entry.details);
    if (typeof details?.message_id === "string") linked.add(details.message_id);
  }
  for (const message of messages) {
    if (message.author_kind === "assistant" && message.reply_to_message_id
      && linked.has(message.reply_to_message_id)) linked.add(message.message_id);
  }
  return linked;
};

const syncCanonicalMessages = async (
  runtime: PiChatRuntime,
  record: PiThreadRecord,
  messages: readonly CanonicalSyncMessage[],
  initial = false,
): Promise<void> => {
  if (messages.length === 0) return;
  const session = runtime.canonicalSession(record.threadId, path.join(runtime.runtimeRoot, record.sessionFile));
  const linked = initial ? new Set<string>() : linkedCanonicalIds(session, messages);
  for (const message of messages) {
    if (linked.has(message.message_id)) await appendCanonicalLink(session, message);
    else await appendCanonicalVisible(session, message);
  }
};

const provisionThread = async (
  runtime: PiChatRuntime,
  store: PiThreadStore,
  principal: PiPrincipal,
  threadId: string,
  title?: string,
  messages: readonly CanonicalSyncMessage[] = [],
): Promise<PiThreadSnapshot> => {
  let existing = await store.accessible(principal, threadId);
  if (existing) {
    existing = await reconcileLegacyPiThreadSession(runtime, store, principal, existing);
    if (!await localThreadAvailable(runtime, existing, runtime.client)) throw new Error("Pi thread session is not recoverable");
    await syncCanonicalMessages(runtime, existing, messages);
    if (title) await runtime.client.renameThread(threadId, title);
    return ensureHighThinking(runtime.client, threadId);
  }
  const workspace = path.join(runtime.sessionsRoot, threadId);
  await assemblePiChatWorkspace(workspace, runtime.skillsRoot);
  await bindPiThreadWorkspace(workspace, threadId);
  const ensuredSession = await ensurePiSessionFile(workspace, threadId, async (manager) => {
    if (messages.length > 0) {
      const session = managerAppender(manager);
      for (const message of messages) await appendCanonicalVisible(session, message);
    }
  });
  const sessionFile = ensuredSession.sessionFile;
  const relativeSession = path.relative(runtime.runtimeRoot, sessionFile);
  if (relativeSession.startsWith("..") || path.isAbsolute(relativeSession)) throw new Error("Pi session file escaped the runtime root");
  await store.create(principal, {
    threadId,
    sessionDir: path.relative(runtime.runtimeRoot, workspace),
    sessionFile: relativeSession,
  });
  const created = await store.accessible(principal, threadId);
  if (!created) throw new Error("Pi canonical thread mapping was not persisted");
  if (!ensuredSession.created && messages.length > 0) {
    await syncCanonicalMessages(runtime, created, messages, true);
  }
  if (title) await runtime.client.renameThread(threadId, title);
  return ensureHighThinking(runtime.client, threadId);
};

export function registerPiHttpRoutes(
  app: FastifyInstance,
  runtime: PiChatRuntime,
  store: PiThreadStore,
  internalService: InternalServiceRuntime,
  learning = new PiInteractiveLearningBridge(internalService),
): void {
  const pi = runtime.client;
  const apiGuard = internalServiceGuard(internalService, ["api-to-pi"]);
  const activeTurns = new Map<string, ActiveTurn>();

  const readable = async (actor: InternalActor, threadId: string, reply: FastifyReply) => {
    const record = await store.accessible(principalOf(actor), threadId);
    if (!record) reject(reply, 404, "pi_thread_not_found", "Pi thread not found");
    return record;
  };
  const writable = async (actor: InternalActor, threadId: string, reply: FastifyReply) => {
    const record = await store.writable(principalOf(actor), threadId);
    if (!record) reject(reply, 404, "pi_thread_not_found", "Pi thread not found");
    return record;
  };

  const deliverCallback = async (marker: TurnMarker, callback: PendingCallback): Promise<void> => {
    if (callback.kind === "complete") {
      await learning.complete(marker.actor, marker.receipt, {
        output: callback.output,
        resolvedModelId: callback.resolved_model_id,
        inputTokens: callback.input_tokens,
        outputTokens: callback.output_tokens,
      });
      return;
    }
    await learning.terminal(marker.actor, marker.receipt, {
      status: callback.status,
      errorCode: callback.error_code,
      errorDetail: callback.error_detail,
    });
  };

  const clearTerminalSecrets = async (workspace: string, marker: TurnMarker): Promise<void> => {
    await clearTerminalTurnState(workspace, marker.receipt.driver_execution_id);
  };

  const persistAndDeliverCallback = async (
    workspace: string,
    marker: TurnMarker,
    callback: PendingCallback,
    beforeDeliver?: () => Promise<unknown>,
  ): Promise<void> => {
    const pending: TurnMarker = {
      ...marker, status: "completion_pending", pending_callback: callback, updated_at: new Date().toISOString(),
    };
    // Persist the exact retry payload before crossing the service boundary.
    await writeMarker(workspace, pending);
    // The model run is already terminal at this point. Recovery needs only the
    // actor and receipt sealed in the marker; do not leave an ambient principal
    // readable in the workspace while a callback is retried.
    await clearHostPrincipal(workspace);
    await beforeDeliver?.();
    await deliverCallback(pending, callback);
    // Canonical Learning state is the terminal authority. Once its idempotent
    // callback succeeds, erase the local actor/receipt capability instead of
    // retaining a second terminal record with reusable identity material.
    await clearTerminalSecrets(workspace, pending);
  };

  const callbackForSnapshot = async (
    snapshot: PiThreadSnapshot,
    marker: TurnMarker,
    workspace: string,
  ): Promise<PendingCallback> => {
    const assistant = lastAssistant(snapshot, marker.baseline_message_count);
    const stopReason = typeof assistant?.stopReason === "string" ? assistant.stopReason : undefined;
    if (stopReason === "aborted") return {
      kind: "terminal", status: "cancelled", error_code: "pi_run_aborted",
      error_detail: "The interactive Pi run was cancelled.",
    };
    if (stopReason === "error" || snapshot.lastError) return {
      kind: "terminal", status: "failed", error_code: "pi_run_failed",
      error_detail: snapshot.lastError ?? String(assistant?.errorMessage ?? "Pi run failed"),
    };
    if (stopReason !== "stop" && stopReason !== "length") return {
      kind: "terminal", status: "failed", error_code: "pi_run_incomplete",
      error_detail: "The interactive Pi run did not persist an unambiguous completed assistant response.",
    };
    const artifacts = await readAcceptedTeachingArtifacts(workspace, marker.receipt.agent_attempt_id);
    const textParts = publicTextParts(snapshot, marker.baseline_message_count, 16 - artifacts.length);
    if (textParts.length === 0) return {
      kind: "terminal", status: "failed", error_code: "pi_empty_public_output",
      error_detail: "The interactive Pi run produced no public teaching text.",
    };
    const parts: InteractivePublicPart[] = [
      ...textParts,
      ...artifacts.map((artifact) => ({
        type: "teaching_artifact" as const,
        artifact_ref: artifact.artifact_ref,
        artifact_schema: artifact.artifact_schema,
        summary: artifact.summary,
      })),
    ];
    const usage = object(assistant?.usage) ?? {};
    return {
      kind: "complete",
      output: {
        schema_version: 3,
        conversation_thread_id: marker.receipt.conversation_thread_id,
        foreground_epoch_id: marker.receipt.foreground_epoch_id,
        reply_to_message_id: marker.receipt.triggering_message_id,
        parts,
      },
      resolved_model_id: typeof assistant?.model === "string" ? assistant.model : runtime.foregroundModel.modelId,
      input_tokens: Number.isSafeInteger(usage.input) ? Number(usage.input) : 0,
      output_tokens: Number.isSafeInteger(usage.output) ? Number(usage.output) : 0,
    };
  };

  const finishTurn = async (threadId: string, turn: ActiveTurn): Promise<void> => {
    if (turn.finishing) return;
    turn.finishing = true;
    try {
      const record = await store.accessible(principalOf(turn.marker.actor), threadId);
      if (!record) throw new Error("Pi thread mapping disappeared before completion");
      const workspace = workspaceOf(runtime, record);
      const snapshot = await pi.getThread(threadId);
      const settledMarker = {
        ...turn.marker,
        input_observed: nativeInputPresent(snapshot, turn.marker.baseline_message_count, turn.marker.input),
      };
      await pi.renameThread(threadId, turn.marker.canonical_title);
      await persistAndDeliverCallback(
        workspace,
        settledMarker,
        await callbackForSnapshot(snapshot, settledMarker, workspace),
        () => settledMarker.input_observed
          ? appendCanonicalLink(
              runtime.canonicalSession(threadId, path.join(runtime.runtimeRoot, record.sessionFile)),
              settledMarker.canonical_message,
            )
          : appendCanonicalVisible(
              runtime.canonicalSession(threadId, path.join(runtime.runtimeRoot, record.sessionFile)),
              settledMarker.canonical_message,
            ),
      );
    } catch (error) {
      app.log.error({ err: error, threadId, agentAttemptId: turn.marker.receipt.agent_attempt_id }, "interactive completion remains pending");
    } finally {
      turn.unsubscribe();
      if (activeTurns.get(threadId) === turn) activeTurns.delete(threadId);
      await turn.lease.release();
    }
  };

  const trackTurn = (threadId: string, marker: TurnMarker, lease: PiExecutionLease): ActiveTurn => {
    const turn: ActiveTurn = {
      unsubscribe: () => undefined, lease, marker, armed: false, ended: false, finishing: false,
    };
    turn.unsubscribe = pi.subscribe(threadId, (event) => {
      if (event.type !== "agent_settled") return;
      turn.ended = true;
      if (turn.armed) void finishTurn(threadId, turn);
    }, { includeSnapshot: false });
    activeTurns.set(threadId, turn);
    return turn;
  };

  const armTurn = (threadId: string, turn: ActiveTurn, marker: TurnMarker): void => {
    turn.marker = marker;
    turn.armed = true;
    if (turn.ended) void finishTurn(threadId, turn);
  };

  const recoverOutstandingTurn = async (record: PiThreadRecord): Promise<void> => {
    const workspace = workspaceOf(runtime, record);
    const marker = await activeMarker(workspace);
    if (!marker) return;
    await pi.renameThread(record.threadId, marker.canonical_title);
    if (marker.status === "completion_pending" && marker.pending_callback) {
      const snapshot = await pi.getThread(record.threadId);
      const observed = marker.input_observed
        && nativeInputPresent(snapshot, marker.baseline_message_count, marker.input);
      await (observed ? appendCanonicalLink : appendCanonicalVisible)(
        runtime.canonicalSession(record.threadId, path.join(runtime.runtimeRoot, record.sessionFile)),
        marker.canonical_message,
      );
      await deliverCallback(marker, marker.pending_callback);
      await clearTerminalSecrets(workspace, marker);
      return;
    }
    if (marker.status === "prepared") {
      await persistAndDeliverCallback(workspace, marker, {
        kind: "terminal", status: "failed", error_code: "pi_run_crashed_before_dispatch",
        error_detail: "The runtime owner exited before the admitted message entered the Pi transcript.",
      });
      return;
    }
    if (marker.status !== "sent" && marker.status !== "sending") return;
    const snapshot = await pi.getThread(record.threadId);
    const recoveredMarker = {
      ...marker,
      input_observed: nativeInputPresent(snapshot, marker.baseline_message_count, marker.input),
    };
    if (marker.status === "sending" && !recoveredMarker.input_observed) {
      await persistAndDeliverCallback(workspace, recoveredMarker, {
        kind: "terminal", status: "failed", error_code: "pi_run_crashed_before_append",
        error_detail: "The runtime owner exited before Pi durably appended the admitted user message.",
      });
      return;
    }
    await persistAndDeliverCallback(
      workspace,
      recoveredMarker,
      await callbackForSnapshot(snapshot, recoveredMarker, workspace),
      () => recoveredMarker.input_observed
        ? appendCanonicalLink(
            runtime.canonicalSession(record.threadId, path.join(runtime.runtimeRoot, record.sessionFile)),
            recoveredMarker.canonical_message,
          )
        : appendCanonicalVisible(
            runtime.canonicalSession(record.threadId, path.join(runtime.runtimeRoot, record.sessionFile)),
            recoveredMarker.canonical_message,
          ),
    );
  };

  app.get("/pi/models", { preHandler: apiGuard }, async () => {
    const models = await pi.getAvailableModels();
    return models.filter((model) => model.provider === runtime.foregroundModel.provider && model.modelId === runtime.foregroundModel.modelId)
      .map((model) => ({ ...model, availableThinkingLevels: ["high"] }));
  });

  app.get("/pi/threads", { preHandler: apiGuard }, async (request) => {
    const principal = principalOf(internalServiceContext(request).actor);
    const includeArchived = (request.query as { includeArchived?: string }).includeArchived === "true";
    const records = await store.list(principal);
    const snapshots = await Promise.all(records.map((record) => ensureHighThinking(pi, record.threadId)));
    return snapshots.map((snapshot) => publicMetadata(snapshot.metadata))
      .filter((metadata) => includeArchived || !metadata.archived);
  });

  // Public clients must create the canonical ConversationThread first. This
  // endpoint remains explicit so every Pi-visible id is the same thr_* id.
  app.post("/pi/threads", { preHandler: apiGuard }, async (_request, reply) =>
    reject(reply, 409, "canonical_thread_required", "Create the canonical conversation thread before provisioning Pi"));

  app.route({
    method: "PUT",
    url: "/pi/threads/:threadId/provision",
    preHandler: apiGuard,
    async handler(request, reply) {
      const actor = internalServiceContext(request).actor;
      const threadId = threadIdOf((request.params as { threadId?: unknown }).threadId);
      if (!threadId) return reject(reply, 404, "pi_thread_not_found", "Pi thread not found");
      const body = object(request.body ?? {});
      if (!body || Object.keys(body).some((key) => !["title", "messages"].includes(key))
        || (body.title !== undefined && (typeof body.title !== "string" || !body.title.trim() || body.title.length > 120))) {
        return reject(reply, 422, "invalid_pi_provision", "Pi provision request is invalid");
      }
      let messages: CanonicalSyncMessage[];
      try { messages = parseCanonicalMessages(body.messages); }
      catch { return reject(reply, 422, "invalid_pi_transcript", "Canonical transcript projection is invalid"); }
      const key = `${actor.tenantId}\u0000${threadId}`;
      let operation = provisionLocks.get(key);
      if (!operation) {
        operation = provisionThread(
          runtime, store, principalOf(actor), threadId,
          typeof body.title === "string" ? body.title.trim() : undefined,
          messages,
        ).finally(() => { if (provisionLocks.get(key) === operation) provisionLocks.delete(key); });
        provisionLocks.set(key, operation);
      }
      try { return reply.send(publicSnapshot(await operation)); }
      catch (error) {
        request.log.error({ err: error, threadId }, "Pi thread provision failed");
        return reject(reply, 409, "pi_thread_provision_failed", "Pi thread could not be provisioned");
      }
    },
  });

  app.post("/pi/threads/:threadId/sync", { preHandler: apiGuard }, async (request, reply) => {
    const actor = internalServiceContext(request).actor;
    const principal = principalOf(actor);
    const threadId = threadIdOf((request.params as { threadId?: unknown }).threadId);
    if (!threadId) return reject(reply, 404, "pi_thread_not_found", "Pi thread not found");
    const record = await writable(actor, threadId, reply);
    if (!record) return;
    const body = object(request.body);
    let messages: CanonicalSyncMessage[];
    try {
      if (!body || !exactKeys(body, ["title", "messages"])
        || typeof body.title !== "string" || !body.title.trim() || body.title.length > 120) throw new Error("invalid envelope");
      messages = parseCanonicalMessages(body.messages);
    } catch {
      return reject(reply, 422, "invalid_pi_transcript", "Canonical transcript projection is invalid");
    }
    if (activeTurns.has(threadId)) return reject(reply, 409, "pi_thread_busy", "Pi thread is busy");
    const lease = await store.acquireExecutionLease(principal, threadId);
    if (!lease) return reject(reply, 409, "pi_thread_busy", "Pi thread is owned by another runtime replica");
    try {
      await recoverOutstandingTurn(record);
      await syncCanonicalMessages(runtime, record, messages);
      await pi.renameThread(threadId, (body.title as string).trim());
      return reply.code(204).send();
    } catch (error) {
      request.log.error({ err: error, threadId }, "Pi canonical transcript sync failed");
      return reject(reply, 409, "pi_thread_sync_failed", "Pi thread could not be synchronized");
    } finally { await lease.release(); }
  });

  app.route({
    method: ["GET", "PATCH", "DELETE"],
    url: "/pi/threads/:threadId",
    preHandler: apiGuard,
    async handler(request, reply) {
      const actor = internalServiceContext(request).actor;
      const threadId = threadIdOf((request.params as { threadId?: unknown }).threadId);
      if (!threadId) return reject(reply, 404, "pi_thread_not_found", "Pi thread not found");
      const record = request.method === "GET"
        ? await readable(actor, threadId, reply)
        : request.method === "DELETE"
          ? await store.deletable(principalOf(actor), threadId)
          : await writable(actor, threadId, reply);
      if (!record) return request.method === "DELETE"
        ? reject(reply, 404, "pi_thread_not_found", "Pi thread not found") : undefined;
      if (request.method === "GET") return publicSnapshot(await ensureHighThinking(pi, threadId));
      if (activeTurns.has(threadId)) return reject(reply, 409, "pi_thread_busy", "Pi thread is busy");
      if (request.method === "PATCH") {
        const body = object(request.body);
        if (!body || !exactKeys(body, ["title"]) || typeof body.title !== "string" || !body.title.trim() || body.title.length > 120) {
          return reject(reply, 422, "invalid_pi_title", "Pi thread title is invalid");
        }
        await pi.renameThread(threadId, body.title.trim());
        return reply.code(204).send();
      }
      await pi.deleteThread(threadId);
      await store.remove(principalOf(actor), threadId);
      return reply.code(204).send();
    },
  });

  app.post("/pi/threads/:threadId/messages", { preHandler: apiGuard }, async (request, reply) => {
    const actor = internalServiceContext(request).actor;
    const principal = principalOf(actor);
    const threadId = threadIdOf((request.params as { threadId?: unknown }).threadId);
    if (!threadId) return reject(reply, 404, "pi_thread_not_found", "Pi thread not found");
    const record = await writable(actor, threadId, reply);
    if (!record) return;
    const body = object(request.body);
    if (!body || !exactKeys(body, ["input", "admission", "canonical_message", "canonical_title"])) {
      return reject(reply, 422, "invalid_pi_message", "Pi message envelope is invalid");
    }
    let input: PiSendMessageInput;
    let receipt: InteractiveAdmissionReceipt;
    let canonicalMessage: CanonicalSyncMessage;
    let canonicalTitle: string;
    try {
      receipt = parseInteractiveAdmissionReceipt(body.admission);
      canonicalMessage = parseCanonicalSyncMessage(body.canonical_message);
      input = parseSendInput(body.input, canonicalMessage.parts.some((part) => part.type === "attachment"));
      if (typeof body.canonical_title !== "string" || !body.canonical_title.trim() || body.canonical_title.length > 120) throw new Error();
      canonicalTitle = body.canonical_title.trim();
    } catch {
      return reject(reply, 422, "invalid_pi_message", "Pi message envelope is invalid");
    }
    if (receipt.conversation_thread_id !== threadId
      || canonicalMessage.message_id !== receipt.triggering_message_id
      || canonicalMessage.author_kind !== "student") {
      return reject(reply, 422, "invalid_pi_message", "Pi admission binding does not match the canonical message");
    }
    const workspace = workspaceOf(runtime, record);
    const existing = await readMarker(workspace, receipt.driver_execution_id);
    if (existing) {
      if (existing.input_sha256 !== inputDigest(input, canonicalMessage, canonicalTitle) || existing.receipt.agent_attempt_id !== receipt.agent_attempt_id) {
        return reject(reply, 409, "pi_message_idempotency_conflict", "Pi message idempotency binding changed");
      }
      if (["completed", "failed", "cancelled"].includes(existing.status)) {
        return reply.code(204).send();
      }
    }
    const blocking = await activeMarker(workspace);
    if (blocking && blocking.receipt.driver_execution_id !== receipt.driver_execution_id) {
      return reject(reply, 409, "pi_thread_busy", "Pi thread already has an admitted turn");
    }
    const localTurn = activeTurns.get(threadId);
    if (localTurn) {
      if (localTurn.marker.receipt.driver_execution_id === receipt.driver_execution_id
        && isDurableDispatchAcknowledgement(localTurn.marker.status)) return reply.code(204).send();
      return reject(reply, 409, "pi_thread_busy", "Pi thread is busy");
    }
    const lease = await store.acquireExecutionLease(principal, threadId);
    if (!lease) {
      // The same durable marker plus a held cross-replica lease proves another
      // Pi owner is actively responsible for this receipt.
      if (existing && isDurableDispatchAcknowledgement(existing.status)) return reply.code(204).send();
      return reject(reply, 409, "pi_thread_busy", "Pi thread is owned by another runtime replica");
    }
    let leaseHandedToTracker = false;
    let turn: ActiveTurn | undefined;
    try {
      if (existing && ["sent", "completion_pending"].includes(existing.status)) {
        await recoverOutstandingTurn(record);
        return reply.code(204).send();
      }
      if (existing?.status === "sending") {
        const present = nativeInputPresent(await pi.getThread(threadId), existing.baseline_message_count, existing.input);
        await recoverOutstandingTurn(record);
        return present ? reply.code(204).send()
          : reject(reply, 409, "pi_dispatch_crashed_before_append", "Pi dispatch did not append the admitted user message");
      }
      await writeHostPrincipal(workspace, actor);
      const baseline = (await ensureHighThinking(pi, threadId)).messages.length;
      const preparedMarker: TurnMarker = existing ?? {
        schema: MARKER_SCHEMA,
        status: "prepared",
        actor,
        receipt,
        input,
        canonical_message: canonicalMessage,
        canonical_title: canonicalTitle,
        input_sha256: inputDigest(input, canonicalMessage, canonicalTitle),
        baseline_message_count: baseline,
        input_observed: false,
        updated_at: new Date().toISOString(),
      };
      await writeMarker(workspace, preparedMarker);
      const prepared = await learning.prepare(actor, receipt, workspace, canonicalMessage);
      const sending = { ...preparedMarker, status: "sending" as const, updated_at: new Date().toISOString() };
      await writeMarker(workspace, sending);
      turn = trackTurn(threadId, sending, lease);
      leaseHandedToTracker = true;
      await pi.renameThread(threadId, canonicalTitle);
      await pi.setThinkingLevel(threadId, "high");
      await pi.sendMessage(threadId, prepared.images.length > 0
        ? { ...input, attachments: [...prepared.images] }
        : input);
      const acceptedSnapshot = await pi.getThread(threadId);
      const sent = {
        ...sending,
        status: "sent" as const,
        input_observed: nativeInputPresent(acceptedSnapshot, sending.baseline_message_count, sending.input),
        updated_at: new Date().toISOString(),
      };
      await writeMarker(workspace, sent);
      armTurn(threadId, turn, sent);
      return reply.code(204).send();
    } catch (error) {
      request.log.error({ err: error, threadId, agentAttemptId: receipt.agent_attempt_id }, "interactive Pi send failed");
      if (existing && ["sending", "sent", "completion_pending"].includes(existing.status)) {
        return reject(reply, 503, "pi_dispatch_recovery_unavailable", "Pi dispatch recovery is temporarily unavailable");
      }
      const current = await readMarker(workspace, receipt.driver_execution_id).catch(() => undefined);
      const snapshot = current ? await pi.getThread(threadId).catch(() => undefined) : undefined;
      if (turn && current && snapshot
        && nativeInputPresent(snapshot, current.baseline_message_count, current.input)) {
        const sent = { ...current, status: "sent" as const, input_observed: true, updated_at: new Date().toISOString() };
        await writeMarker(workspace, sent);
        armTurn(threadId, turn, sent);
        return reply.code(204).send();
      }
      if (turn) {
        turn.unsubscribe();
        if (activeTurns.get(threadId) === turn) activeTurns.delete(threadId);
        leaseHandedToTracker = false;
      }
      const failed = current ?? {
        schema: MARKER_SCHEMA, status: "prepared" as const, actor, receipt, input, canonical_message: canonicalMessage,
        canonical_title: canonicalTitle,
        input_sha256: inputDigest(input, canonicalMessage, canonicalTitle), baseline_message_count: 0,
        input_observed: false, updated_at: new Date().toISOString(),
      };
      await persistAndDeliverCallback(workspace, failed, {
        kind: "terminal", status: "failed", error_code: "pi_send_failed", error_detail: errorText(error),
      }).catch((callbackError) => request.log.error({ err: callbackError }, "interactive send failure callback remains pending"));
      return reject(reply, 502, "pi_send_failed", "Pi message could not be started");
    } finally {
      if (!leaseHandedToTracker) await lease.release();
    }
  });

  app.post("/pi/threads/:threadId/cancel", { preHandler: apiGuard }, async (request, reply) => {
    const actor = internalServiceContext(request).actor;
    const principal = principalOf(actor);
    const threadId = threadIdOf((request.params as { threadId?: unknown }).threadId);
    if (!threadId) return reject(reply, 404, "pi_thread_not_found", "Pi thread not found");
    const record = await writable(actor, threadId, reply);
    if (!record) return;
    if (activeTurns.has(threadId)) {
      await pi.cancelRun(threadId);
      return reply.code(204).send();
    }
    const lease = await store.acquireExecutionLease(principal, threadId);
    if (!lease) return reject(reply, 409, "pi_thread_busy", "Pi thread is owned by another runtime replica");
    try {
      const workspace = workspaceOf(runtime, record);
      const marker = await activeMarker(workspace);
      if (!marker) return reply.code(204).send();
      if (marker.status === "completion_pending" && marker.pending_callback) {
        await recoverOutstandingTurn(record);
        return reply.code(204).send();
      }
      await persistAndDeliverCallback(workspace, marker, {
        kind: "terminal", status: "cancelled", error_code: "pi_run_cancelled_after_restart",
        error_detail: "The admitted interactive run was cancelled after its runtime owner was lost.",
      });
      return reply.code(204).send();
    } finally { await lease.release(); }
  });

  app.post("/pi/threads/:threadId/queue/clear", { preHandler: apiGuard }, async (request, reply) => {
    const actor = internalServiceContext(request).actor;
    const threadId = threadIdOf((request.params as { threadId?: unknown }).threadId);
    if (!threadId || !await writable(actor, threadId, reply)) return;
    return pi.clearQueue(threadId);
  });

  app.post("/pi/threads/:threadId/model", { preHandler: apiGuard }, async (request, reply) => {
    const actor = internalServiceContext(request).actor;
    const threadId = threadIdOf((request.params as { threadId?: unknown }).threadId);
    if (!threadId || !await writable(actor, threadId, reply)) return;
    const body = object(request.body);
    if (!body || !exactKeys(body, ["provider", "modelId"])
      || body.provider !== runtime.foregroundModel.provider || body.modelId !== runtime.foregroundModel.modelId) {
      return reject(reply, 422, "invalid_foreground_model", "Foreground model is fixed by policy");
    }
    await pi.setModel(threadId, runtime.foregroundModel);
    await pi.setThinkingLevel(threadId, "high");
    return reply.code(204).send();
  });

  app.post("/pi/threads/:threadId/thinking", { preHandler: apiGuard }, async (request, reply) => {
    const actor = internalServiceContext(request).actor;
    const threadId = threadIdOf((request.params as { threadId?: unknown }).threadId);
    if (!threadId || !await writable(actor, threadId, reply)) return;
    const body = object(request.body);
    if (!body || !exactKeys(body, ["level"]) || body.level !== "high") {
      return reject(reply, 422, "thinking_level_fixed", "Foreground thinking level is fixed to high");
    }
    await pi.setThinkingLevel(threadId, "high");
    return reply.code(204).send();
  });

  app.post("/pi/threads/:threadId/host-ui", { preHandler: apiGuard }, async (request, reply) => {
    const actor = internalServiceContext(request).actor;
    const threadId = threadIdOf((request.params as { threadId?: unknown }).threadId);
    if (!threadId || !await writable(actor, threadId, reply)) return;
    const body = object(request.body);
    if (!body || !exactKeys(body, ["response"]) || !object(body.response)) return reject(reply, 422, "invalid_host_ui_response", "Host UI response is invalid");
    await pi.respondToHostUiRequest(threadId, body.response as unknown as PiHostUiResponse);
    return reply.code(204).send();
  });

  for (const action of ["archive", "unarchive"] as const) {
    app.post(`/pi/threads/:threadId/${action}`, { preHandler: apiGuard }, async (request, reply) => {
      const actor = internalServiceContext(request).actor;
      const threadId = threadIdOf((request.params as { threadId?: unknown }).threadId);
      if (!threadId || !await writable(actor, threadId, reply)) return;
      if (activeTurns.has(threadId)) return reject(reply, 409, "pi_thread_busy", "Pi thread is busy");
      if (action === "archive") await pi.archiveThread(threadId);
      else await pi.unarchiveThread(threadId);
      return reply.code(204).send();
    });
  }

  app.get("/pi/threads/:threadId/events", { preHandler: apiGuard, sse: "only" }, async (request, reply) => {
    const actor = internalServiceContext(request).actor;
    const threadId = threadIdOf((request.params as { threadId?: unknown }).threadId);
    if (!threadId || !await readable(actor, threadId, reply)) return;
    const includeSnapshot = (request.query as { snapshot?: string }).snapshot !== "false";
    let closed = false;
    let wake: (() => void) | undefined;
    const queue: PiClientEvent[] = [];
    const unsubscribe = pi.subscribe(threadId, (event) => {
      queue.push(publicEvent(event));
      wake?.();
      wake = undefined;
    }, { includeSnapshot });
    reply.sse.onClose(() => {
      closed = true;
      wake?.();
      wake = undefined;
    });
    const events = async function* () {
      try {
        while (!closed) {
          const event = queue.shift();
          if (event) { yield { data: event }; continue; }
          await new Promise<void>((resolve) => { wake = resolve; });
        }
      } finally { unsubscribe(); }
    };
    reply.header("cache-control", "no-cache, no-transform").header("x-accel-buffering", "no");
    await reply.sse.send(events());
  });
}
