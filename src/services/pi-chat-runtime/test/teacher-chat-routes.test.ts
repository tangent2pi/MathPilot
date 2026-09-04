import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { InternalAssertionCodec, createInternalServiceRuntime } from "@mathpilot/internal-service";
import { internalServiceTestEnvironment } from "@mathpilot/internal-service/testing";
import type { PiClient } from "@assistant-ui/react-pi";
import { registerPiChatRoutes } from "../src/pi-chat-routes.ts";
import type { PiPrincipal, PiThreadRecord, PiThreadStore } from "../src/pi-thread-store.ts";

const teacher: PiPrincipal = Object.freeze({
  tenantId: "tnt_teacher_chat",
  userId: "usr_teacher_chat",
  roles: ["teacher"],
});

const student: PiPrincipal = Object.freeze({
  tenantId: "tnt_teacher_chat",
  userId: "usr_student_chat",
  roles: ["student"],
});

// 假 Pi：多轮转录保存在内存中，getThread 返回完整消息序列；sendMessage 模拟
// “用户提问 + 助手答复” 的一次完整往返。真实路径里的 workspace/session 文件由
// 真实 SessionManager 落盘，Pi 客户端本身不在此冒烟测试中执行模型调用。
const makeFakePi = () => {
  const transcripts = new Map<string, unknown[]>();
  const client: Pick<PiClient, "getThread" | "sendMessage"> = {
    async getThread(threadId) {
      return { metadata: { id: threadId }, messages: transcripts.get(threadId) ?? [] };
    },
    async sendMessage(threadId, input) {
      const messages = transcripts.get(threadId) ?? [];
      messages.push({ role: "user", content: input.content, timestamp: Date.now() });
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: `已收到：${input.content}` }],
        api: "mathpilot-deepseek",
        provider: "mathpilot-deepseek",
        model: "mathpilot-main",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      transcripts.set(threadId, messages);
    },
  };
  return { client, transcripts };
};

