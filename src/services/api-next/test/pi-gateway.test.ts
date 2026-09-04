import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { InternalServiceRuntime } from "@mathpilot/internal-service";
import { installProblemDetails } from "@mathpilot/internal-service/fastify";
import type pg from "pg";
import type { Principal } from "../src/auth.ts";

process.env.MATHPILOT_ENVIRONMENT = "development";
const [{ learningProblemFromError }, { registerPiGateway }, { LearningCommandService }] = await Promise.all([
  import("../src/learning-http.ts"),
  import("../src/pi-gateway.ts"),
  import("../src/learning-command/service.ts"),
]);

const principal: Principal = {
  userId: "usr_student01", uid: "uid_student01", tenantId: "tnt_primary01", roles: ["student"],
  authUserId: "auth_student01", name: "Student", email: "student@example.test",
};
const threadId = "thr_abcdefgh";
const key = "pi-message:abcdefgh";
const message = {
  schema_version: 3, message_id: "msg_abcdefgh", conversation_thread_id: threadId, sequence: 1,
  author_kind: "student", lifecycle: "committed", parts: [{ type: "text", text: "请讲解" }],
  editable: false, created_at: "2026-09-02T00:00:00.000Z", version: 1, action_capabilities: [],
};
const view = {
  data: {
    thread: { title: "请讲解", version: 2 }, messages: [message], has_more: false, next_cursor: "",
  },
};
const preAdmissionView = {
  data: {
    thread: { title: "新对话", version: 1 }, messages: [], has_more: false, next_cursor: "",
  },
};
const admission = {
  accepted: true as boolean, created: true, foreground_request_id: "fgr_abcdefgh", operation_id: "op_abcdefgh",
  message_id: "msg_abcdefgh", conversation_thread_id: threadId, triggering_message_id: "msg_abcdefgh",
  foreground_epoch_id: "fge_abcdefgh", event_id: "evt_abcdefgh", agent_attempt_id: "agt_abcdefgh",
  input_ref: "agent-artifact:art_abcdefgh", execution_driver: "interactive_epoch" as const,
  driver_execution_id: "interactive-epoch:fge_abcdefgh:fgr_abcdefgh", dispatch_required: true as boolean, thread_version: 2,
  request_status: "running" as string, attempt_status: "started" as string,
};

const problem = (status: number, code: string) => new Response(JSON.stringify({
  type: `urn:mathpilot:problem:${code}`, title: code, status, code,
}), { status, headers: { "content-type": "application/problem+json" } });

const appWith = async (input: {
  request: (edge: string, path: string, options: { method?: string; json?: unknown; headers?: Record<string, string> }) => Promise<Response>;
  submit?: () => Promise<typeof admission>;
  fail?: () => Promise<unknown>;
  read?: () => unknown;
}) => {
  const app = Fastify();
  installProblemDetails(app, learningProblemFromError);
  let authCalls = 0;
  let submitCalls = 0;
  let failCalls = 0;
  registerPiGateway(
    app,
    {} as pg.Pool,
    {
      request: (edge: string, _actor: unknown, path: string, options: never) => input.request(edge, path, options),
    } as unknown as InternalServiceRuntime,
    async () => { authCalls++; return principal; },
    {
      reads: { async threadMessages() {
        return (input.read?.() ?? (submitCalls === 0 ? preAdmissionView : view)) as never;
      } },
      commands: {
        async submitInteractiveForegroundMessage() {
          submitCalls++;
          return input.submit ? input.submit() : admission;
        },
        async failInteractiveDispatch() {
          failCalls++;
          return input.fail ? input.fail() : { compensated: true, status: "failed", error_code: "dispatch_failed" };
        },
      } as never,
    },
  );
  await app.ready();
  return { app, authCalls: () => authCalls, submitCalls: () => submitCalls, failCalls: () => failCalls };
};

