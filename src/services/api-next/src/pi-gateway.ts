import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  immutableObjectDescriptorSchema,
  storageObjectResolveRequestSchema,
  storageObjectResolveResponseSchema,
  type ImmutableObjectDescriptor,
} from "@mathpilot/content-integrity";
import { canonicalJson } from "@mathpilot/content-integrity/node";
import {
  MAX_CANONICAL_MIRROR_TRANSCRIPT_MESSAGES,
  parseInteractiveAdmissionReceipt,
} from "@mathpilot/contracts";
import type {
  CanonicalMessagePart,
  CanonicalMirrorMessage,
  LearningThreadMessage,
} from "@mathpilot/contracts";
import type { InternalServiceRuntime } from "@mathpilot/internal-service";
import { isProblemDetails, sendProblem } from "@mathpilot/internal-service/fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import type { Principal } from "./auth.ts";
import { LearningCommandError, LearningCommandService } from "./learning-command/service.ts";
import { LearningReadService } from "./learning-read/service.ts";

const THREAD_ID = /^thr_[A-Za-z0-9]{8,}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
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

type PrincipalResolver = (request: FastifyRequest, reply: FastifyReply) => Promise<Principal | null>;

type CanonicalSyncMessage = CanonicalMirrorMessage;

const canonicalParts = (message: LearningThreadMessage): CanonicalMessagePart[] => message.parts.map((part) => {
  if (part.type !== "teaching_artifact") return part;
  return {
    type: "teaching_artifact",
    artifact_ref: part.artifact_ref,
    artifact_schema: part.artifact_schema,
    summary: part.summary,
  };
});

export const canonicalSyncMessage = (message: LearningThreadMessage): CanonicalSyncMessage => {
  const value = {
    message_id: message.message_id,
    author_kind: message.author_kind,
    created_at: new Date(message.created_at).toISOString(),
    parts: canonicalParts(message),
  };
  return {
    ...value,
    digest: createHash("sha256").update(canonicalJson(value).json, "utf8").digest("hex"),
    ...(message.reply_to_message_id ? { reply_to_message_id: message.reply_to_message_id } : {}),
  };
};

const canonicalTranscript = async (
  reads: Pick<LearningReadService, "threadMessages">,
  principal: Principal,
  threadId: string,
) => {
  const messages: CanonicalSyncMessage[] = [];
  let after: unknown;
  let title = "新对话";
  let threadVersion = 0;
  const seenCursors = new Set<string>();
  for (;;) {
    const view = await reads.threadMessages(principal, threadId, after);
    const data = view.data as {
      thread?: { title?: unknown; version?: unknown };
      messages?: unknown;
      next_cursor?: unknown;
      has_more?: unknown;
    };
    if (typeof data.thread?.title === "string") title = data.thread.title;
    if (Number.isSafeInteger(data.thread?.version)) threadVersion = Number(data.thread?.version);
    if (!Array.isArray(data.messages)) throw new Error("canonical thread read returned invalid messages");
    for (const message of data.messages as LearningThreadMessage[]) {
      if (message.lifecycle === "committed") messages.push(canonicalSyncMessage(message));
    }
    if (messages.length > MAX_CANONICAL_MIRROR_TRANSCRIPT_MESSAGES) {
      throw new Error("canonical transcript exceeds the Pi synchronization limit");
    }
    if (data.has_more !== true) return { messages, title, threadVersion };
    if (typeof data.next_cursor !== "string" || !data.next_cursor) throw new Error("canonical thread cursor is invalid");
    if (seenCursors.has(data.next_cursor)) throw new Error("canonical thread cursor did not advance");
    seenCursors.add(data.next_cursor);
    after = data.next_cursor;
  }
};

const parseIdempotency = (request: FastifyRequest, body: JsonObject): string => {
  const header = request.headers["idempotency-key"];
  if (typeof header !== "string" || !IDEMPOTENCY_KEY.test(header)
    || typeof body.idempotency_key !== "string" || body.idempotency_key !== header) {
    throw new Error("idempotency key is invalid");
  }
  return header;
};

const parseRequestedAt = (value: unknown): string => {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("requested_at is invalid");
  return new Date(value).toISOString();
};

