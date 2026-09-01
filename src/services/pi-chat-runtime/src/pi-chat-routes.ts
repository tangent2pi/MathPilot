import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PiClient, PiHostUiResponse, PiSendMessageInput, PiThinkingLevel } from "@assistant-ui/react-pi";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiThreadStore, type PiPrincipal, type PiThreadRecord } from "./pi-thread-store.ts";
import { PiObjectStore } from "./pi-object-store.ts";
import { assemblePiChatWorkspace, bindPiThreadWorkspace } from "./pi-chat-workspace.ts";
import { publishWorkspaceArtifacts, readPublishedArtifact } from "./artifact-publisher.ts";
import type { PiChatRuntime } from "./pi-chat-server.ts";
import {
  bindAttachmentTurn,
  isAttachmentId,
  removePendingAttachment,
  releaseAttachmentTurn,
  savePendingAttachment,
  type AttachmentTurn,
} from "../extensions/attachments/manifest.ts";
import { clearHostPrincipal, writeHostPrincipal } from "../extensions/lib/host-principal.ts";

const principalOf = (request: FastifyRequest): PiPrincipal | undefined => {
  const expectedSecret = process.env.PI_GATEWAY_SECRET;
  const actualSecret = request.headers["x-mathpilot-gateway-secret"];
  if (!expectedSecret || actualSecret !== expectedSecret) return undefined;
  const tenantId = request.headers["x-tenant-id"];
  const userId = request.headers["x-user-id"];
  const roles = request.headers["x-user-roles"];
  if (typeof tenantId !== "string" || !tenantId || typeof userId !== "string" || !userId) return undefined;
  return {
    tenantId,
    userId,
    roles: typeof roles === "string"
      ? roles.split(",").map((role) => role.trim()).filter(Boolean).slice(0, 32)
      : [],
  };
};

const internalPrincipalOf = (request: FastifyRequest): PiPrincipal | undefined => {
  const expectedSecret = process.env.CONTENT_NEXT_SECRET ?? process.env.PI_GATEWAY_SECRET;
  const actualSecret = request.headers["x-mathpilot-runtime-secret"];
  if (!expectedSecret || expectedSecret.length < 32 || actualSecret !== expectedSecret) return undefined;
  const tenantId = request.headers["x-tenant-id"];
  const userId = request.headers["x-user-id"];
  const roles = request.headers["x-user-roles"];
  if (typeof tenantId !== "string" || !tenantId || typeof userId !== "string" || !userId) return undefined;
  return {
    tenantId,
    userId,
    roles: typeof roles === "string"
      ? roles.split(",").map((role) => role.trim()).filter((role) => role === "teacher" || role === "student")
      : [],
  };
};

const storageNextUrl = (process.env.STORAGE_NEXT_URL ?? "http://storage-next:3017").replace(/\/$/, "");
const storageNextSecret = process.env.STORAGE_NEXT_SECRET ?? process.env.PI_GATEWAY_SECRET ?? "";

type StorageObjectGrant = {
  object_id: string;
  download_url: string;
  original_name: string | null;
  mime_type: string;
  byte_size: number;
  sha256: string | null;
  version_id: string;
};

const requestStorageGrant = async (
  principal: PiPrincipal,
  objectId: string,
  audience: "public" | "runtime",
): Promise<StorageObjectGrant> => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(objectId)) throw new Error("invalid storage object id");
  if (storageNextSecret.length < 32) throw new Error("storage-next runtime secret is not configured");
  const response = await fetch(`${storageNextUrl}/internal/objects/${encodeURIComponent(objectId)}/presign-get`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mathpilot-runtime-secret": storageNextSecret,
      "x-tenant-id": principal.tenantId,
      "x-user-id": principal.userId,
      "x-user-roles": principal.roles.join(","),
    },
    body: JSON.stringify({ audience }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({})) as Partial<StorageObjectGrant> & { error?: unknown };
  if (!response.ok || typeof body.download_url !== "string") throw new Error(`storage object lookup failed (${response.status})`);
  if (!/^https?:\/\//i.test(body.download_url) || typeof body.object_id !== "string" || typeof body.mime_type !== "string" || typeof body.byte_size !== "number" || !Number.isSafeInteger(body.byte_size) || typeof body.version_id !== "string" || !body.version_id) {
    throw new Error("storage returned an invalid object grant");
  }
  const byteSize = body.byte_size;
  return {
    object_id: body.object_id,
    download_url: body.download_url,
    original_name: typeof body.original_name === "string" ? body.original_name : null,
    mime_type: body.mime_type,
    byte_size: byteSize,
    sha256: typeof body.sha256 === "string" ? body.sha256 : null,
    version_id: body.version_id,
  };
};

const safeAttachmentName = (name: string): string => {
  const safe = path.basename(name).replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^\.+$/, "");
  return (safe || "attachment").slice(0, 180);
};

// The host principal is deliberately persisted outside the model workspace so
// extensions can read it without exposing it to Bash. A thread must therefore
// have at most one in-flight turn: otherwise two HTTP callers could overwrite
// that file while Pi is still executing the first turn. The browser already
// serializes normal sends; this map is the server-side safety net for retries
// and alternate clients.
const principalKey = (principal: PiPrincipal): string => `${principal.tenantId}\u0000${principal.userId}`;
const reserveThread = (active: Map<string, string>, threadId: string, principal: PiPrincipal): (() => void) | undefined => {
  if (active.has(threadId)) return undefined;
  const key = principalKey(principal);
  active.set(threadId, key);
  return () => {
    if (active.get(threadId) === key) active.delete(threadId);
  };
};

const workspaceOf = (runtime: PiChatRuntime, record: PiThreadRecord): string => {
  const workspace = path.resolve(runtime.runtimeRoot, record.sessionDir);
  if (!workspace.startsWith(`${path.resolve(runtime.sessionsRoot)}${path.sep}`)) throw new Error("invalid session directory");
  return workspace;
};