const sendPayload = {
  idempotency_key: key,
  expected_version: 1,
  requested_at: "2026-09-02T00:00:00.000Z",
  input: { content: "请讲解" },
};
const receipt = {
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
};

test("admission success plus two unconfirmed Pi dispatches is canonically compensated", async () => {
  const observed: Array<{ path: string; json?: unknown }> = [];
  const fixture = await appWith({ request: async (_edge, path, options) => {
    observed.push({ path, json: options.json });
    return problem(409, "pi_thread_busy");
  } });
  try {
    const response = await fixture.app.inject({
      method: "POST", url: `/api/pi/threads/${threadId}/messages`,
      headers: { "idempotency-key": key }, payload: sendPayload,
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, "pi_dispatch_failed");
    assert.equal(fixture.submitCalls(), 1);
    assert.equal(fixture.failCalls(), 1);
    assert.deepEqual(observed.map((entry) => entry.path), [
      `/pi/threads/${threadId}/sync`,
      `/pi/threads/${threadId}/messages`,
      `/pi/threads/${threadId}/messages`,
    ]);
    const provisionProjection = observed[0]?.json as { messages?: unknown[] };
    assert.deepEqual(provisionProjection.messages, [], "pre-admission provision must exclude the triggering message");
    const envelope = observed[1]?.json as { admission?: Record<string, unknown> };
    assert.deepEqual(Object.keys(envelope.admission ?? {}).sort(), [
      "agent_attempt_id", "conversation_thread_id", "driver_execution_id", "event_id",
      "execution_driver", "foreground_epoch_id", "foreground_request_id", "input_ref",
      "operation_id", "triggering_message_id",
    ]);
  } finally { await fixture.app.close(); }
});

test("provision is bodyless PUT backed only by the authorized canonical transcript", async () => {
  const observed: Array<{ edge: string; path: string; options: { method?: string; json?: unknown } }> = [];
  const fixture = await appWith({ read: () => view, request: async (edge, path, options) => {
    observed.push({ edge, path, options });
    return new Response(JSON.stringify({ metadata: { id: threadId }, messages: [] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  } });
  try {
    const provisioned = await fixture.app.inject({
      method: "PUT", url: `/api/pi/threads/${threadId}/provision`,
    });
    assert.equal(provisioned.statusCode, 204);
    assert.equal(fixture.authCalls(), 1);
    assert.equal(observed.length, 1);
    assert.equal(observed[0]?.edge, "api-to-pi");
    assert.equal(observed[0]?.path, `/pi/threads/${threadId}/sync`);
    assert.equal(observed[0]?.options.method, "POST");
    const projection = observed[0]?.options.json as { title?: unknown; messages?: Array<{ message_id?: unknown }> };
    assert.equal(projection.title, "请讲解");
    assert.deepEqual(projection.messages?.map((entry) => entry.message_id), ["msg_abcdefgh"]);
    const retired = await fixture.app.inject({
      method: "POST", url: `/api/pi/threads/${threadId}/provision`,
      payload: { idempotency_key: key, title: "ignored", requested_at: "2026-09-02T00:00:00.000Z" },
    });
    assert.equal(retired.statusCode, 410);
    assert.equal(retired.json().code, "pi_provision_contract_retired");
    assert.equal(observed.length, 1);
  } finally { await fixture.app.close(); }
});

test("opening a canonical thread lazily provisions a missing Pi session", async () => {
  const observed: string[] = [];
  const fixture = await appWith({ request: async (_edge, path) => {
    observed.push(path);
    if (path.endsWith("/sync")) return problem(404, "pi_thread_not_found");
    return new Response(JSON.stringify({
      metadata: { id: threadId, status: "idle", title: "请讲解" }, messages: [],
    }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  try {
    const response = await fixture.app.inject({ method: "GET", url: `/api/pi/threads/${threadId}` });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(observed, [
      `/pi/threads/${threadId}/sync`,
      `/pi/threads/${threadId}/provision`,
      `/pi/threads/${threadId}`,
    ]);
  } finally { await fixture.app.close(); }
});

test("message admission fails closed when the pre-admission Pi mapping cannot be ensured", async () => {
  const fixture = await appWith({ request: async () => { throw new Error("Pi unavailable"); } });
  try {
    const response = await fixture.app.inject({
      method: "POST", url: `/api/pi/threads/${threadId}/messages`,
      headers: { "idempotency-key": key }, payload: sendPayload,
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, "pi_provision_unavailable");
    assert.equal(fixture.submitCalls(), 0);
    assert.equal(fixture.failCalls(), 0);
    const explicitProvision = await fixture.app.inject({
      method: "PUT", url: `/api/pi/threads/${threadId}/provision`,
    });
    assert.equal(explicitProvision.statusCode, 503);
    assert.equal(explicitProvision.json().code, "pi_provision_unavailable");
  } finally { await fixture.app.close(); }
});

test("browser image bytes cannot bypass canonical immutable attachment admission", async () => {
  let upstreamCalls = 0;
  const fixture = await appWith({ request: async () => {
    upstreamCalls++;
    return new Response(null, { status: 204 });
  } });
  try {
    const response = await fixture.app.inject({
      method: "POST", url: `/api/pi/threads/${threadId}/messages`,
      headers: { "idempotency-key": key },
      payload: {
        ...sendPayload,
        input: {
          content: "请讲解",
          attachments: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
        },
      },
    });
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().code, "invalid_pi_message");
    assert.equal(fixture.submitCalls(), 0);
    assert.equal(upstreamCalls, 0);
  } finally { await fixture.app.close(); }
});

test("succeeded idempotent admission returns a stable terminal conflict without redispatch", async () => {
  const observed: string[] = [];
  const fixture = await appWith({
    request: async (_edge, path) => {
      observed.push(path);
      return path.endsWith("/sync") ? new Response(null, { status: 204 }) : problem(404, "pi_thread_not_found");
    },
    submit: async () => ({
      ...admission, accepted: false, dispatch_required: false,
      request_status: "succeeded", attempt_status: "succeeded",
    }),
  });
  try {
    const response = await fixture.app.inject({
      method: "POST", url: `/api/pi/threads/${threadId}/messages`,
      headers: { "idempotency-key": key }, payload: sendPayload,
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, "interactive_attempt_succeeded");
    assert.equal(fixture.submitCalls(), 1);
    assert.equal(observed.some((path) => path.endsWith("/messages")), false);
  } finally { await fixture.app.close(); }
});

test("drifted Storage descriptor is rejected before canonical admission", async () => {
  const descriptor = {
    object_id: "obj_abcdefgh", object_ref: "storage-object:obj_abcdefgh", version_id: "v1",
    sha256: "a".repeat(64), byte_size: 10, mime_type: "text/plain", original_name: "a.txt",
    source: { version_id: "v1", sha256: "a".repeat(64), byte_size: 10, mime_type: "text/plain" }, expires_at: null,
  };
  let upstreamCalls = 0;
  const fixture = await appWith({
    request: async (edge) => {
      upstreamCalls++;
      assert.equal(edge, "api-to-storage");
      return new Response(JSON.stringify({ objects: [{
        ...descriptor, version_id: "v2",
        download: { url: "https://storage.test/object", expires_at: "2026-09-02T00:05:00.000Z" },
      }] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  try {
    const response = await fixture.app.inject({
      method: "POST", url: `/api/pi/threads/${threadId}/messages`, headers: { "idempotency-key": key },
      payload: { ...sendPayload, input: { content: "请讲解", mathpilotAttachments: [{ attachment_id: "att_abcdefgh", ...descriptor }] } },
    });
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().code, "invalid_pi_attachment");
    assert.equal(fixture.submitCalls(), 0);
    assert.equal(upstreamCalls, 1);
  } finally { await fixture.app.close(); }
});

test("Storage authorization rejection leaves canonical admission untouched", async () => {
  const descriptor = {
    object_id: "obj_abcdefgh", object_ref: "storage-object:obj_abcdefgh", version_id: "v1",
    sha256: "a".repeat(64), byte_size: 10, mime_type: "text/plain", original_name: "a.txt",
    source: { version_id: "v1", sha256: "a".repeat(64), byte_size: 10, mime_type: "text/plain" }, expires_at: null,
  };
  let piCalls = 0;
  const fixture = await appWith({ request: async (edge) => {
    if (edge === "api-to-pi") piCalls++;
    return problem(403, "storage_object_forbidden");
  } });
  try {
    const response = await fixture.app.inject({
      method: "POST", url: `/api/pi/threads/${threadId}/messages`, headers: { "idempotency-key": key },
      payload: { ...sendPayload, input: { content: "请讲解", mathpilotAttachments: [{ attachment_id: "att_abcdefgh", ...descriptor }] } },
    });
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().code, "invalid_pi_attachment");
    assert.equal(fixture.submitCalls(), 0);
    assert.equal(piCalls, 0);
  } finally { await fixture.app.close(); }
});

test("exact immutable attachment is authorized before provision and admission", async () => {
  const descriptor = {
    object_id: "obj_abcdefgh", object_ref: "storage-object:obj_abcdefgh", version_id: "v1",
    sha256: "a".repeat(64), byte_size: 10, mime_type: "text/plain", original_name: "a.txt",
    source: { version_id: "v1", sha256: "a".repeat(64), byte_size: 10, mime_type: "text/plain" }, expires_at: null,
  };
  const sequence: string[] = [];
  const fixture = await appWith({ request: async (edge, path, options) => {
    sequence.push(`${edge}:${path}`);
    if (edge === "api-to-storage") {
      assert.deepEqual(options.json, { object_refs: [descriptor.object_ref], download_intent: "attachment" });
      return new Response(JSON.stringify({ objects: [{
        ...descriptor,
        download: { url: "https://storage.test/object", expires_at: "2026-09-02T00:05:00.000Z" },
      }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(null, { status: 204 });
  } });
  try {
    const response = await fixture.app.inject({
      method: "POST", url: `/api/pi/threads/${threadId}/messages`, headers: { "idempotency-key": key },
      payload: { ...sendPayload, input: { content: "请讲解", mathpilotAttachments: [{ attachment_id: "att_abcdefgh", ...descriptor }] } },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(fixture.submitCalls(), 1);
    assert.equal(fixture.failCalls(), 0);
    assert.deepEqual(sequence, [
      "api-to-storage:/internal/objects/resolve",
      `api-to-pi:/pi/threads/${threadId}/sync`,
      `api-to-pi:/pi/threads/${threadId}/messages`,
    ]);
  } finally { await fixture.app.close(); }
});

test("dispatch compensation is exact, idempotent, and cannot overwrite a late success", async () => {
  const state = {
    operation: "running", request: "running", attempt: "started", errorCode: null as string | null,
  };
  let updates = 0;
  const client = {
    async query(text: string) {
      if (text === "begin" || text === "commit" || text === "rollback" || text.includes("set_config")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("select operation.requested_by_user_id")) return { rows: [{
        requested_by_user_id: principal.userId,
        operation_status: state.operation,
        request_status: state.request,
        attempt_status: state.attempt,
        error_code: state.errorCode,
        foreground_epoch_id: receipt.foreground_epoch_id,
        conversation_thread_id: receipt.conversation_thread_id,
        triggering_message_id: receipt.triggering_message_id,
        input_artifact_id: "art_abcdefgh",
        event_id: receipt.event_id,
        execution_driver: "interactive_epoch",
        driver_execution_id: receipt.driver_execution_id,
      }], rowCount: 1 };
      updates++;
      if (text.includes("update science_v3_agent_attempt")) { state.attempt = "failed"; state.errorCode = "dispatch_failed"; }
      else if (text.includes("update science_v3_operation")) state.operation = "failed";
      else if (text.includes("update science_v3_foreground_request")) state.request = "failed";
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const service = new LearningCommandService({ async connect() { return client; } } as never);
  assert.deepEqual(await service.failInteractiveDispatch(principal, receipt), {
    compensated: true, status: "failed", error_code: "dispatch_failed",
  });
  assert.equal(updates, 3);
  assert.deepEqual(await service.failInteractiveDispatch(principal, receipt), {
    compensated: false, status: "failed", error_code: "dispatch_failed",
  });
  assert.equal(updates, 3, "idempotent compensation must not write a second terminal");
  state.operation = "succeeded"; state.request = "succeeded"; state.attempt = "succeeded"; state.errorCode = null;
  await assert.rejects(() => service.failInteractiveDispatch(principal, receipt), /前台执行已由另一终态完成/);
  assert.equal(updates, 3, "a late successful Pi terminal cannot be overwritten");
});

test("failed and cancelled idempotent admissions are stable terminal conflicts", async () => {
  for (const terminal of ["failed", "cancelled"] as const) {
    let upstreamCalls = 0;
    const fixture = await appWith({
      request: async () => { upstreamCalls++; return new Response(null, { status: 204 }); },
      submit: async () => ({
        ...admission, accepted: false, dispatch_required: false,
        request_status: terminal, attempt_status: terminal,
      }),
    });
    try {
      const response = await fixture.app.inject({
        method: "POST", url: `/api/pi/threads/${threadId}/messages`,
        headers: { "idempotency-key": key }, payload: sendPayload,
      });
      assert.equal(response.statusCode, 409);
      assert.equal(response.json().code, `interactive_attempt_${terminal}`);
      assert.equal(fixture.submitCalls(), 1);
      assert.equal(upstreamCalls, 2, "terminal replay provisions before admission and then refreshes its mirror");
    } finally { await fixture.app.close(); }
  }
});

test("GET ignores only busy sync, preserves snapshot query, and mutations remain canonical-owned", async () => {
  const observed: Array<{ path: string; headers?: Record<string, string> }> = [];
  const fixture = await appWith({ request: async (_edge, path, options) => {
    observed.push({ path, headers: options.headers });
    if (path.endsWith("/sync")) return problem(409, "pi_thread_busy");
    if (path.includes("/events")) return new Response("data: {\"type\":\"snapshot\"}\n\n", {
      status: 200, headers: { "content-type": "text/event-stream" },
    });
    return new Response(JSON.stringify({ metadata: { id: threadId }, messages: [] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  } });
  try {
    const get = await fixture.app.inject({ method: "GET", url: `/api/pi/threads/${threadId}` });
    assert.equal(get.statusCode, 200);
    const events = await fixture.app.inject({
      method: "GET", url: `/api/pi/threads/${threadId}/events?snapshot=false`,
      headers: { accept: "text/event-stream", "last-event-id": "seq-7" },
    });
    assert.equal(events.statusCode, 200);
    assert.equal(observed.some((entry) => entry.path.endsWith(`/events?snapshot=false`)), true);
    assert.equal(observed.find((entry) => entry.path.includes("/events"))?.headers?.["last-event-id"], "seq-7");
    for (const mutation of [
      { method: "PATCH", url: `/api/pi/threads/${threadId}` },
      { method: "DELETE", url: `/api/pi/threads/${threadId}` },
      { method: "POST", url: `/api/pi/threads/${threadId}/archive` },
    ] as const) {
      const response = await fixture.app.inject(mutation);
      assert.equal(response.statusCode, 409);
      assert.equal(response.json().code, "canonical_thread_owned");
    }
    assert.ok(fixture.authCalls() >= 5);
  } finally { await fixture.app.close(); }
});