const parseOfficialInput = (value: unknown): {
  piInput: JsonObject;
  content: string;
  attachmentParts: CanonicalMessagePart[];
  descriptors: ImmutableObjectDescriptor[];
} => {
  const input = object(value);
  if (!input || Object.keys(input).some((key) => !["content", "streamingBehavior", "mathpilotAttachments"].includes(key))
    || typeof input.content !== "string" || input.content.length > 50_000
    || (input.streamingBehavior !== undefined && input.streamingBehavior !== "followUp" && input.streamingBehavior !== "steer")) {
    throw new Error("Pi input is invalid");
  }
  const descriptors = input.mathpilotAttachments === undefined ? [] : input.mathpilotAttachments;
  if (!Array.isArray(descriptors) || descriptors.length > 16) throw new Error("canonical attachments are invalid");
  const parsedDescriptors = descriptors.map((candidate) => {
    const raw = object(candidate);
    if (!raw || typeof raw.attachment_id !== "string" || !/^[A-Za-z0-9._:-]{8,200}$/.test(raw.attachment_id)) {
      throw new Error("canonical attachment id is invalid");
    }
    const { attachment_id: _attachmentId, ...descriptorValue } = raw;
    return immutableObjectDescriptorSchema.parse(descriptorValue);
  });
  if (new Set(parsedDescriptors.map((descriptor) => descriptor.object_ref)).size !== parsedDescriptors.length) {
    throw new Error("canonical attachments repeat an object");
  }
  const attachmentParts = parsedDescriptors.map((descriptor) => {
    return {
      type: "attachment" as const,
      attachment_ref: descriptor.object_ref,
      name: descriptor.original_name,
      mime_type: descriptor.mime_type,
      version_id: descriptor.version_id,
      sha256: descriptor.sha256,
      byte_size: descriptor.byte_size,
    };
  });
  const content = input.content.trim() ? input.content : "";
  if (!content && attachmentParts.length === 0) throw new Error("Pi input is empty");
  return {
    piInput: {
      content,
      ...(input.streamingBehavior === undefined ? {} : { streamingBehavior: input.streamingBehavior }),
    },
    content,
    attachmentParts,
    descriptors: parsedDescriptors,
  };
};

class AttachmentAuthorizationError extends Error {
  constructor(readonly status: 422 | 503, message: string) { super(message); }
}

/** Storage resolve is the pre-admission authorization boundary. The database
 * trigger remains the atomic claim authority; this check prevents an invalid
 * browser descriptor from ever reaching that transaction as a canonical part. */
export const authorizePiAttachments = async (
  runtime: InternalServiceRuntime,
  principal: Principal,
  descriptors: readonly ImmutableObjectDescriptor[],
): Promise<void> => {
  if (descriptors.length === 0) return;
  const body = storageObjectResolveRequestSchema.parse({
    object_refs: descriptors.map((descriptor) => descriptor.object_ref),
    download_intent: "attachment",
  });
  let response: Response;
  try {
    response = await runtime.request("api-to-storage", principal, "/internal/objects/resolve", {
      method: "POST", json: body, timeoutMs: 15_000,
    });
  } catch {
    throw new AttachmentAuthorizationError(503, "Attachment authorization is unavailable");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new AttachmentAuthorizationError(response.status >= 500 ? 503 : 422, "Attachment is not authorized");
  }
  let resolved: ReturnType<typeof storageObjectResolveResponseSchema.parse>;
  try { resolved = storageObjectResolveResponseSchema.parse(await response.json()); }
  catch { throw new AttachmentAuthorizationError(503, "Attachment authorization returned an invalid response"); }
  if (resolved.objects.length !== descriptors.length) {
    throw new AttachmentAuthorizationError(422, "Attachment authorization returned an incomplete response");
  }
  const byRef = new Map(resolved.objects.map((descriptor) => [descriptor.object_ref, descriptor]));
  for (const requested of descriptors) {
    const candidate = byRef.get(requested.object_ref);
    if (!candidate) throw new AttachmentAuthorizationError(422, "Attachment is not authorized");
    const { download: _download, ...immutable } = candidate;
    const verified = immutableObjectDescriptorSchema.parse(immutable);
    if (canonicalJson(verified).json !== canonicalJson(requested).json) {
      throw new AttachmentAuthorizationError(422, "Attachment immutable metadata changed");
    }
  }
};