// 假 PiThreadStore：内存表，按 owner_user_id 归属线程，与学生学习证据隔离语义一致。
const makeFakeStore = () => {
  const rows = new Map<string, PiThreadRecord>();
  const store = {
    async create(principal: PiPrincipal, value: { threadId: string; sessionDir: string; sessionFile: string }): Promise<PiThreadRecord> {
      const record: PiThreadRecord = {
        threadId: value.threadId,
        tenantId: principal.tenantId,
        ownerUserId: principal.userId,
        sessionDir: value.sessionDir,
        sessionFile: value.sessionFile,
        createdAt: new Date().toISOString(),
      };
      rows.set(value.threadId, record);
      return record;
    },
    async accessible(principal: PiPrincipal, threadId: string): Promise<PiThreadRecord | undefined> {
      const record = rows.get(threadId);
      return record && record.tenantId === principal.tenantId && record.ownerUserId === principal.userId ? record : undefined;
    },
    async deletable(principal: PiPrincipal, threadId: string): Promise<PiThreadRecord | undefined> {
      return this.accessible(principal, threadId);
    },
    async list(principal: PiPrincipal): Promise<PiThreadRecord[]> {
      return [...rows.values()]
        .filter((record) => record.tenantId === principal.tenantId && record.ownerUserId === principal.userId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async close(): Promise<void> {},
  };
  return store as unknown as PiThreadStore;
};

const harness = async () => {
  const source = internalServiceTestEnvironment();
  const content = createInternalServiceRuntime("content-next", source);
  const piRuntime = createInternalServiceRuntime("pi-chat-runtime", source);
  const app = Fastify();
  const root = await mkdtemp(path.join(os.tmpdir(), "mathpilot-teacher-chat-"));
  const sessionsRoot = path.join(root, "sessions");
  const agentDir = path.join(root, "agent");
  const agentSessionsRoot = path.join(agentDir, "sessions");
  const skillsRoot = path.join(root, "skills");
  // Pi 默认会话目录 = <agentDir>/sessions/<encoded-cwd>/；模拟生产 createPiChatRuntime
  // 的设置，让 SessionManager 默认把会话文件写进测试目录而不是用户 ~/.pi。
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await Promise.all([
    mkdir(sessionsRoot, { recursive: true }),
    mkdir(agentSessionsRoot, { recursive: true }),
    mkdir(skillsRoot, { recursive: true }),
  ]);
  const { client } = makeFakePi();
  const store = makeFakeStore();
  registerPiChatRoutes(
    app,
    { client, runtimeRoot: root, sessionsRoot, agentSessionsRoot, skillsRoot } as never,
    store,
    piRuntime,
  );
  const codec = new InternalAssertionCodec(content.configuration);
  const issue = async (actor: PiPrincipal, method: string, requestPath: string, body?: unknown) =>
    codec.issue("content-to-pi", actor, { method, path: requestPath, ...(body === undefined ? {} : { body }) });
  const inject = async (token: string, method: string, requestPath: string, body?: unknown) =>
    app.inject({
      method,
      url: requestPath,
      headers: { authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { payload: body }),
    });
  return {
    root,
    sessionsRoot,
    agentSessionsRoot,
    app,
    issue,
    inject,
    cleanup: async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    },
  };
};

test("teacher chat: create/send/read round-trips with multi-turn memory", async () => {
  const h = await harness();
  try {
    // 非教师身份被拒绝。
    const studentToken = await h.issue(student, "POST", "/internal/teacher-chat/threads");
    const forbidden = await h.inject(studentToken, "POST", "/internal/teacher-chat/threads");
    assert.equal(forbidden.statusCode, 403);

    // 教师建会话：返回空转录（干净开局，不消耗模型调用）。
    const createToken = await h.issue(teacher, "POST", "/internal/teacher-chat/threads");
    const created = await h.inject(createToken, "POST", "/internal/teacher-chat/threads");
    assert.equal(created.statusCode, 200);
    const createdBody = created.json();
    assert.match(String(createdBody.thread_id), /^thr_/);
    assert.equal(createdBody.created, true);
    assert.deepEqual(createdBody.messages, []);
    const threadId = String(createdBody.thread_id);

    // 空会话 header 已按 Pi 默认会话目录落盘（agent/sessions/<encoded>/…jsonl），
    // supervisor 扫描时能找到，重启后也可重新打开。
    const findJsonl = async (directory: string): Promise<string | undefined> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          const hit = await findJsonl(candidate);
          if (hit) return hit;
        } else if (entry.name.endsWith(".jsonl")) {
          return candidate;
        }
      }
      return undefined;
    };
    const sessionFile = await findJsonl(h.agentSessionsRoot);
    assert.ok(sessionFile, "expected a persisted session jsonl under agent sessions");
    const header = JSON.parse(await readFile(sessionFile!, "utf8")) as { type?: string; id?: string };
    assert.equal(header.type, "session");
    assert.equal(header.id, threadId);

    // 第一问：产生 user + assistant 两条消息。
    const firstQuestion = "求一道解三角形的题目";
    const send1Token = await h.issue(teacher, "POST", `/internal/teacher-chat/threads/${threadId}/messages`, { content: firstQuestion });
    const sent1 = await h.inject(send1Token, "POST", `/internal/teacher-chat/threads/${threadId}/messages`, { content: firstQuestion });
    assert.equal(sent1.statusCode, 200);
    const sent1Body = sent1.json();
    assert.equal(sent1Body.messages.length, 2);
    assert.equal(sent1Body.messages[0].role, "user");
    assert.equal(sent1Body.messages[0].content, firstQuestion);
    assert.equal(sent1Body.messages[1].role, "assistant");

    // 第二问：多轮记忆，消息继续追加。
    const secondQuestion = "换一道难一点的";
    const send2Token = await h.issue(teacher, "POST", `/internal/teacher-chat/threads/${threadId}/messages`, { content: secondQuestion });
    const sent2 = await h.inject(send2Token, "POST", `/internal/teacher-chat/threads/${threadId}/messages`, { content: secondQuestion });
    assert.equal(sent2.statusCode, 200);
    const sent2Body = sent2.json();
    assert.equal(sent2Body.messages.length, 4);
    assert.equal(sent2Body.messages[3].content[0].text, `已收到：${secondQuestion}`);

    // 读取单会话：返回完整历史。
    const readToken = await h.issue(teacher, "GET", `/internal/teacher-chat/threads/${threadId}`);
    const read = await h.inject(readToken, "GET", `/internal/teacher-chat/threads/${threadId}`);
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().messages.length, 4);

    // 列出会话：教师可见自己的会话。
    const listToken = await h.issue(teacher, "GET", "/internal/teacher-chat/threads");
    const listed = await h.inject(listToken, "GET", "/internal/teacher-chat/threads");
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().length, 1);
    assert.equal(listed.json()[0].thread_id, threadId);

    // 幂等创建：携带同一 thread_id 返回已有会话的完整转录。
    const idempotentToken = await h.issue(teacher, "POST", "/internal/teacher-chat/threads", { thread_id: threadId });
    const idempotent = await h.inject(idempotentToken, "POST", "/internal/teacher-chat/threads", { thread_id: threadId });
    assert.equal(idempotent.statusCode, 200);
    assert.equal(idempotent.json().messages.length, 4);

    // 重放同一断言会被内部服务拒绝。
    const replay = await h.inject(createToken, "POST", "/internal/teacher-chat/threads");
    assert.equal(replay.statusCode, 401);
    assert.equal(replay.json().code, "internal_service_authentication_failed");
  } finally {
    await h.cleanup();
  }
});