const sessionFileOf = (runtime: PiChatRuntime, record: PiThreadRecord): string => {
  const sessionFile = path.resolve(runtime.runtimeRoot, record.sessionFile);
  if (!sessionFile.startsWith(`${path.resolve(runtime.agentSessionsRoot)}${path.sep}`)) throw new Error("invalid Pi session file");
  return sessionFile;
};

const pathIsWithin = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

export const containedLocalEntryExists = async (
  allowedRoot: string,
  candidate: string,
  expected: "directory" | "file",
): Promise<boolean> => {
  const rootInfo = await lstat(allowedRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("local path root must be a real directory");
  let info;
  try {
    info = await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error("local path symlinks are forbidden");
  if ((expected === "directory" && !info.isDirectory()) || (expected === "file" && !info.isFile())) {
    throw new Error(`local path must be a ${expected}`);
  }
  const [root, resolved] = await Promise.all([realpath(allowedRoot), realpath(candidate)]);
  if (!pathIsWithin(root, resolved) || resolved === root) throw new Error("local path escapes its allowed root");
  return true;
};

type ErCommandMarker = {
  schema: "mathpilot.er-start/v1";
  command_id: string;
  candidate_set_id: string;
  target_thread_id: string;
  status: "starting" | "sent";
};

const readErCommandMarker = async (workspace: string): Promise<ErCommandMarker | undefined> => {
  try {
    const value = JSON.parse(await readFile(path.join(workspace, "input", "session", "er-command.json"), "utf8")) as Partial<ErCommandMarker>;
    if (value.schema !== "mathpilot.er-start/v1" || typeof value.command_id !== "string" || typeof value.candidate_set_id !== "string" || typeof value.target_thread_id !== "string") return undefined;
    if (value.status !== "starting" && value.status !== "sent") return undefined;
    return value as ErCommandMarker;
  } catch {
    return undefined;
  }
};

const ensureErThread = async (
  runtime: PiChatRuntime,
  store: PiThreadStore,
  principal: PiPrincipal,
  targetThreadId: string,
): Promise<PiThreadRecord> => {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(targetThreadId)) throw new Error("invalid target Pi thread id");
  const existing = await store.accessible(principal, targetThreadId);
  if (existing) return existing;

  // The workspace name is deterministic for the command.  This is not a
  // second workflow identity; it only lets a retry find the same ordinary Pi
  // session before the mapping transaction has completed.
  const workspaceId = `er-${targetThreadId}`;
  const sessionDir = `sessions/${workspaceId}`;
  const workspacePath = path.join(runtime.sessionsRoot, workspaceId);
  await assemblePiChatWorkspace(workspacePath, runtime.skillsRoot);
  await mkdir(path.join(workspacePath, "input", "frozen"), { recursive: true });
  await bindPiThreadWorkspace(workspacePath, targetThreadId);

  let sessionFileAbsolute: string | undefined;
  const discovered = await SessionManager.list(workspacePath, runtime.agentSessionsRoot).catch(() => []);
  const discoveredTarget = discovered.find((info) => info.id === targetThreadId);
  if (discoveredTarget) sessionFileAbsolute = discoveredTarget.path;
  if (!sessionFileAbsolute) {
    const manager = SessionManager.create(workspacePath, runtime.agentSessionsRoot, { id: targetThreadId });
    sessionFileAbsolute = manager.getSessionFile();
    const header = manager.getHeader();
    if (!sessionFileAbsolute || !header) throw new Error("Pi did not allocate a session file for ER handoff");
    // SessionManager intentionally waits for the first assistant message before
    // flushing an empty session.  Persist the header now so pi.getThread() can
    // open the pre-generated ID and the command remains retryable after a crash.
    await writeFile(sessionFileAbsolute, `${JSON.stringify(header)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
  }
  const relativeSessionFile = path.relative(runtime.runtimeRoot, sessionFileAbsolute);
  if (relativeSessionFile.startsWith("..") || path.isAbsolute(relativeSessionFile)) throw new Error("ER session file is outside runtime root");
  return store.create(principal, { threadId: targetThreadId, sessionDir, sessionFile: relativeSessionFile });
};

type PiSnapshot = Awaited<ReturnType<PiClient["getThread"]>>;
const erHandoffLocks = new Map<string, Promise<{ record: PiThreadRecord; workspace: string; snapshot: PiSnapshot }>>();
const reviewFeedbackLocks = new Map<string, Promise<{ record: PiThreadRecord; workspace: string; snapshot: PiSnapshot }>>();

type ReviewFeedbackMarker = {
  schema: "mathpilot.review-feedback/v1";
  command_id: string;
  candidate_set_id: string;
  target_thread_id: string;
  status: "starting" | "sent";
};

const readReviewFeedbackMarker = async (markerPath: string): Promise<ReviewFeedbackMarker | undefined> => {
  try {
    const value = JSON.parse(await readFile(markerPath, "utf8")) as Partial<ReviewFeedbackMarker>;
    if (value.schema !== "mathpilot.review-feedback/v1" || typeof value.command_id !== "string" || typeof value.candidate_set_id !== "string" || typeof value.target_thread_id !== "string") return undefined;
    if (value.status !== "starting" && value.status !== "sent") return undefined;
    return value as ReviewFeedbackMarker;
  } catch {
    return undefined;
  }
};

const snapshotContainsUserToken = (snapshot: PiSnapshot, token: string): boolean => snapshot.messages.some((message) =>
  message.role === "user"
  && (() => {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content.includes(token);
    if (!Array.isArray(content)) return false;
    return content.some((part: unknown) => part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string" && part.text.includes(token));
  })(),
);

export const restoreArchivedThread = async (
  runtime: PiChatRuntime,
  record: PiThreadRecord,
  pi: PiClient,
  objectStore?: PiObjectStore,
): Promise<boolean> => {
  const workspace = workspaceOf(runtime, record);
  const sessionFile = sessionFileOf(runtime, record);
  let workspaceExists = await containedLocalEntryExists(runtime.sessionsRoot, workspace, "directory");
  let sessionFileExists = await containedLocalEntryExists(runtime.agentSessionsRoot, sessionFile, "file");
  if (record.archivedAt && objectStore && record.minioKey) {
    if (!workspaceExists) {
      await objectStore.downloadDirectory(`${record.minioKey}/workspace/`, workspace, runtime.sessionsRoot);
      workspaceExists = true;
    }
    if (!sessionFileExists) {
      await objectStore.downloadFile(`${record.minioKey}/session.jsonl`, sessionFile, runtime.agentSessionsRoot);
      sessionFileExists = true;
    }
  }
  if (!workspaceExists) return false;
  if (!sessionFileExists) {
    // Pi deliberately delays JSONL persistence until an assistant message.
    // A live empty thread is still usable in this process; after restart there
    // is no durable transcript to reconstruct and callers must fail closed.
    try {
      await pi.getThread(record.threadId);
    } catch {
      return false;
    }
  }
  if (record.archivedAt) await pi.archiveThread(record.threadId);
  return true;
};

type ArchivePiPort = Pick<PiClient, "archiveThread" | "unarchiveThread">;
type ArchiveStorePort = Pick<PiThreadStore, "commitArchiveState">;

export const commitArchiveTransition = async (input: {
  pi: ArchivePiPort;
  store: ArchiveStorePort;
  principal: PiPrincipal;
  threadId: string;
  createSnapshot: () => Promise<string | undefined>;
}): Promise<void> => {
  const key = await input.createSnapshot();
  await input.pi.archiveThread(input.threadId);
  try {
    await input.store.commitArchiveState(input.principal, input.threadId, true, key);
  } catch (error) {
    await input.pi.unarchiveThread(input.threadId).catch(() => undefined);
    throw error;
  }
};

export const commitUnarchiveTransition = async (input: {
  pi: ArchivePiPort;
  store: ArchiveStorePort;
  principal: PiPrincipal;
  threadId: string;
  restoreSnapshot: () => Promise<void>;
}): Promise<void> => {
  await input.restoreSnapshot();
  await input.pi.unarchiveThread(input.threadId);
  try {
    await input.store.commitArchiveState(input.principal, input.threadId, false);
  } catch (error) {
    await input.pi.archiveThread(input.threadId).catch(() => undefined);
    throw error;
  }
};

const owned = async (
  store: PiThreadStore,
  principal: PiPrincipal,
  threadId: string,
  reply: FastifyReply,
  write = false,
  ownerOnly = false,
): Promise<PiThreadRecord | undefined> => {
  const record = ownerOnly
    ? await store.deletable(principal, threadId)
    : await store.accessible(principal, threadId, write);
  if (!record) reply.code(404).send({ error: "thread not found" });
  return record;
};

export function registerPiChatRoutes(
  app: FastifyInstance,
  runtime: PiChatRuntime,
  store: PiThreadStore,
  objectStore?: PiObjectStore,
): void {
  const pi: PiClient = runtime.client;
  const activePrincipalByThread = new Map<string, string>();

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "Pi request failed");
    const candidateStatus = typeof error === "object" && error !== null && "statusCode" in error
      ? (error as { statusCode?: unknown }).statusCode
      : undefined;
    const statusCode = typeof candidateStatus === "number" && candidateStatus >= 400 && candidateStatus < 500
      ? candidateStatus
      : 500;
    return reply.code(statusCode).send({
      error: statusCode === 500 ? "Pi request failed" : "invalid Pi request",
    });
  });

  app.addHook("onClose", async () => {
    activePrincipalByThread.clear();
    erHandoffLocks.clear();
    reviewFeedbackLocks.clear();
    await store.close();
  });

  app.post("/internal/er-start", async (request, reply) => {
    const principal = internalPrincipalOf(request);
    if (!principal || !principal.roles.includes("teacher")) return reply.code(401).send({ error: "trusted teacher principal required" });
    const body = (request.body ?? {}) as { command_id?: unknown; candidate_set_id?: unknown; target_thread_id?: unknown };
    const commandId = typeof body.command_id === "string" ? body.command_id : "";
    const candidateSetId = typeof body.candidate_set_id === "string" ? body.candidate_set_id : "";
    const targetThreadId = typeof body.target_thread_id === "string" ? body.target_thread_id : "";
    if (!commandId || !candidateSetId || !targetThreadId) return reply.code(422).send({ error: "command_id, candidate_set_id and target_thread_id are required" });
    const key = `${principal.tenantId}\u0000${commandId}`;
    let operation = erHandoffLocks.get(key);
    if (!operation) {
      operation = (async () => {
        const record = await ensureErThread(runtime, store, principal, targetThreadId);
        const workspace = workspaceOf(runtime, record);
        const markerPath = path.join(workspace, "input", "session", "er-command.json");
        const existingMarker = await readErCommandMarker(workspace);
        if (existingMarker && (
          existingMarker.command_id !== commandId
          || existingMarker.candidate_set_id !== candidateSetId
          || existingMarker.target_thread_id !== targetThreadId
        )) throw new Error("target Pi thread is already assigned to another ER command");

        const endpoint = (process.env.CONTENT_NEXT_URL ?? process.env.CONTENT_LIBRARY_URL ?? "http://content-next:3016").replace(/\/$/, "");
        const secret = process.env.CONTENT_NEXT_SECRET ?? process.env.PI_GATEWAY_SECRET ?? "";
        if (secret.length < 32) throw new Error("content-next runtime secret is not configured");
        const frozenResponse = await fetch(`${endpoint}/internal/candidates/${encodeURIComponent(candidateSetId)}/frozen`, {
          headers: {
            "x-mathpilot-runtime-secret": secret,
            "x-tenant-id": principal.tenantId,
            "x-user-id": principal.userId,
            "x-user-roles": "teacher",
          },
          signal: AbortSignal.timeout(30_000),
        });
        if (!frozenResponse.ok) throw new Error(`approved KTQ handoff lookup failed (${frozenResponse.status})`);
        const frozen = await frozenResponse.json() as Record<string, unknown>;
        await mkdir(path.dirname(markerPath), { recursive: true });
        await writeFile(path.join(workspace, "input", "frozen", "ktq.json"), `${JSON.stringify(frozen, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await writeHostPrincipal(workspace, principal);

        if (existingMarker?.status === "sent") {
          const snapshot = await pi.getThread(targetThreadId);
          return { record, workspace, snapshot };
        }
        if (existingMarker?.status === "starting") {
          const snapshot = await pi.getThread(targetThreadId);
          const alreadyPrompted = snapshotContainsUserToken(snapshot, commandId);
          if (alreadyPrompted) {
            await writeFile(markerPath, `${JSON.stringify({ ...existingMarker, status: "sent" }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
            return { record, workspace, snapshot };
          }
        }

        const marker: ErCommandMarker = {
          schema: "mathpilot.er-start/v1",
          command_id: commandId,
          candidate_set_id: candidateSetId,
          target_thread_id: targetThreadId,
          status: "starting",
        };
        await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await pi.sendMessage(targetThreadId, {
          content: [
            `[MathPilot ER handoff ${commandId}]`,
            `已批准的 KTQ 候选集为 ${candidateSetId}，完整冻结快照位于 input/frozen/ktq.json。`,
            "这是一个新的普通对话。请读取 er-research Skill，严格基于冻结的 K/T 维度开展 E/R 研究；不要修改冻结输入，也不要直接发布内容。完成后按 Skill 调用 respond。",
          ].join("\n"),
        });
        await writeFile(markerPath, `${JSON.stringify({ ...marker, status: "sent" }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        const snapshot = await pi.getThread(targetThreadId);
        return { record, workspace, snapshot };
      })().finally(() => {
        if (erHandoffLocks.get(key) === operation) erHandoffLocks.delete(key);
      });
      erHandoffLocks.set(key, operation);
    }
    try {
      const result = await operation;
      return {
        command_id: commandId,
        candidate_set_id: candidateSetId,
        target_thread_id: targetThreadId,
        dispatched: true,
        replayed: result.snapshot.messages.length > 0,
      };
    } catch (error) {
      request.log.error({ err: error, commandId, targetThreadId }, "ER handoff failed");
      return reply.code(502).send({ error: "ER handoff failed" });
    }
  });

  app.post("/internal/review-feedback", async (request, reply) => {
    const principal = internalPrincipalOf(request);
    if (!principal || !principal.roles.includes("teacher")) return reply.code(401).send({ error: "trusted teacher principal required" });
    const body = (request.body ?? {}) as {
      command_id?: unknown;
      candidate_set_id?: unknown;
      target_thread_id?: unknown;
      phase?: unknown;
      annotations?: unknown;
    };
    const commandId = typeof body.command_id === "string" ? body.command_id : "";
    const candidateSetId = typeof body.candidate_set_id === "string" ? body.candidate_set_id : "";
    const targetThreadId = typeof body.target_thread_id === "string" ? body.target_thread_id : "";
    const phase = body.phase === "ktq" || body.phase === "er" ? body.phase : undefined;
    const rawAnnotations = Array.isArray(body.annotations) ? body.annotations : [];
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(commandId) || !candidateSetId || !targetThreadId || !phase || rawAnnotations.length === 0 || rawAnnotations.length > 500) {
      return reply.code(422).send({ error: "valid command, candidate, thread, phase and annotations are required" });
    }
    const annotations = rawAnnotations.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      const item = value as Record<string, unknown>;
      if (typeof item.revision_id !== "string" || typeof item.comment_text !== "string" || !item.comment_text.trim() || item.comment_text.length > 10_000) return undefined;
      return {
        revision_id: item.revision_id,
        revision_item_id: typeof item.revision_item_id === "string" ? item.revision_item_id : null,
        field_name: typeof item.field_name === "string" ? item.field_name : null,
        comment_text: item.comment_text,
      };
    });
    if (annotations.some((value) => !value)) return reply.code(422).send({ error: "invalid review annotation" });

    const key = `${principal.tenantId}\u0000${commandId}`;
    let operation = reviewFeedbackLocks.get(key);
    if (!operation) {
      operation = (async () => {
        const record = await store.deletable(principal, targetThreadId);
        if (!record) throw new Error("review target thread is not owned by this teacher");
        if (!await restoreArchivedThread(runtime, record, pi, objectStore)) {
          throw new Error("review target Pi session is not recoverable");
        }
        const workspace = workspaceOf(runtime, record);
        const markerPath = path.join(workspace, "input", "session", "review-feedback", `${commandId}.json`);
        const existingMarker = await readReviewFeedbackMarker(markerPath);
        if (existingMarker && (
          existingMarker.command_id !== commandId
          || existingMarker.candidate_set_id !== candidateSetId
          || existingMarker.target_thread_id !== targetThreadId
        )) throw new Error("review feedback marker does not match this command");

        if (existingMarker?.status === "sent") {
          return { record, workspace, snapshot: await pi.getThread(targetThreadId) };
        }
        if (existingMarker?.status === "starting") {
          const snapshot = await pi.getThread(targetThreadId);
          if (snapshotContainsUserToken(snapshot, commandId)) {
            await writeFile(markerPath, `${JSON.stringify({ ...existingMarker, status: "sent" }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
            return { record, workspace, snapshot };
          }
        }

        const releasePrincipal = reserveThread(activePrincipalByThread, targetThreadId, principal);
        if (!releasePrincipal) throw new Error("review target thread is busy");
        try {
          await writeHostPrincipal(workspace, principal);
          await mkdir(path.dirname(markerPath), { recursive: true });
          const marker: ReviewFeedbackMarker = {
            schema: "mathpilot.review-feedback/v1",
            command_id: commandId,
            candidate_set_id: candidateSetId,
            target_thread_id: targetThreadId,
            status: "starting",
          };
          await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
          const skill = phase === "ktq" ? "ktq-extraction" : "er-research";
          await pi.sendMessage(targetThreadId, {
            content: [
              `[MathPilot review feedback ${commandId}]`,
              `候选集 ${candidateSetId} 已被教师退回。以下批注已经冻结：`,
              JSON.stringify(annotations),
              `请读取 ${skill} Skill，只修改批注涉及的内容并重新验证。再次调用 respond 时，结果顶层必须包含 \"supersedes_candidate_set_id\":\"${candidateSetId}\"；被修改实体沿用原实体 ID，以生成新的不可变修订。`,
            ].join("\n"),
          });
          await writeFile(markerPath, `${JSON.stringify({ ...marker, status: "sent" }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
          return { record, workspace, snapshot: await pi.getThread(targetThreadId) };
        } finally {
          releasePrincipal();
        }
      })().finally(() => {
        if (reviewFeedbackLocks.get(key) === operation) reviewFeedbackLocks.delete(key);
      });
      reviewFeedbackLocks.set(key, operation);
    }
    try {
      const result = await operation;
      return {
        command_id: commandId,
        candidate_set_id: candidateSetId,
        target_thread_id: targetThreadId,
        dispatched: true,
        replayed: result.snapshot.messages.length > 0,
      };
    } catch (error) {
      request.log.error({ err: error, commandId, targetThreadId }, "review feedback dispatch failed");
      return reply.code(502).send({ error: "review feedback dispatch failed" });
    }
  });

  app.get("/pi/models", async (request, reply) => {
    if (!principalOf(request)) return reply.code(401).send({ error: "trusted principal required" });
    return pi.getAvailableModels();
  });

  app.get("/pi/threads", async (request, reply) => {
    const principal = principalOf(request);
    if (!principal) return reply.code(401).send({ error: "trusted principal required" });
    const includeArchived = (request.query as { includeArchived?: string }).includeArchived === "true";
    const records = await store.list(principal);
    const restored = await Promise.all(records.map((record) => restoreArchivedThread(runtime, record, pi, objectStore)));
    const availableRecords = records.filter((_, index) => restored[index]);
    const lists = await Promise.all(availableRecords.map((record) => pi.listThreads({ workspacePath: workspaceOf(runtime, record), includeArchived })));
    return lists.flat();
  });

  app.post("/pi/threads", async (request, reply) => {
    const principal = principalOf(request);
    if (!principal) return reply.code(401).send({ error: "trusted principal required" });
    const workspaceId = randomUUID();
    const sessionDir = `sessions/${workspaceId}`;
    const workspacePath = path.join(runtime.sessionsRoot, workspaceId);
    await assemblePiChatWorkspace(workspacePath, runtime.skillsRoot);
    const input = (request.body ?? {}) as { title?: string };
    const snapshot = await pi.createThread({
      workspacePath,
      ...(typeof input.title === "string" ? { title: input.title } : {}),
    });
    await bindPiThreadWorkspace(workspacePath, snapshot.metadata.id);
    const absoluteSessionFile = snapshot.metadata.sessionFile;
    if (!absoluteSessionFile) {
      await pi.deleteThread(snapshot.metadata.id).catch(() => undefined);
      throw new Error("Pi did not return a session file for the new thread");
    }
    const sessionFile = path.relative(runtime.runtimeRoot, absoluteSessionFile);
    if (sessionFile.startsWith("..") || path.isAbsolute(sessionFile)) {
      await pi.deleteThread(snapshot.metadata.id).catch(() => undefined);
      throw new Error("Pi session file is outside the configured runtime root");
    }
    try {
      await store.create(principal, {
        threadId: snapshot.metadata.id,
        sessionDir,
        sessionFile,
      });
    } catch (error) {
      await pi.deleteThread(snapshot.metadata.id).catch(() => undefined);
      throw error;
    }
    return snapshot;
  });

  app.route({
    method: ["GET", "PATCH", "DELETE"],
    url: "/pi/threads/:threadId",
    async handler(request, reply) {
      const principal = principalOf(request);
      if (!principal) return reply.code(401).send({ error: "trusted principal required" });
      const { threadId } = request.params as { threadId: string };
      const record = await owned(store, principal, threadId, reply, request.method !== "GET", request.method === "DELETE");
      if (!record) return;
      if (request.method === "GET") {
        if (!await restoreArchivedThread(runtime, record, pi, objectStore)) {
          return reply.code(409).send({ error: "Pi thread session is not recoverable" });
        }
        return pi.getThread(threadId);
      }
      if (request.method === "PATCH") {
        const title = (request.body as { title?: unknown })?.title;
        if (typeof title !== "string" || !title.trim()) return reply.code(422).send({ error: "title required" });
        await pi.renameThread(threadId, title.trim());
        return reply.code(204).send();
      }
      await pi.deleteThread(threadId);
      await store.remove(principal, threadId);
      activePrincipalByThread.delete(threadId);
      await clearHostPrincipal(workspaceOf(runtime, record)).catch(() => undefined);
      return reply.code(204).send();
    },
  });

  app.post("/pi/threads/:threadId/messages", async (request, reply) => {
    const principal = principalOf(request);
    if (!principal) return reply.code(401).send({ error: "trusted principal required" });
    const { threadId } = request.params as { threadId: string };
    const record = await owned(store, principal, threadId, reply, true);
    if (!record) return;
    const releasePrincipal = reserveThread(activePrincipalByThread, threadId, principal);
    if (!releasePrincipal) return reply.code(409).send({ error: "thread is busy" });
    const { input } = (request.body ?? {}) as { input?: PiSendMessageInput & { mathpilotAttachmentIds?: unknown } };
    if (!input || typeof input.content !== "string") {
      releasePrincipal();
      return reply.code(422).send({ error: "message input required" });
    }
    const rawAttachmentIds = input.mathpilotAttachmentIds;
    if (rawAttachmentIds !== undefined && (
      !Array.isArray(rawAttachmentIds)
      || rawAttachmentIds.length === 0
      || rawAttachmentIds.length > 16
      || rawAttachmentIds.some((id) => typeof id !== "string" || !isAttachmentId(id))
      || new Set(rawAttachmentIds).size !== rawAttachmentIds.length
    )) {
      releasePrincipal();
      return reply.code(422).send({ error: "invalid attachment ids" });
    }
    const attachmentIds = (rawAttachmentIds ?? []) as string[];
    const { mathpilotAttachmentIds: _attachmentIds, ...piInput } = input;
    try {
      await writeHostPrincipal(workspaceOf(runtime, record), principal);
    } catch (error) {
      releasePrincipal();
      throw error;
    }
    // Keep the canonical user prompt byte-for-byte identical to the input sent by
    // react-pi. Its optimistic-message reconciliation keys on this text; adding a
    // workspace manifest here creates a second user message after the Pi echo.
    // Uploaded files are already available in input/original/, whose discovery
    // contract lives in the workspace AGENTS.md rather than in user-visible text.
    let turn: AttachmentTurn | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      if (attachmentIds.length > 0) {
        turn = {
          version: 1,
          id: randomUUID(),
          prompt: piInput.content,
          attachmentIds,
          createdAt: new Date().toISOString(),
        };
        await bindAttachmentTurn(workspaceOf(runtime, record), turn);
      }
      unsubscribe = pi.subscribe(threadId, (event) => {
        if (event.type !== "agent_end" || event.willRetry) return;
        unsubscribe?.();
        releasePrincipal();
        void publishWorkspaceArtifacts(workspaceOf(runtime, record), threadId).catch((error) => {
          request.log.error({ err: error, threadId }, "Pi learning artifact publication failed");
        });
      });
      await pi.sendMessage(threadId, piInput);
    } catch (error) {
      unsubscribe?.();
      releasePrincipal();
      if (turn) await releaseAttachmentTurn(workspaceOf(runtime, record), turn);
      throw error;
    }
    return reply.code(204).send();
  });

  app.get("/pi/threads/:threadId/artifacts/:artifactId/*", async (request, reply) => {
    const principal = principalOf(request);
    if (!principal) return reply.code(401).send({ error: "trusted principal required" });
    const { threadId, artifactId, "*": file } = request.params as { threadId: string; artifactId: string; "*": string };
    const record = await owned(store, principal, threadId, reply);
    if (!record) return;
    if (!await restoreArchivedThread(runtime, record, pi, objectStore)) {
      return reply.code(409).send({ error: "Pi thread session is not recoverable" });
    }
    const workspace = workspaceOf(runtime, record);
    try {
      // 正常路径在 agent_end 时已发布；这里的幂等发布覆盖用户立即点击和服务重启恢复。
      await publishWorkspaceArtifacts(workspace, threadId, artifactId);
      const result = await readPublishedArtifact(workspace, artifactId, file);
      if (!result) return reply.code(404).send({ error: "artifact not found" });
      const mime: Record<string, string> = {
        ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".svg": "image/svg+xml",
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
        ".mp4": "video/mp4", ".webm": "video/webm", ".woff": "font/woff", ".woff2": "font/woff2",
      };
      reply.header("content-type", mime[result.extension] ?? "application/octet-stream");
      reply.header("cache-control", "private, max-age=31536000, immutable");
      reply.header("x-content-type-options", "nosniff");
      if (result.extension === ".html") {
        reply.header("content-security-policy", "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; media-src 'self' data:; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
      }
      return reply.send(result.bytes);
    } catch (error) {
      request.log.error({ err: error, threadId, artifactId }, "Pi learning artifact read failed");
      return reply.code(404).send({ error: "artifact not found" });
    }
  });

  app.post("/pi/threads/:threadId/card-events", async (request, reply) => {
    const principal = principalOf(request);
    if (!principal) return reply.code(401).send({ error: "trusted principal required" });
    const { threadId } = request.params as { threadId: string };
    const record = await owned(store, principal, threadId, reply, true);
    if (!record) return;
    const body = request.body as {
      tool_call_id?: unknown;
      artifact_id?: unknown;
      card_id?: unknown;
      response_type?: unknown;
      payload?: unknown;
    };
    if (
      typeof body.tool_call_id !== "string"
      || typeof body.artifact_id !== "string"
      || !/^art_[A-Za-z0-9]{8,92}$/.test(body.artifact_id)
      || typeof body.card_id !== "string"
      || !/^card_[A-Za-z0-9]+$/.test(body.card_id)
      || !["submitted", "skipped", "bypassed_free_text"].includes(String(body.response_type))
      || !body.payload
      || typeof body.payload !== "object"
      || Array.isArray(body.payload)
    ) return reply.code(422).send({ error: "invalid card event" });

    // 不信任浏览器传来的 card/artifact 标识；只有当前 Pi 转录中真实存在且
    // 参数一致的题卡工具调用才能进入结构化审计表。
    const snapshot = await pi.getThread(threadId);
    const toolCalls = snapshot.messages.flatMap((message) => {
      if (message.role !== "assistant" || !("content" in message) || !Array.isArray(message.content)) return [];
      return message.content.filter((part): part is {
        type: "toolCall";
        id: string;
        name: string;
        arguments: Record<string, unknown>;
      } => Boolean(
        part && typeof part === "object"
        && "type" in part && part.type === "toolCall"
        && "id" in part && typeof part.id === "string"
        && "name" in part && typeof part.name === "string"
        && "arguments" in part && part.arguments !== null
        && typeof part.arguments === "object" && !Array.isArray(part.arguments)
      ));
    });
    const directCard = toolCalls.some((part) =>
      part.id === body.tool_call_id
      && part.name === "present_question_card"
      && part.arguments.artifact_id === body.artifact_id
      && part.arguments.card_id === body.card_id
    );
    const artifactTool = toolCalls.find((part) =>
      part.id === body.tool_call_id
      && part.name === "present_learning_artifact"
      && part.arguments.artifact_id === body.artifact_id
      && part.arguments.renderer === "native_card"
      && part.arguments.entry === "card.json"
    );
    let publishedArtifactCard = false;
    if (!directCard && artifactTool) {
      try {
        const workspace = workspaceOf(runtime, record);
        await publishWorkspaceArtifacts(workspace, threadId, body.artifact_id);
        const published = await readPublishedArtifact(workspace, body.artifact_id, "card.json");
        if (published) {
          const card = JSON.parse(published.bytes.toString("utf8")) as { card_id?: unknown };
          publishedArtifactCard = card.card_id === body.card_id;
        }
      } catch (error) {
        request.log.error({ err: error, threadId, artifactId: body.artifact_id }, "Pi question-card artifact verification failed");
      }
    }
    if (!directCard && !publishedArtifactCard) {
      return reply.code(422).send({ error: "card is not registered in this Pi thread" });
    }

    const event = await store.recordCardEvent(principal, {
      threadId,
      toolCallId: body.tool_call_id,
      artifactId: body.artifact_id,
      cardId: body.card_id,
      responseType: body.response_type as "submitted" | "skipped" | "bypassed_free_text",
      payload: body.payload as Record<string, unknown>,
    });
    return reply.code(event.created ? 201 : 200).send({
      event_id: event.eventId,
      response_type: body.response_type,
      duplicate: !event.created,
    });
  });

  // Browser uploads finish in MinIO.  The Pi host only receives the stable
  // object id, obtains a short-lived internal URL from storage-next, and
  // materializes a private read-only copy for the current model turn.
  app.post("/pi/threads/:threadId/files/from-object", async (request, reply) => {
    const principal = principalOf(request);
    if (!principal) return reply.code(401).send({ error: "trusted principal required" });
    const { threadId } = request.params as { threadId: string };
    const record = await owned(store, principal, threadId, reply, true);
    if (!record) return;
    const body = (request.body ?? {}) as { object_id?: unknown; attachment_id?: unknown };
    const objectId = typeof body.object_id === "string" ? body.object_id : "";
    const attachmentId = typeof body.attachment_id === "string" ? body.attachment_id : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attachmentId)) {
      return reply.code(422).send({ error: "valid attachment_id is required" });
    }
    try {
      const grant = await requestStorageGrant(principal, objectId, "runtime");
      const response = await fetch(grant.download_url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`storage download failed (${response.status})`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength !== grant.byte_size) throw new Error("storage object size changed during materialization");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (grant.sha256 && sha256 !== grant.sha256) throw new Error("storage object hash changed during materialization");

      const workspace = workspaceOf(runtime, record);
      const directory = path.join(workspace, "input", "original");
      await mkdir(directory, { recursive: true });
      const originalName = grant.original_name || "attachment";
      const extension = path.extname(safeAttachmentName(originalName));
      const stem = path.basename(safeAttachmentName(originalName), extension) || "attachment";
      let storedName = safeAttachmentName(originalName);
      for (let suffix = 1; ; suffix += 1) {
        try {
          const target = path.join(directory, storedName);
          await writeFile(target, bytes, { flag: "wx", mode: 0o400 });
          await chmod(target, 0o400);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          storedName = `${stem}-${suffix + 1}${extension}`;
        }
      }
      const workspacePath = `input/original/${storedName}`;
      try {
        await savePendingAttachment(workspace, {
          id: attachmentId,
          storageObjectId: grant.object_id,
          versionId: grant.version_id,
          sha256,
          originalName,
          workspacePath,
          mimeType: grant.mime_type,
          byteSize: bytes.byteLength,
          uploadedAt: new Date().toISOString(),
        });
        const persistedId = await store.createAttachment(principal, {
          attachmentId,
          threadId,
          storageObjectId: grant.object_id,
          workspacePath,
          originalName,
          mimeType: grant.mime_type,
          byteSize: bytes.byteLength,
          sha256,
        });
        return { id: persistedId, path: workspacePath, mimeType: grant.mime_type };
      } catch (error) {
        await rm(path.join(directory, storedName), { force: true }).catch(() => undefined);
        await removePendingAttachment(workspace, attachmentId).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      request.log.warn({ err: error, threadId, objectId }, "Pi storage attachment materialization failed");
      return reply.code(422).send({ error: "storage attachment rejected" });
    }
  });

  app.get("/pi/threads/:threadId/files/:attachmentId/download", async (request, reply) => {
    const principal = principalOf(request);
    if (!principal) return reply.code(401).send({ error: "trusted principal required" });
    const { threadId, attachmentId } = request.params as { threadId: string; attachmentId: string };
    const record = await owned(store, principal, threadId, reply);
    if (!record) return;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attachmentId)) return reply.code(404).send({ error: "file not found" });
    const attachment = await store.attachment(principal, threadId, attachmentId);
    if (!attachment) return reply.code(404).send({ error: "file not found" });
    if (!attachment.storageObjectId) return reply.code(404).send({ error: "file not found" });
    try {
      const grant = await requestStorageGrant(principal, attachment.storageObjectId, "public");
      return reply.redirect(grant.download_url, 302);
    } catch (error) {
      request.log.warn({ err: error, threadId, attachmentId }, "Pi storage attachment download grant failed");
      return reply.code(404).send({ error: "file not found" });
    }
  });

  app.post("/pi/threads/:threadId/cancel", async (request, reply) => {
    const principal = principalOf(request); if (!principal) return reply.code(401).send({ error: "trusted principal required" });
    const { threadId } = request.params as { threadId: string }; if (!(await owned(store, principal, threadId, reply, true))) return;
    await pi.cancelRun(threadId); return reply.code(204).send();
  });
  app.post("/pi/threads/:threadId/queue/clear", async (request, reply) => {
    const principal = principalOf(request); if (!principal) return reply.code(401).send({ error: "trusted principal required" });
    const { threadId } = request.params as { threadId: string }; if (!(await owned(store, principal, threadId, reply, true))) return;
    return pi.clearQueue(threadId);
  });
  app.post("/pi/threads/:threadId/model", async (request, reply) => {
    const principal = principalOf(request); if (!principal) return reply.code(401).send({ error: "trusted principal required" });
    const { threadId } = request.params as { threadId: string }; if (!(await owned(store, principal, threadId, reply, true))) return;
    await pi.setModel(threadId, request.body as { provider: string; modelId: string }); return reply.code(204).send();
  });
  app.post("/pi/threads/:threadId/thinking", async (request, reply) => {
    const principal = principalOf(request); if (!principal) return reply.code(401).send({ error: "trusted principal required" });
    const { threadId } = request.params as { threadId: string }; if (!(await owned(store, principal, threadId, reply, true))) return;
    await pi.setThinkingLevel(threadId, (request.body as { level: PiThinkingLevel }).level); return reply.code(204).send();
  });
  app.post("/pi/threads/:threadId/host-ui", async (request, reply) => {
    const principal = principalOf(request); if (!principal) return reply.code(401).send({ error: "trusted principal required" });
    const { threadId } = request.params as { threadId: string }; if (!(await owned(store, principal, threadId, reply, true))) return;
    await pi.respondToHostUiRequest(threadId, (request.body as { response: PiHostUiResponse }).response); return reply.code(204).send();
  });

  for (const action of ["archive", "unarchive"] as const) {
    app.post(`/pi/threads/:threadId/${action}`, async (request, reply) => {
      const principal = principalOf(request); if (!principal) return reply.code(401).send({ error: "trusted principal required" });
      const { threadId } = request.params as { threadId: string };
      const record = await owned(store, principal, threadId, reply, true); if (!record) return;
      const releasePrincipal = reserveThread(activePrincipalByThread, threadId, principal);
      if (!releasePrincipal) return reply.code(409).send({ error: "thread is busy" });
      try {
        if (action === "archive" && record.archivedAt) {
          await restoreArchivedThread(runtime, record, pi, objectStore);
          return reply.code(204).send();
        }
        if (action === "unarchive" && !record.archivedAt) {
          await pi.unarchiveThread(threadId);
          return reply.code(204).send();
        }
        if (action === "archive") {
          const workspace = workspaceOf(runtime, record);
          const sessionFile = sessionFileOf(runtime, record);
          const [workspaceExists, sessionFileExists] = await Promise.all([
            containedLocalEntryExists(runtime.sessionsRoot, workspace, "directory"),
            containedLocalEntryExists(runtime.agentSessionsRoot, sessionFile, "file"),
          ]);
          if (!workspaceExists || !sessionFileExists) {
            return reply.code(409).send({ error: "Pi thread session is not durable" });
          }
          await commitArchiveTransition({
            pi,
            store,
            principal,
            threadId,
            async createSnapshot() {
              if (!objectStore) return undefined;
              const key = `pi-threads/${threadId}/${randomUUID()}`;
              await objectStore.uploadDirectory(
                `${key}/workspace/`,
                workspace,
                runtime.sessionsRoot,
              );
              await objectStore.uploadFile(
                `${key}/session.jsonl`,
                sessionFile,
                runtime.agentSessionsRoot,
              );
              return key;
            },
          });
        } else {
          await commitUnarchiveTransition({
            pi,
            store,
            principal,
            threadId,
            async restoreSnapshot() {
              if (!await restoreArchivedThread(runtime, record, pi, objectStore)) {
                throw new Error("Pi thread session is not recoverable");
              }
            },
          });
        }
        return reply.code(204).send();
      } finally {
        releasePrincipal();
      }
    });
  }

  app.get("/pi/threads/:threadId/events", async (request, reply) => {
    const principal = principalOf(request);
    if (!principal) return reply.code(401).send({ error: "trusted principal required" });
    const { threadId } = request.params as { threadId: string };
    if (!(await owned(store, principal, threadId, reply))) return;
    const includeSnapshot = (request.query as { snapshot?: string }).snapshot !== "false";
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform",
      connection: "keep-alive", "x-accel-buffering": "no",
    });
    reply.raw.write(": connected\n\n");
    const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 20_000);
    const unsubscribe = pi.subscribe(threadId, (event) => {
      if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    }, { includeSnapshot });
    request.raw.on("close", () => {
      clearInterval(heartbeat); unsubscribe();
      if (!reply.raw.writableEnded) reply.raw.end();
    });
  });
}
