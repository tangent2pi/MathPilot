import assert from "node:assert/strict";
import test from "node:test";
import {
  interactiveReceiptBinding,
  parseInteractiveAdmissionReceipt,
  parseInteractiveAttemptBinding,
  parseInteractivePrepareResponse,
  parseInteractiveWorkspaceProjection,
} from "../src/index.ts";

const receipt = {
  operation_id: "op_abcdefgh",
  foreground_request_id: "fgr_abcdefgh",
  conversation_thread_id: "thr_abcdefgh",
  foreground_epoch_id: "fge_abcdefgh",
  triggering_message_id: "msg_abcdefgh",
  event_id: "evt_abcdefgh",
  agent_attempt_id: "agt_abcdefgh",
  input_ref: "agent-artifact:art_abcdefgh",
  driver_execution_id: "interactive-epoch:fge_abcdefgh:fgr_abcdefgh",
  execution_driver: "interactive_epoch" as const,
};

test("interactive admission receipt is strict and preserves its driver binding", () => {
  assert.deepEqual(parseInteractiveAdmissionReceipt(receipt), receipt);
  assert.throws(() => parseInteractiveAdmissionReceipt({ ...receipt, dispatch_required: true }));
  assert.throws(() => parseInteractiveAdmissionReceipt({
    ...receipt,
    driver_execution_id: "interactive-epoch:fge_other000:fgr_abcdefgh",
  }));
});

test("interactive callback binding is one shared receipt projection", () => {
  const binding = interactiveReceiptBinding(parseInteractiveAdmissionReceipt(receipt));
  assert.deepEqual(parseInteractiveAttemptBinding(binding), binding);
  assert.deepEqual(Object.keys(binding).sort(), [
    "conversation_thread_id", "driver_execution_id", "foreground_epoch_id",
    "foreground_request_id", "input_ref", "operation_id", "triggering_message_id",
  ]);
});

const workspaceProjection = {
  snapshotVersion: 3,
  generatedAt: "2026-09-04T05:36:31.629Z",
  accountUserId: "usr_student01",
  roles: ["student"] as const,
  files: [{ path: "sessions/thr_abcdefgh/消息-0001.jsonl", content: "{}\n" }],
  objects: [{ path: "objects/obj_abcdefgh/题图.png", descriptor: { owned_by: "content-integrity" } }],
  manifest: {
    schema: "mathpilot.agent-context-manifest/v1" as const,
    manifest_ref: "agent-context:op_abcdefgh",
    foreground_epoch_id: "fge_abcdefgh",
    snapshot_version: 3,
    generated_at: "2026-09-04T05:36:31.629Z",
    items: [{
      kind: "current_thread" as const,
      resource_ref: "conversation-thread:thr_abcdefgh",
      label: "当前对话",
      freshness: "2026-09-04T05:36:31.629Z",
      href: "/c/thr_abcdefgh",
      version: 2,
    }],
  },
};

test("interactive prepare uses one strict full WorkspaceProjection envelope", () => {
  assert.deepEqual(parseInteractiveWorkspaceProjection(workspaceProjection), workspaceProjection);
  assert.deepEqual(parseInteractivePrepareResponse({
    schema: "mathpilot.interactive-prepare/v1",
    frozen_input: { conversation_thread_id: "thr_abcdefgh" },
    workspace_projection: workspaceProjection,
  }).workspace_projection, workspaceProjection);
  assert.throws(() => parseInteractiveWorkspaceProjection({ ...workspaceProjection, unexpected: true }));
  assert.throws(() => parseInteractiveWorkspaceProjection({
    ...workspaceProjection,
    files: [{ path: "../secret", content: "x" }],
  }));
  assert.throws(() => parseInteractiveWorkspaceProjection({
    ...workspaceProjection,
    manifest: { ...workspaceProjection.manifest, snapshot_version: 4 },
  }));
});
