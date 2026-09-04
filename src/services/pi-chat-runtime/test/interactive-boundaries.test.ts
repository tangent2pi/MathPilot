import assert from "node:assert/strict";
import { access, link, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalJson } from "@mathpilot/content-integrity/node";
import { parseBoundedLearningAction } from "@mathpilot/contracts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import learningActionExtension from "../extensions/learning-action.ts";
import { hostStateDirectory, writeHostPrincipal } from "../extensions/lib/host-principal.ts";
import {
  readAcceptedTeachingArtifacts,
  recordAcceptedTeachingArtifact,
} from "../extensions/lib/interactive-turn-state.ts";
import {
  appendCanonicalVisible,
  CANONICAL_MESSAGE_TYPE,
  parseCanonicalSyncMessage,
} from "../src/pi-canonical-sync.ts";
import { buildPiImageInputs } from "../src/pi-interactive-bridge.ts";
import { canonicalSessionFromSupervisor } from "../src/pi-chat-server.ts";
import { ensurePiSessionFile, relocateLegacyPiSessionFile } from "../src/pi-session-files.ts";
import { piExecutionLeaseKey } from "../src/pi-thread-store.ts";
import {
  canonicalUserLinkEligible,
  clearTerminalTurnState,
  isDurableDispatchAcknowledgement,
  nativeInputPresent,
  parseSendInput,
  publicTextParts,
} from "../src/pi-http-routes.ts";

const digestMessage = (value: Record<string, unknown>) => ({
  ...value,
  digest: createHash("sha256").update(canonicalJson(value).json).digest("hex"),
});

test("canonical mirror enforces the teaching artifact 1000 character boundary", () => {
  const base = {
    message_id: "msg_abcdefgh",
    author_kind: "assistant",
    created_at: "2026-09-02T00:00:00.000Z",
  } as const;
  const accepted = digestMessage({ ...base, parts: [{
    type: "teaching_artifact", artifact_ref: "artifact://one",
    artifact_schema: "mathpilot.teaching-artifact/math-derivation/v1", summary: "x".repeat(1000),
  }] });
  assert.equal(parseCanonicalSyncMessage(accepted).message_id, base.message_id);
  const rejected = digestMessage({ ...base, parts: [{
    type: "teaching_artifact", artifact_ref: "artifact://one",
    artifact_schema: "mathpilot.teaching-artifact/math-derivation/v1", summary: "x".repeat(1001),
  }] });
  assert.throws(() => parseCanonicalSyncMessage(rejected), /invalid/);
});

