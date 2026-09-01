import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InternalActor, InternalServiceRuntime } from "@mathpilot/internal-service";
import { internalServiceContext, internalServiceGuard } from "@mathpilot/internal-service/fastify";
import type { FastifyInstance } from "fastify";
import type { PiClient } from "@assistant-ui/react-pi";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiThreadStore, type PiPrincipal, type PiThreadRecord } from "./pi-thread-store.ts";
import { assemblePiChatWorkspace, bindPiThreadWorkspace } from "./pi-chat-workspace.ts";
import type { PiChatRuntime } from "./pi-chat-server.ts";
import { writeHostPrincipal } from "../extensions/lib/host-principal.ts";

// The host principal is deliberately persisted outside the model workspace so
// extensions can read it without exposing it to Bash. A thread must therefore
// have at most one in-flight turn: otherwise two internal dispatches could
// overwrite that file while Pi is still executing the first turn.
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

export const localThreadAvailable = async (
  runtime: PiChatRuntime,
  record: PiThreadRecord,
  pi: PiClient,
): Promise<boolean> => {
  // The retired archive protocol is intentionally not a compatibility path.
  // Current Content dispatches operate only on live, locally durable Pi state.
  if (record.archivedAt || record.minioKey) return false;
  const workspace = workspaceOf(runtime, record);
  const sessionFile = sessionFileOf(runtime, record);
  const workspaceExists = await containedLocalEntryExists(runtime.sessionsRoot, workspace, "directory");
  const sessionFileExists = await containedLocalEntryExists(runtime.agentSessionsRoot, sessionFile, "file");
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
  return true;
};

const piPrincipal = (actor: InternalActor): PiPrincipal => ({
  tenantId: actor.tenantId,
  userId: actor.userId,
  roles: [...actor.roles],
});

export function registerPiChatRoutes(
  app: FastifyInstance,
  runtime: PiChatRuntime,
  store: PiThreadStore,
  internalService: InternalServiceRuntime,
): void {
  const pi: PiClient = runtime.client;
  const activePrincipalByThread = new Map<string, string>();
  const contentGuard = internalServiceGuard(internalService, ["content-to-pi"]);

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

  app.post("/internal/er-start", { preHandler: contentGuard }, async (request, reply) => {
    const actor = internalServiceContext(request).actor;
    if (!actor.roles.includes("teacher")) return reply.code(403).send({ error: "teacher principal required" });
    const principal = piPrincipal(actor);
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

        const frozenResponse = await internalService.request(
          "pi-to-content",
          actor,
          `/internal/candidates/${encodeURIComponent(candidateSetId)}/frozen`,
          { timeoutMs: 30_000 },
        );
        if (!frozenResponse.ok) throw new Error(`approved KTQ handoff lookup failed (${frozenResponse.status})`);
        const frozen = await frozenResponse.json() as Record<string, unknown>;
        await mkdir(path.dirname(markerPath), { recursive: true });
        await writeFile(path.join(workspace, "input", "frozen", "ktq.json"), `${JSON.stringify(frozen, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await writeHostPrincipal(workspace, actor);

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

  app.post("/internal/review-feedback", { preHandler: contentGuard }, async (request, reply) => {
    const actor = internalServiceContext(request).actor;
    if (!actor.roles.includes("teacher")) return reply.code(403).send({ error: "teacher principal required" });
    const principal = piPrincipal(actor);
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
        if (!await localThreadAvailable(runtime, record, pi)) {
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
          await writeHostPrincipal(workspace, actor);
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
}
