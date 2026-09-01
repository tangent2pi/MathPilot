import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  commitArchiveTransition,
  commitUnarchiveTransition,
  containedLocalEntryExists,
  restoreArchivedThread,
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

test("snapshot failure leaves Pi and the durable archive pointer untouched", async () => {
  const events: string[] = [];
  await assert.rejects(commitArchiveTransition({
    principal,
    threadId: "thread-test",
    pi: {
      async archiveThread() { events.push("pi.archive"); },
      async unarchiveThread() { events.push("pi.unarchive"); },
    },
    store: {
      async commitArchiveState() {
        events.push("store.commit");
        return record(true);
      },
    },
    async createSnapshot() {
      events.push("snapshot");
      throw new Error("snapshot rejected");
    },
  }), /snapshot rejected/);
  assert.deepEqual(events, ["snapshot"]);
});

test("archive publishes one snapshot pointer last and compensates a DB failure", async () => {
  const events: string[] = [];
  const key = "pi-threads/thread-test/snapshot-test";
  await assert.rejects(commitArchiveTransition({
    principal,
    threadId: "thread-test",
    pi: {
      async archiveThread() { events.push("pi.archive"); },
      async unarchiveThread() { events.push("pi.unarchive"); },
    },
    store: {
      async commitArchiveState(_principal, _threadId, archived, minioKey) {
        events.push(`store.commit:${archived}:${minioKey}`);
        throw new Error("database unavailable");
      },
    },
    async createSnapshot() {
      events.push("snapshot");
      return key;
    },
  }), /database unavailable/);
  assert.deepEqual(events, ["snapshot", "pi.archive", `store.commit:true:${key}`, "pi.unarchive"]);
});

test("unarchive restores before changing state and compensates a DB failure", async () => {
  const events: string[] = [];
  await assert.rejects(commitUnarchiveTransition({
    principal,
    threadId: "thread-test",
    pi: {
      async archiveThread() { events.push("pi.archive"); },
      async unarchiveThread() { events.push("pi.unarchive"); },
    },
    store: {
      async commitArchiveState(_principal, _threadId, archived) {
        events.push(`store.commit:${archived}`);
        throw new Error("database unavailable");
      },
    },
    async restoreSnapshot() { events.push("restore"); },
  }), /database unavailable/);
  assert.deepEqual(events, ["restore", "pi.unarchive", "store.commit:false", "pi.archive"]);
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

test("a cold empty thread is not rehydrated as an archived Pi record", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mathpilot-pi-empty-thread-"));
  const sessionsRoot = path.join(root, "sessions");
  const agentSessionsRoot = path.join(root, "agent", "sessions");
  await Promise.all([
    mkdir(path.join(sessionsRoot, "thread-test"), { recursive: true }),
    mkdir(agentSessionsRoot, { recursive: true }),
  ]);
  const runtime = { runtimeRoot: root, sessionsRoot, agentSessionsRoot };
  const archivedRecord = { ...record(true), sessionDir: "sessions/thread-test" };
  let archiveCalls = 0;
  try {
    assert.equal(await restoreArchivedThread(runtime as never, archivedRecord, {
      async getThread() { throw new Error("Unknown Pi thread"); },
      async archiveThread() { archiveCalls += 1; },
    } as never), false);
    assert.equal(archiveCalls, 0);

    assert.equal(await restoreArchivedThread(runtime as never, archivedRecord, {
      async getThread() { return { metadata: { id: archivedRecord.threadId }, messages: [] }; },
      async archiveThread() { archiveCalls += 1; },
    } as never), true);
    assert.equal(archiveCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an active thread never hydrates from its retained archived snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mathpilot-pi-active-thread-"));
  const sessionsRoot = path.join(root, "sessions");
  const agentSessionsRoot = path.join(root, "agent", "sessions");
  await Promise.all([mkdir(sessionsRoot, { recursive: true }), mkdir(agentSessionsRoot, { recursive: true })]);
  let downloads = 0;
  try {
    assert.equal(await restoreArchivedThread(
      { runtimeRoot: root, sessionsRoot, agentSessionsRoot } as never,
      { ...record(false, "pi-threads/thread-test/old-snapshot"), sessionDir: "sessions/thread-test" },
      { async getThread() { throw new Error("Unknown Pi thread"); } } as never,
      {
        async downloadDirectory() { downloads += 1; },
        async downloadFile() { downloads += 1; },
      } as never,
    ), false);
    assert.equal(downloads, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
