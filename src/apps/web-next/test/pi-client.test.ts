import assert from "node:assert/strict";
import { File } from "node:buffer";
import test from "node:test";
import type { PendingAttachment } from "@assistant-ui/react";
import type { PiClient, PiThreadSnapshot } from "@assistant-ui/react-pi";
import { UnifiedAttachmentAdapter } from "../src/AttachmentAdapter";
import { createCanonicalPiClient, provisionCanonicalPiThread } from "../src/learning/data/pi-client";

const snapshot = (id = "thr_test"): PiThreadSnapshot => ({
  metadata: { id, status: "idle" },
  messages: [],
});

const baseClient = (): PiClient => ({
  listThreads: async () => [],
  createThread: async () => snapshot(),
  getThread: async (threadId) => snapshot(threadId),
  sendMessage: async () => undefined,
  cancelRun: async () => undefined,
  clearQueue: async () => ({ steering: [], followUp: [] }),
  getAvailableModels: async () => [],
  setModel: async () => undefined,
  setThinkingLevel: async () => undefined,
  renameThread: async () => undefined,
  archiveThread: async () => undefined,
  unarchiveThread: async () => undefined,
  deleteThread: async () => undefined,
  respondToHostUiRequest: async () => undefined,
  subscribe: () => () => undefined,
});

test("new Pi threads retain one canonical creation envelope and natural-idempotent provision", async () => {
  const creates: Array<{ key: string; title: string; requestedAt: string }> = [];
  const provisions: string[] = [];
  let provisionAttempt = 0;
  const client = createCanonicalPiClient({
    attachmentAdapter: new UnifiedAttachmentAdapter(),
    baseClient: baseClient(),
    newKey: (scope) => `key:${scope}`,
    createCanonicalThread: async (key, title, requestedAt) => {
      creates.push({ key, title, requestedAt });
      return { thread: { thread_id: "thr_created", version: 4 } };
    },
    provision: async (threadId) => {
      provisions.push(threadId);
      provisionAttempt += 1;
      if (provisionAttempt === 1) throw new TypeError("network failed");
    },
  });

  await assert.rejects(client.createThread(), /network failed/);
  const restored = await client.createThread();

  assert.equal(restored.metadata.id, "thr_created");
  assert.deepEqual(creates.map(({ key, title }) => ({ key, title })), [{ key: "key:pi-thread", title: "新对话" }]);
  assert.equal(provisions.length, 2);
  assert.deepEqual(provisions, ["thr_created", "thr_created"]);
});

