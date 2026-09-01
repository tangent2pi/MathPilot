import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  containedLocalEntryExists,
  localThreadAvailable,
} from "../src/pi-chat-routes.ts";
import type { PiPrincipal, PiThreadRecord } from "../src/pi-thread-store.ts";

const principal: PiPrincipal = {
  tenantId: "tenant-test",
  userId: "user-test",
  roles: ["student"],
};

const record = (archived: boolean, minioKey?: string): PiThreadRecord => ({
  threadId: "thread-test",
  tenantId: principal.tenantId,
  ownerUserId: principal.userId,
  sessionDir: "sessions/00000000-0000-4000-8000-000000000001",
  sessionFile: "agent/sessions/thread-test.jsonl",
  createdAt: "2026-09-01T00:00:00.000Z",
  ...(minioKey ? { minioKey } : {}),
  ...(archived ? { archivedAt: "2026-09-01T00:00:01.000Z" } : {}),
});

test("existing local archive paths reject symlinks, including broken links", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mathpilot-pi-local-path-"));
  const sessionsRoot = path.join(root, "sessions");
  const outside = path.join(root, "outside");
  await Promise.all([mkdir(sessionsRoot), mkdir(outside)]);
  try {
    const workspace = path.join(sessionsRoot, "thread-test");
    await mkdir(workspace);
    assert.equal(await containedLocalEntryExists(sessionsRoot, workspace, "directory"), true);

    const sessionFile = path.join(sessionsRoot, "thread-test.jsonl");
    await writeFile(sessionFile, "{}\n");
    assert.equal(await containedLocalEntryExists(sessionsRoot, sessionFile, "file"), true);

    const outsideLink = path.join(sessionsRoot, "outside-link");
    await symlink(outside, outsideLink, "dir");
    await assert.rejects(
      containedLocalEntryExists(sessionsRoot, outsideLink, "directory"),
      /symlinks are forbidden/,
    );

    const brokenLink = path.join(sessionsRoot, "broken-link");
    await symlink(path.join(root, "missing"), brokenLink);
    await assert.rejects(
      containedLocalEntryExists(sessionsRoot, brokenLink, "file"),
      /symlinks are forbidden/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a cold empty live thread is available only while Pi still owns it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mathpilot-pi-empty-thread-"));
  const sessionsRoot = path.join(root, "sessions");
  const agentSessionsRoot = path.join(root, "agent", "sessions");
  await Promise.all([
    mkdir(path.join(sessionsRoot, "thread-test"), { recursive: true }),
    mkdir(agentSessionsRoot, { recursive: true }),
  ]);
  const runtime = { runtimeRoot: root, sessionsRoot, agentSessionsRoot };
  const activeRecord = { ...record(false), sessionDir: "sessions/thread-test" };
  try {
    assert.equal(await localThreadAvailable(runtime as never, activeRecord, {
      async getThread() { throw new Error("Unknown Pi thread"); },
    } as never), false);

    assert.equal(await localThreadAvailable(runtime as never, activeRecord, {
      async getThread() { return { metadata: { id: activeRecord.threadId }, messages: [] }; },
    } as never), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retired archive metadata fails closed instead of restoring through MinIO", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mathpilot-pi-active-thread-"));
  const sessionsRoot = path.join(root, "sessions");
  const agentSessionsRoot = path.join(root, "agent", "sessions");
  await Promise.all([mkdir(sessionsRoot, { recursive: true }), mkdir(agentSessionsRoot, { recursive: true })]);
  try {
    assert.equal(await localThreadAvailable(
      { runtimeRoot: root, sessionsRoot, agentSessionsRoot } as never,
      { ...record(true, "pi-threads/thread-test/old-snapshot"), sessionDir: "sessions/thread-test" },
      { async getThread() { throw new Error("Unknown Pi thread"); } } as never,
    ), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