const upstreamProblem = async (response: Response, reply: FastifyReply): Promise<FastifyReply> => {
  const bytes = Buffer.from(await response.arrayBuffer());
  try {
    const problem: unknown = JSON.parse(bytes.toString("utf8"));
    if (isProblemDetails(problem) && problem.status === response.status) {
      reply.code(response.status).type("application/problem+json").header("cache-control", "no-store");
      return reply.send(bytes);
    }
  } catch { /* normalized below */ }
  return reject(reply, 502, "invalid_pi_upstream_response", "Pi runtime returned an invalid response");
};

const relayPi = async (
  runtime: InternalServiceRuntime,
  principal: Principal,
  path: string,
  request: FastifyRequest,
  reply: FastifyReply,
  json?: unknown,
): Promise<FastifyReply | void> => {
  const streaming = path.includes("/events");
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("browser connection closed"));
  if (request.raw.aborted) abort(); else request.raw.once("aborted", abort);
  reply.raw.once("close", abort);
  try {
    const lastEventId = request.headers["last-event-id"];
    const streamHeaders: Record<string, string> = { accept: "text/event-stream" };
    if (typeof lastEventId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(lastEventId)) {
      streamHeaders["last-event-id"] = lastEventId;
    }
    const response = await runtime.request("api-to-pi", principal, path, {
      method: request.method,
      ...(json === undefined ? {} : { json }),
      headers: streaming ? streamHeaders : {},
      signal: controller.signal,
      timeoutMs: streaming ? 15 * 60_000 : 30_000,
    });
    if (!response.ok) return upstreamProblem(response, reply);
    if (streaming) {
      if (!response.body || !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
        await response.body?.cancel().catch(() => undefined);
        return reject(reply, 502, "invalid_pi_event_stream", "Pi runtime returned an invalid event stream");
      }
      reply.hijack();
      reply.raw.writeHead(response.status, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      await pipeline(Readable.fromWeb(response.body as never), reply.raw);
      return;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    reply.code(response.status);
    const contentType = response.headers.get("content-type");
    if (contentType) reply.header("content-type", contentType);
    reply.header("cache-control", "private, no-cache");
    return reply.send(bytes);
  } catch (error) {
    request.log.error({ err: error, path }, "Pi runtime request failed");
    if (reply.raw.headersSent) {
      if (!reply.raw.destroyed) reply.raw.destroy(error instanceof Error ? error : undefined);
      return;
    }
    return reject(reply, 502, "pi_runtime_unavailable", "Pi runtime is unavailable");
  } finally {
    request.raw.removeListener("aborted", abort);
    reply.raw.removeListener("close", abort);
  }
};

const syncPi = async (
  runtime: InternalServiceRuntime,
  principal: Principal,
  threadId: string,
  title: string,
  messages: readonly CanonicalSyncMessage[],
): Promise<"synchronized" | "busy" | "missing"> => {
  const response = await runtime.request(
    "api-to-pi", principal, `/pi/threads/${encodeURIComponent(threadId)}/sync`,
    { method: "POST", json: { title, messages }, timeoutMs: 30_000 },
  );
  if (response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return "synchronized";
  }
  const value = await response.json().catch(() => undefined);
  if (response.status === 409 && object(value)?.code === "pi_thread_busy") return "busy";
  if (response.status === 404 && object(value)?.code === "pi_thread_not_found") return "missing";
  throw new Error(`Pi transcript sync failed (${response.status})`);
};

/**
 * Canonical threads may predate the Pi-backed foreground runtime. Reads are
 * natural-idempotent lazy provisioning points, so the first snapshot and SSE
 * subscription can race without creating a browser-owned session identity.
 */
const ensurePi = async (
  runtime: InternalServiceRuntime,
  principal: Principal,
  threadId: string,
  title: string,
  messages: readonly CanonicalSyncMessage[],
): Promise<void> => {
  const state = await syncPi(runtime, principal, threadId, title, messages);
  if (state !== "missing") return;
  const response = await runtime.request(
    "api-to-pi", principal, `/pi/threads/${encodeURIComponent(threadId)}/provision`,
    { method: "PUT", json: { title, messages }, timeoutMs: 30_000 },
  );
  if (response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return;
  }
  await response.body?.cancel().catch(() => undefined);
  // A concurrent first-open request may have provisioned the same natural
  // key. One sync distinguishes that benign race from a failed provision.
  if (await syncPi(runtime, principal, threadId, title, messages) !== "missing") return;
  throw new Error(`Pi thread provision failed (${response.status})`);
};

export function registerPiGateway(
  app: FastifyInstance,
  pool: pg.Pool,
  runtime: InternalServiceRuntime,
  principalOf: PrincipalResolver,
  dependencies: {
    reads?: Pick<LearningReadService, "threadMessages">;
    commands?: Pick<LearningCommandService, "submitInteractiveForegroundMessage" | "failInteractiveDispatch">;
  } = {},
): void {
  const reads = dependencies.reads ?? new LearningReadService(pool);
  const commands = dependencies.commands ?? new LearningCommandService(pool);

  app.put("/api/pi/threads/:threadId/provision", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    const threadId = (request.params as { threadId?: string }).threadId ?? "";
    if (!THREAD_ID.test(threadId)) return reject(reply, 404, "pi_thread_not_found", "Pi thread not found");
    const transcript = await canonicalTranscript(reads, principal, threadId);
    try { await ensurePi(runtime, principal, threadId, transcript.title, transcript.messages); }
    catch (error) {
      request.log.error({ err: error, threadId }, "Pi thread provision is unavailable");
      return reject(reply, 503, "pi_provision_unavailable", "Pi thread provision is temporarily unavailable");
    }
    return reply.code(204).send();
  });

  app.post("/api/pi/threads/:threadId/provision", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    void principal;
    return reject(reply, 410, "pi_provision_contract_retired", "Provision Pi threads with PUT and no request body");
  });

  app.post("/api/pi/threads/:threadId/messages", async (request, reply) => {
    const principal = await principalOf(request, reply); if (!principal) return;
    const threadId = (request.params as { threadId?: string }).threadId ?? "";
    const body = object(request.body);
    let key: string;
    let requestedAt: string;
    let parsed: ReturnType<typeof parseOfficialInput>;
    if (!THREAD_ID.test(threadId) || !body || !exactKeys(body, ["idempotency_key", "expected_version", "requested_at", "input"])) {
      return reject(reply, 422, "invalid_pi_message", "Pi message request is invalid");
    }
    try {
      key = parseIdempotency(request, body);
      requestedAt = parseRequestedAt(body.requested_at);
      parsed = parseOfficialInput(body.input);
      if (!Number.isSafeInteger(body.expected_version) || Number(body.expected_version) < 0) throw new Error();
    } catch { return reject(reply, 422, "invalid_pi_message", "Pi message request is invalid"); }
    try { await authorizePiAttachments(runtime, principal, parsed.descriptors); }
    catch (error) {
      const status = error instanceof AttachmentAuthorizationError ? error.status : 503;
      return reject(reply, status, status === 422 ? "invalid_pi_attachment" : "pi_attachment_authorization_unavailable",
        status === 422 ? "Pi attachment is not authorized" : "Attachment authorization is temporarily unavailable");
    }
    // Provision against the pre-admission transcript. The triggering message
    // does not exist yet, so a legacy canonical thread receives its committed
    // history exactly once before the real Pi user bubble is dispatched.
    const beforeAdmission = await canonicalTranscript(reads, principal, threadId);
    try { await ensurePi(runtime, principal, threadId, beforeAdmission.title, beforeAdmission.messages); }
    catch (error) {
      request.log.error({ err: error, threadId }, "Pi mapping could not be ensured before canonical admission");
      return reject(reply, 503, "pi_provision_unavailable", "Pi thread provision is temporarily unavailable");
    }
    const parts: CanonicalMessagePart[] = [
      ...(parsed.content ? [{ type: "text" as const, text: parsed.content }] : []),
      ...parsed.attachmentParts,
    ];
    const admission = await commands.submitInteractiveForegroundMessage(principal, threadId, {
      schema_version: 3,
      command_type: "send_message",
      idempotency_key: key,
      expected_version: Number(body.expected_version),
      requested_at: requestedAt,
      parts,
    }, key);
    const transcript = await canonicalTranscript(reads, principal, threadId);
    if (!admission.dispatch_required) {
      await ensurePi(runtime, principal, threadId, transcript.title, transcript.messages).catch((error) =>
        request.log.warn({ err: error, threadId }, "terminal canonical attempt could not refresh its Pi mirror"));
      const terminal = admission as typeof admission & { request_status?: unknown; attempt_status?: unknown };
      if (terminal.request_status === terminal.attempt_status
        && ["succeeded", "failed", "cancelled"].includes(String(terminal.request_status))) {
        const status = terminal.request_status as "succeeded" | "failed" | "cancelled";
        return reject(reply, 409, `interactive_attempt_${status}`,
          `This admitted message already has a ${status} interactive attempt`);
      }
      return reject(reply, 503, "pi_admission_state_unavailable", "Interactive admission state is unavailable");
    }
    const canonicalMessage = transcript.messages.find((message) => message.message_id === admission.triggering_message_id);
    if (!canonicalMessage) throw new Error("admitted canonical message is not visible in the authorized read model");
    const receipt = parseInteractiveAdmissionReceipt({
      operation_id: admission.operation_id,
      foreground_request_id: admission.foreground_request_id,
      conversation_thread_id: admission.conversation_thread_id,
      foreground_epoch_id: admission.foreground_epoch_id,
      triggering_message_id: admission.triggering_message_id,
      event_id: admission.event_id,
      agent_attempt_id: admission.agent_attempt_id,
      input_ref: admission.input_ref,
      driver_execution_id: admission.driver_execution_id,
      execution_driver: admission.execution_driver,
    });
    const envelope = {
      input: parsed.piInput,
      admission: receipt,
      canonical_message: canonicalMessage,
      canonical_title: transcript.title,
    };
    let confirmed = false;
    let lastDispatchError: unknown;
    for (let attempt = 0; attempt < 2 && !confirmed; attempt += 1) {
      try {
        const response = await runtime.request(
          "api-to-pi", principal, `/pi/threads/${encodeURIComponent(threadId)}/messages`,
          { method: "POST", json: envelope, timeoutMs: 3 * 60_000 },
        );
        if (response.ok) confirmed = true;
        else lastDispatchError = new Error(`Pi dispatch was rejected (${response.status})`);
        await response.body?.cancel().catch(() => undefined);
      } catch (error) { lastDispatchError = error; }
    }
    if (!confirmed) {
      request.log.error({ err: lastDispatchError, threadId, agentAttemptId: admission.agent_attempt_id },
        "Pi dispatch remained unconfirmed after a bounded idempotent retry");
      try { await commands.failInteractiveDispatch(principal, receipt); }
      catch (error) {
        // A late Pi terminal may win the same locked CAS. It remains terminal
        // and cannot be revived; the browser still receives a retryable
        // unconfirmed result rather than a false successful send.
        request.log.warn({ err: error, threadId, agentAttemptId: admission.agent_attempt_id },
          "Pi dispatch compensation raced an existing terminal state");
        if (error instanceof LearningCommandError && error.status === 409) {
          return reject(reply, 503, "pi_dispatch_unconfirmed", "Pi dispatch raced an existing canonical terminal state");
        }
        return reject(reply, 503, "pi_dispatch_compensation_unavailable", "Pi dispatch compensation is temporarily unavailable");
      }
      return reject(reply, 503, "pi_dispatch_failed", "Canonical admission was compensated after Pi dispatch failed");
    }
    return reply.code(200).send({ thread_version: admission.thread_version });
  });

  app.route({
    method: ["GET", "POST"],
    url: "/api/pi/*",
    async handler(request, reply) {
      const principal = await principalOf(request, reply); if (!principal) return;
      const suffix = request.url.replace(/^\/api\/pi(?=\/|$)/, "") || "/";
      const routePath = suffix.split("?", 1)[0] ?? suffix;
      const match = /^\/threads\/(thr_[A-Za-z0-9]{8,})(?:\/|$)/.exec(routePath);
      const threadId = match?.[1];
      if (request.method === "POST" && (/\/archive$|\/unarchive$/.test(routePath))) {
        return reject(reply, 409, "canonical_thread_owned", "Thread lifecycle is owned by the canonical learning API");
      }
      if (request.method === "POST" && routePath === "/threads") {
        return reject(reply, 409, "canonical_thread_required", "Create the canonical conversation thread first");
      }
      if (threadId) {
        const transcript = await canonicalTranscript(reads, principal, threadId);
        if (request.method === "GET") await ensurePi(runtime, principal, threadId, transcript.title, transcript.messages);
      }
      return relayPi(runtime, principal, `/pi${suffix}`, request, reply, request.method === "POST" ? request.body : undefined);
    },
  });

  app.route({
    method: ["PATCH", "DELETE"],
    url: "/api/pi/*",
    async handler(request, reply) {
      const principal = await principalOf(request, reply); if (!principal) return;
      void principal;
      return reject(reply, 409, "canonical_thread_owned", "Thread title and lifecycle are owned by the canonical learning API");
    },
  });
}