test("Pi provisioning uses the isolated canonical contract", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(null, { status: 204 });
  };
  try {
    await provisionCanonicalPiThread("thr_canonical_001");

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, "/api/pi/threads/thr_canonical_001/provision");
    assert.equal(requests[0]?.init?.method, "PUT");
    assert.equal(new Headers(requests[0]?.init?.headers).get("idempotency-key"), null);
    assert.equal(requests[0]?.init?.body, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an unknown Pi message result retries the exact canonical command envelope", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
  let fetchAttempt = 0;
  globalThis.fetch = async (_url, init) => {
    fetchAttempt += 1;
    requests.push({
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    if (fetchAttempt === 1) throw new TypeError("connection dropped");
    return new Response(JSON.stringify({ thread_version: 9 }), { status: 202 });
  };
  try {
    const client = createCanonicalPiClient({
      attachmentAdapter: new UnifiedAttachmentAdapter(),
      baseClient: baseClient(),
      expectedVersion: () => 8,
      newKey: (scope) => `key:${scope}`,
    });
    const input = { content: "请继续讲解" };

    await assert.rejects(client.sendMessage("thr_existing", input), /connection dropped/);
    await client.sendMessage("thr_existing", input);

    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.headers.get("idempotency-key"), "key:pi-message");
    assert.equal(requests[1]?.headers.get("idempotency-key"), "key:pi-message");
    assert.deepEqual(requests[0]?.body, requests[1]?.body);
    assert.equal(requests[0]?.body.expected_version, 8);
    assert.equal(typeof requests[0]?.body.requested_at, "string");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Pi rejects a mid-run follow-up before it can create another canonical command", async () => {
  const originalFetch = globalThis.fetch;
  let requested = false;
  globalThis.fetch = async () => {
    requested = true;
    return new Response(null, { status: 202 });
  };
  try {
    const client = createCanonicalPiClient({
      attachmentAdapter: new UnifiedAttachmentAdapter(),
      baseClient: baseClient(),
      expectedVersion: () => 8,
      isThreadRunning: () => true,
    });

    await assert.rejects(
      client.sendMessage("thr_existing", { content: "不要排队" }),
      /尚未结束/,
    );
    assert.equal(requested, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Pi sends image-only turns as immutable descriptors, never browser image bytes", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ thread_version: 9 }), { status: 202 });
  };
  try {
    const adapter = new UnifiedAttachmentAdapter({
      upload: async () => ({
        object_id: "obj_image",
        object_ref: "storage-object:obj_image",
        version_id: "version-image",
        sha256: "a".repeat(64),
        byte_size: 4,
        mime_type: "image/png",
        original_name: "graph.png",
        source: { version_id: "source-image", sha256: "b".repeat(64), byte_size: 4, mime_type: "image/png" },
        expires_at: null,
      }),
      remove: async () => undefined,
    });
    await adapter.send({
      id: "image-only",
      // The gateway stripping test does not need FileReader's browser-only
      // preview path; the immutable descriptor itself remains image/png.
      type: "document",
      name: "graph.png",
      contentType: "image/png",
      file: new File(["png"], "graph.png", { type: "image/png" }),
      status: { type: "requires-action", reason: "composer-send" },
    } satisfies PendingAttachment);
    const client = createCanonicalPiClient({
      attachmentAdapter: adapter,
      baseClient: baseClient(),
      expectedVersion: () => 8,
    });

    await client.sendMessage("thr_existing", {
      content: "",
      attachments: [{ type: "image", mimeType: "image/png", data: "very-large-browser-data" }],
    });

    const input = requests[0]?.input as Record<string, unknown>;
    assert.deepEqual(input, {
      content: "",
      mathpilotAttachments: [{
        attachment_id: "image-only",
        object_id: "obj_image",
        object_ref: "storage-object:obj_image",
        version_id: "version-image",
        sha256: "a".repeat(64),
        byte_size: 4,
        mime_type: "image/png",
        original_name: "graph.png",
        source: { version_id: "source-image", sha256: "b".repeat(64), byte_size: 4, mime_type: "image/png" },
        expires_at: null,
      }],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a terminal interactive-attempt replay accepts claimed attachments before surfacing 409", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    type: "urn:mathpilot:problem:interactive-attempt-succeeded",
    title: "已完成",
    status: 409,
    code: "interactive_attempt_succeeded",
  }), { status: 409, headers: { "content-type": "application/problem+json" } });
  try {
    const adapter = new UnifiedAttachmentAdapter({
      upload: async () => ({
        object_id: "obj_terminal",
        object_ref: "storage-object:obj_terminal",
        version_id: "version-terminal",
        sha256: "a".repeat(64),
        byte_size: 1,
        mime_type: "text/plain",
        original_name: "terminal.txt",
        source: { version_id: "source-terminal", sha256: "b".repeat(64), byte_size: 1, mime_type: "text/plain" },
        expires_at: null,
      }),
      remove: async () => undefined,
    });
    await adapter.send({
      id: "terminal-attachment",
      type: "document",
      name: "terminal.txt",
      contentType: "text/plain",
      file: new File(["x"], "terminal.txt", { type: "text/plain" }),
      status: { type: "requires-action", reason: "composer-send" },
    } satisfies PendingAttachment);
    const client = createCanonicalPiClient({
      attachmentAdapter: adapter,
      baseClient: baseClient(),
      expectedVersion: () => 8,
    });

    await assert.rejects(
      client.sendMessage("thr_existing", { content: "已被接纳" }),
      (error: unknown) => error instanceof Error && error.message === "已完成",
    );
    assert.deepEqual(adapter.claimForPiTurn(), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("two accepted Pi sends advance locally while the canonical query is still stale", async () => {
  const originalFetch = globalThis.fetch;
  const commands: Array<Record<string, unknown>> = [];
  let receiptVersion = 5;
  globalThis.fetch = async (_url, init) => {
    commands.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ thread_version: receiptVersion++ }), { status: 202 });
  };
  try {
    const client = createCanonicalPiClient({
      attachmentAdapter: new UnifiedAttachmentAdapter(),
      baseClient: baseClient(),
      // The query has not refetched after either command yet.
      expectedVersion: () => 4,
      newKey: (scope) => `key:${scope}:${commands.length}`,
    });

    await client.sendMessage("thr_existing", { content: "第一条" });
    await client.sendMessage("thr_existing", { content: "第二条" });

    assert.deepEqual(commands.map((command) => command.expected_version), [4, 5]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a newer canonical refresh advances the send version without later backtracking", async () => {
  const originalFetch = globalThis.fetch;
  const commands: Array<Record<string, unknown>> = [];
  let queryVersion = 4;
  globalThis.fetch = async (_url, init) => {
    const command = JSON.parse(String(init?.body)) as Record<string, unknown>;
    commands.push(command);
    return new Response(JSON.stringify({ thread_version: Number(command.expected_version) + 1 }), { status: 202 });
  };
  try {
    const client = createCanonicalPiClient({
      attachmentAdapter: new UnifiedAttachmentAdapter(),
      baseClient: baseClient(),
      expectedVersion: () => queryVersion,
      newKey: (scope) => `key:${scope}:${commands.length}`,
    });

    await client.sendMessage("thr_existing", { content: "第一条" });
    queryVersion = 7; // a canonical event refresh raced ahead of the receipt map
    await client.sendMessage("thr_existing", { content: "第二条" });
    queryVersion = 4; // the query cache is subsequently stale again
    await client.sendMessage("thr_existing", { content: "第三条" });

    assert.deepEqual(commands.map((command) => command.expected_version), [4, 7, 8]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