test("canonical mirror revalidates persisted details through the shared strict contract", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mathpilot-pi-mirror-details-"));
  try {
    const cwd = path.join(root, "thr_abcdefgh");
    const sessionDir = path.join(root, "sessions");
    await Promise.all([mkdir(cwd), mkdir(sessionDir)]);
    const manager = SessionManager.create(cwd, sessionDir, { id: "thr_abcdefgh" });
    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile);
    await writeFile(sessionFile, `${JSON.stringify(manager.getHeader())}\n`, "utf8");
    const session = {
      manager,
      async appendCustomMessage(message: { customType: string; content: string; display: boolean; details?: unknown }) {
        manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
      },
    };
    const message = parseCanonicalSyncMessage(digestMessage({
      message_id: "msg_abcdefgh", author_kind: "assistant", created_at: "2026-09-02T00:00:00.000Z",
      parts: [{ type: "text", text: "严格详情" }],
    }));
    manager.appendCustomMessageEntry(CANONICAL_MESSAGE_TYPE, "", true, {
      schema: CANONICAL_MESSAGE_TYPE,
      message_id: message.message_id,
      author_kind: message.author_kind,
      created_at: message.created_at,
      parts: message.parts,
      digest: message.digest,
      unexpected: true,
    });
    assert.throws(() => appendCanonicalVisible(session, message), /invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Pi derives image input from the authorized projection and keeps raw browser attachments out", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mathpilot-pi-images-"));
  try {
    const projectionRoot = path.join(root, "input", "projection");
    await mkdir(path.join(projectionRoot, "objects"), { recursive: true });
    const image = Buffer.from("authorized-image-bytes", "utf8");
    const imageDescriptor = {
      object_id: "obj_image001",
      object_ref: "storage-object:obj_image001",
      version_id: "ver_image001",
      sha256: createHash("sha256").update(image).digest("hex"),
      byte_size: image.byteLength,
      mime_type: "image/png",
      original_name: "diagram.png",
      source: {
        version_id: "ver_image001",
        sha256: createHash("sha256").update(image).digest("hex"),
        byte_size: image.byteLength,
        mime_type: "image/png",
      },
      expires_at: null,
    } as const;
    const imagePath = path.join(projectionRoot, "objects", "diagram.png");
    await writeFile(imagePath, image);
    const canonical = parseCanonicalSyncMessage(digestMessage({
      message_id: "msg_image001", author_kind: "student", created_at: "2026-09-02T00:00:00.000Z",
      parts: [{
        type: "attachment", attachment_ref: imageDescriptor.object_ref, name: imageDescriptor.original_name,
        mime_type: imageDescriptor.mime_type, version_id: imageDescriptor.version_id,
        sha256: imageDescriptor.sha256, byte_size: imageDescriptor.byte_size,
      }],
    }));
    const images = await buildPiImageInputs({
      projectionRoot,
      canonicalMessage: canonical,
      objects: [{ path: "objects/diagram.png", descriptor: imageDescriptor }],
    });
    assert.deepEqual(images, [{ type: "image", data: image.toString("base64"), mimeType: "image/png" }]);
    assert.deepEqual(parseSendInput({ content: "" }, true), { content: "" });
    assert.throws(() => parseSendInput({ content: "" }), /invalid/);
    assert.throws(() => parseSendInput({
      content: "x", attachments: [{ type: "image", data: image.toString("base64"), mimeType: "image/png" }],
    }), /invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the version-pinned supervisor adapter appends through the live idle manager and fails closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mathpilot-pi-supervisor-"));
  try {
    const cwd = path.join(root, "thr_abcdefgh");
    const sessionDir = path.join(root, "sessions");
    await Promise.all([mkdir(cwd), mkdir(sessionDir)]);
    const manager = SessionManager.create(cwd, sessionDir, { id: "thr_abcdefgh" });
    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile);
    // SessionManager intentionally defers a brand-new transcript until the
    // first assistant response. Establish an idle, completed live session so
    // this test exercises the append-only persistence path used by sync.
    manager.appendMessage({
      role: "assistant", content: [{ type: "text", text: "baseline" }],
      api: "openai-responses", provider: "test", model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now(),
    } as never);
    let publicApiCalls = 0;
    const live = {
      sessionManager: manager,
      isStreaming: false,
      async sendCustomMessage(message: { customType: string; content: string; display: boolean; details?: unknown }) {
        publicApiCalls++;
        manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
      },
    };
    const supervisor = { records: new Map([["thr_abcdefgh", { session: live }]]) };
    const selected = canonicalSessionFromSupervisor(supervisor, "thr_abcdefgh", sessionFile);
    const message = parseCanonicalSyncMessage(digestMessage({
      message_id: "msg_abcdefgh", author_kind: "student", created_at: "2026-09-02T00:00:00.000Z",
      parts: [{ type: "text", text: "历史问题" }],
    }));
    await appendCanonicalVisible(selected, message);
    assert.equal(publicApiCalls, 1);
    assert.equal(manager.getEntries().at(-1)?.type, "custom_message");
    assert.match(await readFile(sessionFile, "utf8"), /mathpilot\.canonical-message\/v1/);
    live.isStreaming = true;
    await assert.rejects(() => appendCanonicalVisible(selected, parseCanonicalSyncMessage(digestMessage({
      message_id: "msg_ijklmnop", author_kind: "student", created_at: "2026-09-02T00:00:01.000Z",
      parts: [{ type: "text", text: "新消息" }],
    }))), /streaming/);
    assert.throws(() => canonicalSessionFromSupervisor({}, "thr_abcdefgh", sessionFile), /contract is unavailable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("public terminal projection aggregates all assistant text and excludes thinking and tools", () => {
  const parts = publicTextParts({
    metadata: { id: "thr_abcdefgh", title: "t", status: "idle", createdAt: 0, updatedAt: 0 },
    messages: [
      { role: "assistant", content: [{ type: "text", text: "第一段" }, { type: "thinking", thinking: "secret" }], timestamp: 1 },
      { role: "toolResult", toolCallId: "tool_1", toolName: "read", content: [{ type: "text", text: "private" }], isError: false, timestamp: 2 },
      { role: "assistant", content: [{ type: "text", text: "第二段" }], timestamp: 3 },
    ],
  } as never, 0);
  assert.deepEqual(parts, [{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }]);
});

test("canonical sync links only a durably observed user bubble at the exact turn baseline", () => {
  const input = { content: "相同文字" };
  const snapshot = {
    metadata: { id: "thr_abcdefgh", title: "t", status: "idle", createdAt: 0, updatedAt: 0 },
    messages: [
      { role: "custom", content: "", customType: "mathpilot.canonical-message/v1", display: true, timestamp: 1 },
      { role: "user", content: "相同文字", timestamp: 2 },
    ],
  } as never;
  assert.equal(nativeInputPresent(snapshot, 0, input), false,
    "a later same-text user bubble cannot be claimed by an earlier failed marker");
  assert.equal(nativeInputPresent(snapshot, 1, input), true);
  assert.equal(canonicalUserLinkEligible(snapshot, false, 1, input), false,
    "prepare/send-before-append failure must remain a visible canonical message");
  assert.equal(canonicalUserLinkEligible(snapshot, true, 1, input), true);
});

test("terminal cleanup removes the persisted receipt marker and ambient principal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mathpilot-pi-terminal-cleanup-"));
  const workspace = path.join(root, "thr_abcdefgh");
  const driverId = "interactive-epoch:fge_abcdefgh:fgr_abcdefgh";
  try {
    await mkdir(workspace);
    await writeHostPrincipal(workspace, { tenantId: "tnt_primary01", userId: "usr_student01", roles: ["student"] });
    const turns = path.join(hostStateDirectory(workspace), "interactive-turns");
    const marker = path.join(turns, `${driverId}.json`);
    await mkdir(turns, { recursive: true, mode: 0o700 });
    await writeFile(marker, JSON.stringify({ receipt: "sensitive" }), { mode: 0o600 });
    await clearTerminalTurnState(workspace, driverId);
    await assert.rejects(() => access(marker), { code: "ENOENT" });
    await assert.rejects(() => access(path.join(hostStateDirectory(workspace), "principal.json")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("same-receipt retries acknowledge only durable Pi dispatch states", () => {
  assert.equal(isDurableDispatchAcknowledgement("prepared"), false);
  for (const status of ["sending", "sent", "completion_pending", "completed", "failed", "cancelled"] as const) {
    assert.equal(isDurableDispatchAcknowledgement(status), true);
  }
});

test("execution lease keys are PostgreSQL-safe and unambiguous", () => {
  const first = piExecutionLeaseKey("tenant:a", "thread:b:c");
  const second = piExecutionLeaseKey("tenant:a:b", "thread:c");
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /\u0000/);
  assert.deepEqual(JSON.parse(first), ["tenant:a", "thread:b:c"]);
});

test("cold session provisioning follows the SDK directory discovered by React Pi", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mathpilot-pi-session-files-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const agentDir = path.join(root, "agent");
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const first = await ensurePiSessionFile(workspace, "thr_session01");
    assert.equal(first.created, true);
    assert.equal(path.dirname(first.sessionFile) === path.join(agentDir, "sessions"), false,
      "Pi sessions must live in the SDK's cwd-scoped child directory");
    assert.equal((await SessionManager.list(workspace)).some((item) => item.id === "thr_session01"), true);
    const retry = await ensurePiSessionFile(workspace, "thr_session01");
    assert.deepEqual(retry, { sessionFile: first.sessionFile, created: false });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy flat sessions relocate without clobbering and recover an interrupted unlink", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mathpilot-pi-session-relocate-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const agentDir = path.join(root, "agent");
    const legacyDirectory = path.join(agentDir, "sessions");
    const workspace = path.join(root, "workspace");
    await Promise.all([mkdir(workspace), mkdir(legacyDirectory, { recursive: true })]);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const manager = SessionManager.create(workspace, legacyDirectory, { id: "thr_legacy001" });
    manager.appendCustomEntry("mathpilot.test/v1", { preserved: true });
    const legacyFile = manager.getSessionFile();
    assert.ok(legacyFile);
    await writeFile(legacyFile, `${[manager.getHeader(), ...manager.getEntries()]
      .map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600 });

    const relocated = await relocateLegacyPiSessionFile(workspace, "thr_legacy001", legacyFile);
    assert.notEqual(path.dirname(relocated), legacyDirectory);
    await assert.rejects(() => access(legacyFile), { code: "ENOENT" });
    assert.match(await readFile(relocated, "utf8"), /mathpilot\.test\/v1/);
    assert.equal((await SessionManager.list(workspace)).find((item) => item.id === "thr_legacy001")?.path, relocated);

    // Simulate a stop after no-clobber link but before unlink. The retry must
    // identify the shared inode and finish the move, not replace either file.
    await link(relocated, legacyFile);
    assert.equal(await relocateLegacyPiSessionFile(workspace, "thr_legacy001", legacyFile), relocated);
    await assert.rejects(() => access(legacyFile), { code: "ENOENT" });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("learning_action exposes no identity parameters and artifact receipts are tool-call idempotent", async () => {
  let registered: { parameters?: unknown } | undefined;
  learningActionExtension({ registerTool(tool: unknown) { registered = tool as { parameters: unknown }; } } as never);
  const schemaJson = JSON.stringify(registered?.parameters);
  for (const forbidden of ["tenant", "user_id", "thread_id", "attempt_id", "operation_id", "tool_call_id"]) {
    assert.doesNotMatch(schemaJson, new RegExp(forbidden));
  }
  assert.throws(() => parseBoundedLearningAction({
    action: "request_cut", reason: "completed", operation_id: "op_forged0001",
  }), /unsupported|invalid/);

  const root = await mkdtemp(path.join(os.tmpdir(), "mathpilot-pi-artifact-"));
  const cwd = path.join(root, "thr_abcdefgh");
  try {
    await mkdir(cwd);
    const artifact = {
      tool_call_id: "tool_abcdefgh", artifact_ref: "artifact://accepted",
      artifact_schema: "mathpilot.teaching-artifact/math-derivation/v1", summary: "已验证推导",
    };
    await recordAcceptedTeachingArtifact(cwd, "agt_abcdefgh", artifact);
    await recordAcceptedTeachingArtifact(cwd, "agt_abcdefgh", artifact);
    assert.deepEqual(await readAcceptedTeachingArtifacts(cwd, "agt_abcdefgh"), [artifact]);
    await assert.rejects(() => recordAcceptedTeachingArtifact(cwd, "agt_abcdefgh", { ...artifact, summary: "changed" }), /changed/);
    assert.equal(path.dirname(hostStateDirectory(cwd)), path.join(root, ".host-state"));
    assert.doesNotMatch(await readFile(path.join(root, ".host-state", "thr_abcdefgh", "interactive-artifacts.json"), "utf8"), /tenantId|userId/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
