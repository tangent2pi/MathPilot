import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bindAttachmentTurn,
  findAttachmentTurn,
  releaseAttachmentTurn,
  savePendingAttachment,
  type AttachmentTurn,
  type WorkspaceAttachment,
} from "../extensions/attachments/manifest.ts";

const ATTACHMENT_ID = "11111111-1111-4111-8111-111111111111";
const TURN_ID = "22222222-2222-4222-8222-222222222222";

const attachment: WorkspaceAttachment = {
  id: ATTACHMENT_ID,
  originalName: "作业.pdf",
  workspacePath: "input/original/作业.pdf",
  mimeType: "application/pdf",
  byteSize: 123,
  uploadedAt: "2026-08-30T00:00:00.000Z",
};

const turn: AttachmentTurn = {
  version: 1,
  id: TURN_ID,
  prompt: "请分析这个文件",
  attachmentIds: [ATTACHMENT_ID],
  createdAt: "2026-08-30T00:00:01.000Z",
};

const withWorkspace = async (run: (workspace: string) => Promise<void>) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "mathpilot-attachments-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
};

test("binds a server-issued attachment to the matching prompt exactly once", async () => {
  await withWorkspace(async (workspace) => {
    await savePendingAttachment(workspace, attachment);
    await bindAttachmentTurn(workspace, turn);

    const match = await findAttachmentTurn(workspace, turn.prompt, new Set());
    assert.deepEqual(match, { turn, attachments: [attachment] });
    assert.equal(await findAttachmentTurn(workspace, "另一条消息", new Set()), undefined);
    assert.equal(await findAttachmentTurn(workspace, turn.prompt, new Set([TURN_ID])), undefined);
  });
});

test("an attachment id cannot be rebound to another turn", async () => {
  await withWorkspace(async (workspace) => {
    await savePendingAttachment(workspace, attachment);
    await bindAttachmentTurn(workspace, turn);

    await assert.rejects(
      bindAttachmentTurn(workspace, { ...turn, id: "33333333-3333-4333-8333-333333333333" }),
    );
  });
});

test("a rejected Pi send can release and rebind the attachment", async () => {
  await withWorkspace(async (workspace) => {
    await savePendingAttachment(workspace, attachment);
    await bindAttachmentTurn(workspace, turn);
    await releaseAttachmentTurn(workspace, turn);

    const retry = { ...turn, id: "44444444-4444-4444-8444-444444444444" };
    await bindAttachmentTurn(workspace, retry);
    assert.equal((await findAttachmentTurn(workspace, retry.prompt, new Set()))?.turn.id, retry.id);
  });
});
