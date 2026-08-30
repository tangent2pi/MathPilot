import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PiClient, PiHostUiResponse, PiSendMessageInput, PiThinkingLevel } from "@assistant-ui/react-pi";
import { PiThreadStore, type PiPrincipal, type PiThreadRecord } from "./pi-thread-store.ts";
import { PiObjectStore } from "./pi-object-store.ts";
import { assemblePiChatWorkspace, bindPiThreadWorkspace } from "./pi-chat-workspace.ts";
import { publishWorkspaceArtifacts, readPublishedArtifact } from "./artifact-publisher.ts";
import type { PiChatRuntime } from "./pi-chat-server.ts";
import {
  bindAttachmentTurn,
  isAttachmentId,
  releaseAttachmentTurn,
  savePendingAttachment,
  type AttachmentTurn,
} from "../extensions/attachments/manifest.ts";

const principalOf = (request: FastifyRequest): PiPrincipal | undefined => {
  const expectedSecret = process.env.PI_GATEWAY_SECRET;
  const actualSecret = request.headers["x-mathpilot-gateway-secret"];
  if (!expectedSecret || actualSecret !== expectedSecret) return undefined;
  const tenantId = request.headers["x-tenant-id"];
  const userId = request.headers["x-user-id"];
  const roles = request.headers["x-user-roles"];
  const accessibleStudents = request.headers["x-accessible-student-ids"];
  if (typeof tenantId !== "string" || typeof userId !== "string") return undefined;
  return {
    tenantId,
    userId,
    roles: typeof roles === "string" ? roles.split(",").filter(Boolean) : [],
    accessibleStudentIds: typeof accessibleStudents === "string" ? accessibleStudents.split(",").filter(Boolean) : [],
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

const downloadDisposition = (name: string): string => {
  const filename = path.basename(name).replace(/[\u0000-\u001f\u007f]/g, "") || "attachment";
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
};

const restoreArchivedThread = async (
  runtime: PiChatRuntime,
  record: PiThreadRecord,
  objectStore?: PiObjectStore,
): Promise<void> => {
  if (!objectStore || !record.minioKey) return;
  const workspace = workspaceOf(runtime, record);
  const sessionFile = sessionFileOf(runtime, record);
  if (!existsSync(workspace)) await objectStore.downloadDirectory(`${record.minioKey}/workspace/`, workspace);
  if (!existsSync(sessionFile)) await objectStore.downloadFile(`${record.minioKey}/session.jsonl`, sessionFile);
};

const owned = async (
  store: PiThreadStore,
  principal: PiPrincipal,
  threadId: string,
  reply: FastifyReply,
  write = false,
): Promise<PiThreadRecord | undefined> => {
  const record = await store.accessible(principal, threadId, write);
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

  app.addHook("onClose", async () => store.close());

  app.get("/pi/models", async (request, reply) => {
    if (!principalOf(request)) return reply.code(401).send({ error: "trusted principal required" });
    return pi.getAvailableModels();
  });

  app.get("/pi/threads", async (request, reply) => {
    const principal = principalOf(request);
    if (!principal) return reply.code(401).send({ error: "trusted principal required" });
    const includeArchived = (request.query as { includeArchived?: string }).includeArchived === "true";
    const records = await store.list(principal);
    await Promise.all(records.map((record) => restoreArchivedThread(runtime, record, objectStore)));
    const lists = await Promise.all(records.map((record) => pi.listThreads({ workspacePath: workspaceOf(runtime, record), includeArchived })));
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
        studentId: principal.userId,
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
      const record = await owned(store, principal, threadId, reply, request.method !== "GET");
      if (!record) return;
      if (request.method === "GET") {
        await restoreArchivedThread(runtime, record, objectStore);
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
      return reply.code(204).send();
    },
  });

  app.post("/pi/threads/:threadId/messages", async (request, reply) => {
    const principal = principalOf(request);
    if (!principal) return reply.code(401).send({ error: "trusted principal required" });
    const { threadId } = request.params as { threadId: string };
    const record = await owned(store, principal, threadId, reply, true);
    if (!record) return;
    const { input } = request.body as { input: PiSendMessageInput & { mathpilotAttachmentIds?: unknown } };
    if (!input || typeof input.content !== "string") return reply.code(422).send({ error: "message input required" });
    const rawAttachmentIds = input.mathpilotAttachmentIds;
    if (rawAttachmentIds !== undefined && (
      !Array.isArray(rawAttachmentIds)
      || rawAttachmentIds.length === 0
      || rawAttachmentIds.length > 16
      || rawAttachmentIds.some((id) => typeof id !== "string" || !isAttachmentId(id))
      || new Set(rawAttachmentIds).size !== rawAttachmentIds.length
    )) return reply.code(422).send({ error: "invalid attachment ids" });
    const attachmentIds = (rawAttachmentIds ?? []) as string[];
    const { mathpilotAttachmentIds: _attachmentIds, ...piInput } = input;
    // Keep the canonical user prompt byte-for-byte identical to the input sent by
    // react-pi. Its optimistic-message reconciliation keys on this text; adding a
    // workspace manifest here creates a second user message after the Pi echo.
    // Uploaded files are already available in input/original/, whose discovery
    // contract lives in the workspace AGENTS.md rather than in user-visible text.
    let turn: AttachmentTurn | undefined;
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
    let unsubscribe: (() => void) | undefined;
    unsubscribe = pi.subscribe(threadId, (event) => {
      if (event.type !== "agent_end" || event.willRetry) return;
      unsubscribe?.();
      void publishWorkspaceArtifacts(workspaceOf(runtime, record), threadId).catch((error) => {
        request.log.error({ err: error, threadId }, "Pi learning artifact publication failed");
      });
    });
    try {
      await pi.sendMessage(threadId, piInput);
    } catch (error) {
      unsubscribe?.();
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
    await restoreArchivedThread(runtime, record, objectStore);
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
      studentId: record.studentId,
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

  app.post("/pi/threads/:threadId/files", async (request, reply) => {
    const principal = principalOf(request);
    if (!principal) return reply.code(401).send({ error: "trusted principal required" });
    const { threadId } = request.params as { threadId: string };
    const record = await owned(store, principal, threadId, reply, true);
    if (!record) return;
    const { name, data, mimeType } = request.body as { name?: string; data?: string; mimeType?: string };
    if (!name || !data || data.length > 32 * 1024 * 1024) return reply.code(422).send({ error: "valid file required" });
    const safeName = path.basename(name).replace(/[^\p{L}\p{N}._-]+/gu, "_");
    const workspace = workspaceOf(runtime, record);
    const directory = path.join(workspace, "input", "original");
    await mkdir(directory, { recursive: true });
    const encoded = data.includes(",") ? data.slice(data.indexOf(",") + 1) : data;
    const bytes = Buffer.from(encoded, "base64");
    const extension = path.extname(safeName);
    const stem = path.basename(safeName, extension) || "attachment";
    let storedName = safeName || "attachment";
    for (let suffix = 1; ; suffix += 1) {
      try {
        await writeFile(path.join(directory, storedName), bytes, { flag: "wx" });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        storedName = `${stem}-${suffix + 1}${extension}`;
      }
    }
    const uploadId = randomUUID();
    const resolvedMimeType = typeof mimeType === "string" && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(mimeType)
      ? mimeType.toLowerCase()
      : "application/octet-stream";
    const workspacePath = `input/original/${storedName}`;
    try {
      await savePendingAttachment(workspace, {
        id: uploadId,
        originalName: name,
        workspacePath,
        mimeType: resolvedMimeType,
        byteSize: bytes.byteLength,
        uploadedAt: new Date().toISOString(),
      });
    } catch (error) {
      await rm(path.join(directory, storedName), { force: true }).catch(() => undefined);
      throw error;
    }
    return { id: uploadId, path: workspacePath, mimeType: resolvedMimeType };
  });

  app.get("/pi/threads/:threadId/files/download", async (request, reply) => {
    const principal = principalOf(request);
    if (!principal) return reply.code(401).send({ error: "trusted principal required" });
    const { threadId } = request.params as { threadId: string };
    const record = await owned(store, principal, threadId, reply);
    if (!record) return;
    await restoreArchivedThread(runtime, record, objectStore);

    const query = request.query as { path?: unknown; name?: unknown };
    if (typeof query.path !== "string") return reply.code(422).send({ error: "file path required" });
    const workspacePath = query.path.replaceAll("\\", "/");
    if (path.posix.dirname(workspacePath) !== "input/original") {
      return reply.code(404).send({ error: "file not found" });
    }
    const originalRoot = path.resolve(workspaceOf(runtime, record), "input", "original");
    const absoluteFile = path.resolve(workspaceOf(runtime, record), workspacePath);
    if (path.dirname(absoluteFile) !== originalRoot) return reply.code(404).send({ error: "file not found" });

    let bytes: Buffer;
    try {
      bytes = await readFile(absoluteFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return reply.code(404).send({ error: "file not found" });
      }
      throw error;
    }
    const requestedName = typeof query.name === "string" ? query.name : path.basename(absoluteFile);
    return reply
      .header("content-type", "application/octet-stream")
      .header("content-disposition", downloadDisposition(requestedName))
      .header("cache-control", "private, no-store")
      .header("x-content-type-options", "nosniff")
      .send(bytes);
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
      if (action === "archive") {
        const sessionFile = sessionFileOf(runtime, record);
        // Pi 在首条消息前不会落下 JSONL；这种空线程没有会话内容可归档。
        if (objectStore && existsSync(sessionFile)) {
          const key = `pi-threads/${threadId}`;
          await objectStore.uploadDirectory(`${key}/workspace/`, workspaceOf(runtime, record));
          await objectStore.uploadFile(`${key}/session.jsonl`, sessionFile);
          await store.setMinioKey(principal, threadId, key);
        }
        await pi.archiveThread(threadId); await store.markArchived(principal, threadId, true);
      } else {
        await pi.unarchiveThread(threadId); await store.markArchived(principal, threadId, false);
      }
      return reply.code(204).send();
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