test("teacher chat: empty message content is rejected with 422", async () => {
  const h = await harness();
  try {
    const createToken = await h.issue(teacher, "POST", "/internal/teacher-chat/threads");
    const created = await h.inject(createToken, "POST", "/internal/teacher-chat/threads");
    const threadId = String(created.json().thread_id);

    const sendToken = await h.issue(teacher, "POST", `/internal/teacher-chat/threads/${threadId}/messages`, { content: "   " });
    const rejected = await h.inject(sendToken, "POST", `/internal/teacher-chat/threads/${threadId}/messages`, { content: "   " });
    assert.equal(rejected.statusCode, 422);
  } finally {
    await h.cleanup();
  }
});

test("ktq-start dispatches a KTQ instruction into the owner teacher thread", async () => {
  const h = await harness();
  try {
    const createToken = await h.issue(teacher, "POST", "/internal/teacher-chat/threads");
    const created = await h.inject(createToken, "POST", "/internal/teacher-chat/threads");
    const threadId = String(created.json().thread_id);
    const commandId = "cmd_ktq_e2e";

    const startToken = await h.issue(teacher, "POST", "/internal/ktq-start", {
      command_id: commandId,
      target_thread_id: threadId,
      chapter_id: "chap_triangle",
    });
    const started = await h.inject(startToken, "POST", "/internal/ktq-start", {
      command_id: commandId,
      target_thread_id: threadId,
      chapter_id: "chap_triangle",
    });
    assert.equal(started.statusCode, 200);
    assert.equal(started.json().dispatched, true);

    // 指令已作为该线程的用户消息进入 Pi 会话（含命令令牌）。
    const readToken = await h.issue(teacher, "GET", `/internal/teacher-chat/threads/${threadId}`);
    const read = await h.inject(readToken, "GET", `/internal/teacher-chat/threads/${threadId}`);
    assert.equal(read.statusCode, 200);
    const texts = read.json().messages.map((m: { content: unknown }) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content));
    assert.ok(texts.some((t: string) => t.includes(commandId)), "expected KTQ instruction message in transcript");

    // 重复派发同命令幂等返回成功（需新断言避免内部重放拒绝）。
    const retryToken = await h.issue(teacher, "POST", "/internal/ktq-start", {
      command_id: commandId,
      target_thread_id: threadId,
      chapter_id: "chap_triangle",
    });
    const retried = await h.inject(retryToken, "POST", "/internal/ktq-start", {
      command_id: commandId,
      target_thread_id: threadId,
      chapter_id: "chap_triangle",
    });
    assert.equal(retried.statusCode, 200);
    assert.equal(retried.json().dispatched, true);

    // 非教师角色被拒。
    const studentToken = await h.issue(student, "POST", "/internal/ktq-start", {
      command_id: "cmd_forbidden",
      target_thread_id: threadId,
    });
    const forbidden = await h.inject(studentToken, "POST", "/internal/ktq-start", {
      command_id: "cmd_forbidden",
      target_thread_id: threadId,
    });
    assert.equal(forbidden.statusCode, 403);
  } finally {
    await h.cleanup();
  }
});
