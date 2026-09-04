import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InternalActor, InternalServiceRuntime } from "@mathpilot/internal-service";
import { internalServiceContext, internalServiceGuard } from "@mathpilot/internal-service/fastify";
import type { FastifyInstance } from "fastify";
import { createHash, randomUUID } from "node:crypto";
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

const attachmentRefPattern = /^storage-object:(obj_[A-Za-z0-9]{8,})$/;

/** 从 storage-next 拉取教师私有对象并写入工作区 input/original/，返回可投喂模型的描述。 */
async function materializeTeacherAttachment(
  internalService: InternalServiceRuntime,
  actor: InternalActor,
  workspace: string,
  attachmentRef: string,
): Promise<{ workspacePath: string; note: string; objectId: string; originalName: string; mimeType: string; byteSize: number; sha256: string }> {
  const objectMatch = attachmentRefPattern.exec(attachmentRef);
  if (!objectMatch) throw new Error("invalid storage-object attachment reference");
  const objectId = objectMatch[1]!;
  const response = await internalService.request(
    "pi-to-storage",
    { tenantId: actor.tenantId, userId: actor.userId, roles: [...actor.roles] },
    `/internal/objects/${encodeURIComponent(objectId)}/presign-get`,
    { method: "POST", json: { audience: "runtime" }, timeoutMs: 30_000 },
  );
  if (!response.ok) throw new Error(`storage-next rejected an authorized object read (${response.status})`);
  const metadata = await response.json() as Record<string, unknown>;
  const originalName = typeof metadata.original_name === "string" ? metadata.original_name : objectId;
  const mimeType = typeof metadata.mime_type === "string" ? metadata.mime_type : "application/octet-stream";
  const byteSize = Number(metadata.byte_size);
  const sha256 = typeof metadata.sha256 === "string" ? metadata.sha256 : "";
  const downloadUrl = typeof metadata.download_url === "string" ? metadata.download_url : "";
  if (metadata.object_id !== objectId || !downloadUrl || !Number.isSafeInteger(byteSize) || byteSize < 1 || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error("storage-next object metadata does not match the attachment reference");
  }
  const download = await fetch(downloadUrl);
  if (!download.ok) throw new Error(`object download failed (${download.status})`);
  const content = Buffer.from(await download.arrayBuffer());
  if (content.byteLength !== byteSize) throw new Error("attachment object size changed");
  const digest = createHash("sha256").update(content).digest("hex");
  if (digest !== sha256) throw new Error("attachment object digest changed");

  const safeBase = originalName.replaceAll("\\", "/").split("/").pop() ?? "object";
  const safe = (safeBase.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^\.+$/, "") || "object").slice(0, 160);
  const workspacePath = `input/original/${objectId}_${safe}`;
  await mkdir(path.join(workspace, "input", "original"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(workspace, workspacePath), content, { flag: "wx", mode: 0o600 }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  return {
    workspacePath,
    note: `- ${workspacePath}（原名：${originalName}；MIME：${mimeType}；${byteSize} 字节；SHA-256：${sha256.slice(0, 12)}…）`,
    objectId,
    originalName,
    mimeType,
    byteSize,
    sha256,
  };
}

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
  const workspaceId = ((): string => {
    const hex = createHash("sha256").update(`mathpilot-er:${targetThreadId}`).digest("hex").slice(0, 32);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  })();
  const sessionDir = `sessions/${workspaceId}`;
  const workspacePath = path.join(runtime.sessionsRoot, workspaceId);
  await assemblePiChatWorkspace(workspacePath, runtime.skillsRoot);
  await mkdir(path.join(workspacePath, "input", "frozen"), { recursive: true });
  await bindPiThreadWorkspace(workspacePath, targetThreadId);

  let sessionFileAbsolute: string | undefined;
  // Pi 的 supervisor 只在按 cwd 编码的默认会话目录扫描会话；显式 sessionDir 会让
  // 会话文件落在扁平根目录导致 Unknown Pi thread。
  const discovered = await SessionManager.list(workspacePath).catch(() => []);
  const discoveredTarget = discovered.find((info) => info.id === targetThreadId);
  if (discoveredTarget) sessionFileAbsolute = discoveredTarget.path;
  if (!sessionFileAbsolute) {
    const manager = SessionManager.create(workspacePath, undefined, { id: targetThreadId });
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

  // --------------------------------------------------------------------------
  // 教师对话空间：教师用自有账号发起多轮 AI 对话（问题目/讲解）。
  // 独立会话（workspace + session + PiThreadStore 归属教师），不写入学生
  // learning-evidence / BKT 模型。消息走 Pi 官方 sendMessage/getThread。
  // --------------------------------------------------------------------------
  // pi_threads.session_dir 约束为 sessions/<36 位 uuid>；由 thread_id 派生稳定
  // uuid，使崩溃后的重试能回到同一工作区（确定性），同时不引入 DB 迁移。
  const teacherChatWorkspaceId = (threadId: string): string => {
    const hex = createHash("sha256").update(`mathpilot-teacher-chat:${threadId}`).digest("hex").slice(0, 32);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const teacherChatLocks = new Map<string, Promise<{ record: PiThreadRecord; snapshot: PiSnapshot }>>();

  app.get("/internal/teacher-chat/threads", { preHandler: contentGuard }, async (request, reply) => {
    const actor = internalServiceContext(request).actor;
    if (!actor.roles.includes("teacher")) return reply.code(403).send({ error: "teacher principal required" });
    const threads = await store.list(piPrincipal(actor));
    // 教师对话空间只展示教师本人拥有的会话；ACL 授予的读权限（例如学生证据）
    // 不能混入该列表，避免把学生学习线程误当作教师对话打开。
    return threads
      .filter((thread) => thread.ownerUserId === actor.userId)
      .map((thread) => ({
        thread_id: thread.threadId,
        created_at: thread.createdAt,
        archived_at: thread.archivedAt ?? null,
      }));
  });

  const ktqStartLocks = new Map<string, Promise<{ dispatched: boolean; replayed: boolean }>>();

  app.post("/internal/ktq-start", { preHandler: contentGuard }, async (request, reply) => {
    const actor = internalServiceContext(request).actor;
    if (!actor.roles.includes("teacher")) return reply.code(403).send({ error: "teacher principal required" });
    const principal = piPrincipal(actor);
    const body = (request.body ?? {}) as { command_id?: unknown; target_thread_id?: unknown; chapter_id?: unknown };
    const commandId = typeof body.command_id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(body.command_id) ? body.command_id : "";
    const targetThreadId = typeof body.target_thread_id === "string" ? body.target_thread_id : "";
    const chapterId = typeof body.chapter_id === "string" && body.chapter_id.trim() ? body.chapter_id.trim().slice(0, 127) : null;
    if (!commandId || !targetThreadId) return reply.code(422).send({ error: "command_id and target_thread_id are required" });
    const key = `${principal.tenantId}\u0000${commandId}`;
    let operation = ktqStartLocks.get(key);
    if (!operation) {
      operation = (async () => {
        const record = await store.deletable(principal, targetThreadId);
        if (!record) throw new Error("ktq target teacher chat thread is not owned by this teacher");
        if (!await localThreadAvailable(runtime, record, pi)) throw new Error("ktq target session is not recoverable");
        const workspace = workspaceOf(runtime, record);
        const markerPath = path.join(workspace, "input", "session", "ktq-start.json");
        type KtqStartMarker = { schema: string; command_id: string; chapter_id: string | null; status: "starting" | "sent" };
        const readMarker = async (): Promise<KtqStartMarker | undefined> => {
          try {
            const value = JSON.parse(await readFile(markerPath, "utf8")) as Partial<KtqStartMarker>;
            if (value.schema !== "mathpilot.ktq-start/v1" || typeof value.command_id !== "string" || value.status !== "starting" && value.status !== "sent") return undefined;
            return value as KtqStartMarker;
          } catch {
            return undefined;
          }
        };
        const existing = await readMarker();
        if (existing && (existing.command_id !== commandId || existing.chapter_id !== chapterId)) {
          throw new Error("target thread already assigned to another KTQ command");
        }
        const releasePrincipal = reserveThread(activePrincipalByThread, targetThreadId, principal);
        if (!releasePrincipal) throw new Error("ktq target teacher chat thread is busy");
        try {
          if (existing?.status === "sent") return { dispatched: true, replayed: true };
          if (existing?.status === "starting") {
            const snapshot = await pi.getThread(targetThreadId);
            if (snapshotContainsUserToken(snapshot, commandId)) {
              await writeFile(markerPath, `${JSON.stringify({ ...existing, status: "sent" }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
              return { dispatched: true, replayed: true };
            }
          }
          await writeHostPrincipal(workspace, actor);
          await mkdir(path.dirname(markerPath), { recursive: true, mode: 0o700 });
          const marker: KtqStartMarker = {
            schema: "mathpilot.ktq-start/v1",
            command_id: commandId,
            chapter_id: chapterId,
            status: "starting",
          };
          await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
          const sourceFiles = (await readdir(path.join(workspace, "input", "original")).catch(() => []))
            .filter((name) => !name.startsWith("."))
            .map((name) => `input/original/${name}`);
          const scopeNote = chapterId ? `章节：${chapterId}` : "按源文件实际内容识别章节（默认解三角形）";
          await pi.sendMessage(targetThreadId, {
            content: [
              `[MathPilot KTQ start ${commandId}]`,
              `这是一次教师私有资料的 KTQ 抽取。来源文件：${sourceFiles.length ? sourceFiles.join("、") : "（该线程尚未绑定文件，请先上传资料再解析）"}`,
              scopeNote,
              "请读取 ktq-extraction Skill，只从上述源文件抽取知识点/题型/题目；不要修改源文件，也不要直接发布内容。完成后调用 respond 注册 phase=ktq 的候选集。",
              "请全程使用简体中文回复，不要在回复中夹杂英文。",
            ].join("\n"),
          });
          await writeFile(markerPath, `${JSON.stringify({ ...marker, status: "sent" }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
          const snapshot = await pi.getThread(targetThreadId);
          return { dispatched: true, replayed: snapshot.messages.length > 0 };
        } finally {
          releasePrincipal();
        }
      })().finally(() => {
        if (ktqStartLocks.get(key) === operation) ktqStartLocks.delete(key);
      });
      ktqStartLocks.set(key, operation);
    }
    try {
      return await operation;
    } catch (error) {
      request.log.error({ err: error, commandId, targetThreadId }, "KTQ start dispatch failed");
      return reply.code(502).send({ error: "KTQ start dispatch failed" });
    }
  });

  app.post("/internal/teacher-chat/threads", { preHandler: contentGuard }, async (request, reply) => {
    const actor = internalServiceContext(request).actor;
    if (!actor.roles.includes("teacher")) return reply.code(403).send({ error: "teacher principal required" });
    const principal = piPrincipal(actor);
    const body = (request.body ?? {}) as { thread_id?: unknown };
    const threadId = typeof body.thread_id === "string" && /^thr_[A-Za-z0-9]{8,}$/.test(body.thread_id)
      ? body.thread_id
      : `thr_${randomUUID().replaceAll("-", "")}`;
    const key = `${principal.tenantId}\u0000${threadId}`;
    let operation = teacherChatLocks.get(key);
    if (!operation) {
      operation = (async () => {
        const existing = await store.deletable(principal, threadId);
        if (existing) return { record: existing, snapshot: await pi.getThread(threadId) };
        const workspaceId = teacherChatWorkspaceId(threadId);
        const sessionDir = `sessions/${workspaceId}`;
        const workspacePath = path.join(runtime.sessionsRoot, workspaceId);
        await assemblePiChatWorkspace(workspacePath, runtime.skillsRoot);
        await bindPiThreadWorkspace(workspacePath, threadId);
        await mkdir(path.join(workspacePath, "input", "frozen"), { recursive: true });

        let sessionFileAbsolute: string | undefined;
        // Pi 的 supervisor 只在按 cwd 编码的默认会话目录（agent/sessions/<encoded>/）
        // 中扫描会话；显式把 sessionDir 指到 agentSessionsRoot 会让会话文件落在
        // 扁平根目录，Pi 无法发现（openCold 报 Unknown Pi thread）。
        const discovered = await SessionManager.list(workspacePath).catch(() => []);
        const discoveredTarget = discovered.find((info) => info.id === threadId);
        if (discoveredTarget) sessionFileAbsolute = discoveredTarget.path;
        if (!sessionFileAbsolute) {
          const manager = SessionManager.create(workspacePath, undefined, { id: threadId });
          sessionFileAbsolute = manager.getSessionFile();
          const header = manager.getHeader();
          if (!sessionFileAbsolute || !header) throw new Error("Pi did not allocate a teacher chat session file");
          await writeFile(sessionFileAbsolute, `${JSON.stringify(header)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }).catch((error) => {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          });
        }
        const relativeSessionFile = path.relative(runtime.runtimeRoot, sessionFileAbsolute);
        if (relativeSessionFile.startsWith("..") || path.isAbsolute(relativeSessionFile)) {
          throw new Error("teacher chat session file is outside runtime root");
        }
        const record = await store.create(principal, { threadId, sessionDir, sessionFile: relativeSessionFile });
        // 干净开局：只分配 workspace + 会话文件（Pi 可按 header 打开空会话），
        // 不发送种子消息，避免一次空对话消耗一次模型调用，也让教师的第一句话
        // 就是真正的首条 user 消息。AGENTS.md 已注入数学教学 Agent 身份。
        await writeHostPrincipal(workspacePath, actor);
        return {
          record,
          snapshot: {
            metadata: { id: threadId, status: "idle", messageCount: 0 },
            messages: [],
          } as PiSnapshot,
        };
      })().finally(() => {
        if (teacherChatLocks.get(key) === operation) teacherChatLocks.delete(key);
      });
      teacherChatLocks.set(key, operation);
    }
    try {
      const result = await operation;
      return {
        thread_id: result.record.threadId,
        created: true,
        messages: result.snapshot.messages,
      };
    } catch (error) {
      request.log.error({ err: error, threadId }, "teacher chat thread creation failed");
      return reply.code(502).send({ error: "teacher chat thread creation failed" });
    }
  });

  app.post("/internal/teacher-chat/threads/:threadId/messages", { preHandler: contentGuard }, async (request, reply) => {
    const actor = internalServiceContext(request).actor;
    if (!actor.roles.includes("teacher")) return reply.code(403).send({ error: "teacher principal required" });
    const principal = piPrincipal(actor);
    const threadId = String((request.params as Record<string, unknown>).threadId ?? "");
    const body = (request.body ?? {}) as { content?: unknown; attachments?: unknown };
    const content = typeof body.content === "string" && body.content.trim() ? body.content.trim() : "";
    // 附件来自前端按 storage-object:obj_… 形式提交的对象引用，随消息一起绑定进工作区。
    const rawAttachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 5) : [];
    const attachments: string[] = [];
    for (const value of rawAttachments) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const attachmentRef = String((value as Record<string, unknown>).attachment_ref ?? "");
      if (attachmentRefPattern.test(attachmentRef) && !attachments.includes(attachmentRef)) attachments.push(attachmentRef);
    }
    if (!content && attachments.length === 0) {
      return reply.code(422).send({ error: "content or an attachment is required" });
    }
    if (content.length > 50_000) {
      return reply.code(422).send({ error: "content is limited to 50000 characters" });
    }
    const key = `${principal.tenantId}\u0000${threadId}`;
    let operation = teacherChatLocks.get(key);
    if (!operation) {
      operation = (async () => {
        // 只允许教师在“自己拥有”的会话中发消息，ACL 写入（学生证据等）不适用。
        const record = await store.deletable(principal, threadId);
        if (!record) throw new Error("teacher chat thread is not owned by this teacher");
        if (!await localThreadAvailable(runtime, record, pi)) throw new Error("teacher chat session is not recoverable");
        const workspace = workspaceOf(runtime, record);
        const releasePrincipal = reserveThread(activePrincipalByThread, threadId, principal);
        if (!releasePrincipal) throw new Error("teacher chat thread is busy");
        try {
          await writeHostPrincipal(workspace, actor);
          let prompt = content;
          if (attachments.length > 0) {
            const files: string[] = [];
            let totalBytes = 0;
            for (const attachmentRef of attachments) {
              const materialized = await materializeTeacherAttachment(internalService, actor, workspace, attachmentRef);
              if (totalBytes + materialized.byteSize > 48 * 1024 * 1024) throw new Error("teacher chat attachments exceed 48 MiB per turn");
              totalBytes += materialized.byteSize;
              files.push(materialized.note);
              await store.createAttachment(principal, {
                attachmentId: randomUUID(),
                threadId,
                workspacePath: materialized.workspacePath,
                originalName: materialized.originalName,
                mimeType: materialized.mimeType,
                byteSize: materialized.byteSize,
                sha256: materialized.sha256,
                storageObjectId: materialized.objectId,
              });
            }
            prompt = `${content || "请阅读随消息附带的文件。"}\n\n本次消息附带文件：\n${files.join("\n")}\n请按需读取这些文件（例如先用内容工具查看 PDF 或图片版面）。\n请全程使用简体中文回复，不要在回复中夹杂英文。`;
          }
          await pi.sendMessage(threadId, { content: prompt });
          return { record, snapshot: await pi.getThread(threadId) };
        } finally {
          releasePrincipal();
        }
      })().finally(() => {
        if (teacherChatLocks.get(key) === operation) teacherChatLocks.delete(key);
      });
      teacherChatLocks.set(key, operation);
    }
    try {
      const result = await operation;
      return {
        thread_id: result.record.threadId,
        messages: result.snapshot.messages,
      };
    } catch (error) {
      request.log.error({ err: error, threadId }, "teacher chat send failed");
      return reply.code(502).send({ error: "teacher chat send failed" });
    }
  });

  app.get("/internal/teacher-chat/threads/:threadId", { preHandler: contentGuard }, async (request, reply) => {
    const actor = internalServiceContext(request).actor;
    if (!actor.roles.includes("teacher")) return reply.code(403).send({ error: "teacher principal required" });
    const principal = piPrincipal(actor);
    const threadId = String((request.params as Record<string, unknown>).threadId ?? "");
    const record = await store.deletable(principal, threadId);
    if (!record) return reply.code(404).send({ error: "thread not found" });
    try {
      const snapshot = await pi.getThread(threadId);
      return {
        thread_id: record.threadId,
        messages: snapshot.messages,
      };
    } catch (error) {
      request.log.error({ err: error, threadId }, "teacher chat read failed");
      return reply.code(502).send({ error: "teacher chat read failed" });
    }
  });
}
