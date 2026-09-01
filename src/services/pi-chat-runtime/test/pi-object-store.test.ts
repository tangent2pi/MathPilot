import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  PiObjectStore,
  parseMinioEndpoint,
  type PiObjectClient,
} from "../src/pi-object-store.ts";

class MemoryObjectClient implements PiObjectClient {
  readonly objects = new Map<string, Buffer>();
  putCalls = 0;
  getCalls = 0;
  failGetAt?: number;

  async bucketExists(): Promise<boolean> {
    return true;
  }

  async makeBucket(): Promise<void> {}

  async putObject(_bucket: string, objectName: string, stream: Readable, size: number): Promise<void> {
    this.putCalls += 1;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    assert.equal(bytes.length, size);
    this.objects.set(objectName, bytes);
  }

  listObjectsV2(_bucket: string, prefix: string): AsyncIterable<{ name: string; size: number }> {
    return Readable.from([...this.objects.entries()]
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, bytes]) => ({ name, size: bytes.length })));
  }

  async statObject(_bucket: string, objectName: string): Promise<{ size: number }> {
    const bytes = this.objects.get(objectName);
    if (!bytes) throw new Error("object not found");
    return { size: bytes.length };
  }

  async fGetObject(_bucket: string, objectName: string, filePath: string): Promise<void> {
    this.getCalls += 1;
    if (this.failGetAt === this.getCalls) throw new Error("injected object download failure");
    const bytes = this.objects.get(objectName);
    if (!bytes) throw new Error("object not found");
    await writeFile(filePath, bytes, { flag: "wx" });
  }
}

const config = {
  endpoint: "http://minio:9000",
  accessKey: "test-access",
  secretKey: "test-secret",
  bucket: "mathpilot-test",
};

const withTempRoot = async (run: (root: string) => Promise<void>) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mathpilot-pi-object-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("MinIO endpoint accepts the Compose URL and rejects ambiguous configuration", () => {
  assert.deepEqual(parseMinioEndpoint("http://minio:9000"), { host: "minio", port: 9000, useSSL: false });
  assert.deepEqual(parseMinioEndpoint("minio:9000", true), { host: "minio", port: 9000, useSSL: true });
  assert.throws(() => parseMinioEndpoint("https://minio:9000/path"), /only a host/);
  assert.throws(() => parseMinioEndpoint("https://minio:9000", false), /conflicts/);
});

test("a contained nested workspace and session file round-trip without buffering whole files", async () => {
  await withTempRoot(async (root) => {
    const sessionsRoot = path.join(root, "sessions");
    const agentSessionsRoot = path.join(root, "agent-sessions");
    const workspace = path.join(sessionsRoot, "thread-1");
    const sessionFile = path.join(agentSessionsRoot, "thread-1.jsonl");
    await Promise.all([
      mkdir(path.join(workspace, "output", "推导"), { recursive: true }),
      mkdir(agentSessionsRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(workspace, "output", "推导", "答案.txt"), "x² + y²"),
      writeFile(sessionFile, "{\"type\":\"message\"}\n"),
    ]);

    const client = new MemoryObjectClient();
    const store = new PiObjectStore(config, client);
    const prefix = "pi-threads/thread-1/snapshot-1";
    assert.equal(
      await store.uploadDirectory(`${prefix}/workspace/`, workspace, sessionsRoot),
      `${prefix}/workspace`,
    );
    await store.uploadFile(`${prefix}/session.jsonl`, sessionFile, agentSessionsRoot);
    assert.equal(client.putCalls, 2);

    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(sessionFile, { force: true }),
    ]);
    await store.downloadDirectory(`${prefix}/workspace/`, workspace, sessionsRoot);
    await store.downloadFile(`${prefix}/session.jsonl`, sessionFile, agentSessionsRoot);
    assert.equal(await readFile(path.join(workspace, "output", "推导", "答案.txt"), "utf8"), "x² + y²");
    assert.equal(await readFile(sessionFile, "utf8"), "{\"type\":\"message\"}\n");
  });
});

test("file, directory, root symlinks and non-regular entries are rejected before MinIO writes", async () => {
  await withTempRoot(async (root) => {
    const sessionsRoot = path.join(root, "sessions");
    const workspace = path.join(sessionsRoot, "thread-1");
    const outside = path.join(root, "outside.txt");
    await Promise.all([
      mkdir(path.join(workspace, "output"), { recursive: true }),
      writeFile(outside, "host secret"),
    ]);
    const client = new MemoryObjectClient();
    const store = new PiObjectStore(config, client);

    await symlink(outside, path.join(workspace, "output", "leak.txt"));
    await assert.rejects(
      store.uploadDirectory("pi-threads/thread-1/snapshot/workspace/", workspace, sessionsRoot),
      /symlinks are forbidden/,
    );
    assert.equal(client.putCalls, 0);
    await rm(path.join(workspace, "output", "leak.txt"));

    await symlink(root, path.join(workspace, "output", "outside-dir"), "dir");
    await assert.rejects(
      store.uploadDirectory("pi-threads/thread-1/snapshot/workspace/", workspace, sessionsRoot),
      /symlinks are forbidden/,
    );
    await rm(path.join(workspace, "output", "outside-dir"));

    const rootLink = path.join(sessionsRoot, "thread-link");
    await symlink(workspace, rootLink, "dir");
    await assert.rejects(
      store.uploadDirectory("pi-threads/thread-1/snapshot/workspace/", rootLink, sessionsRoot),
      /archive root must be a real directory/,
    );

    const socketPath = path.join(workspace, "output", "agent.sock");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      await assert.rejects(
        store.uploadDirectory("pi-threads/thread-1/snapshot/workspace/", workspace, sessionsRoot),
        /regular files/,
      );
      assert.equal(client.putCalls, 0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test("object traversal, absolute-like names, backslashes and prefix mismatch never reach fGetObject", async (t) => {
  const prefix = "pi-threads/thread-1/snapshot/workspace/";
  const cases = [
    `${prefix}../escape.txt`,
    `${prefix}/absolute.txt`,
    `${prefix}dir\\escape.txt`,
    `pi-threads/other/snapshot/workspace/file.txt`,
  ];
  for (const objectName of cases) {
    await t.test(objectName, async () => {
      await withTempRoot(async (root) => {
        const sessionsRoot = path.join(root, "sessions");
        await mkdir(sessionsRoot);
        const client = new MemoryObjectClient();
        client.objects.set(objectName, Buffer.from("escape"));
        if (!objectName.startsWith(prefix)) {
          const originalList = client.listObjectsV2.bind(client);
          client.listObjectsV2 = () => Readable.from([{ name: objectName, size: 6 }]);
          void originalList;
        }
        const store = new PiObjectStore(config, client);
        await assert.rejects(
          store.downloadDirectory(prefix, path.join(sessionsRoot, "thread-1"), sessionsRoot),
          /invalid|escaped/,
        );
        assert.equal(client.getCalls, 0);
        assert.equal(existsSync(path.join(root, "escape.txt")), false);
      });
    });
  }
});

test("failed directory hydration leaves no final workspace and can be retried", async () => {
  await withTempRoot(async (root) => {
    const sessionsRoot = path.join(root, "sessions");
    const workspace = path.join(sessionsRoot, "thread-1");
    const prefix = "pi-threads/thread-1/snapshot/workspace/";
    await mkdir(sessionsRoot);
    const client = new MemoryObjectClient();
    client.objects.set(`${prefix}a.txt`, Buffer.from("a"));
    client.objects.set(`${prefix}nested/b.txt`, Buffer.from("b"));
    client.failGetAt = 2;
    const store = new PiObjectStore(config, client);

    await assert.rejects(store.downloadDirectory(prefix, workspace, sessionsRoot), /injected/);
    assert.equal(existsSync(workspace), false);
    assert.equal((await readdir(sessionsRoot)).some((name) => name.includes(".restore-")), false);

    client.failGetAt = undefined;
    client.getCalls = 0;
    await store.downloadDirectory(prefix, workspace, sessionsRoot);
    assert.equal(await readFile(path.join(workspace, "a.txt"), "utf8"), "a");
    assert.equal(await readFile(path.join(workspace, "nested", "b.txt"), "utf8"), "b");
  });
});

test("archive file and byte ceilings fail before object-store side effects", async () => {
  await withTempRoot(async (root) => {
    const sessionsRoot = path.join(root, "sessions");
    const workspace = path.join(sessionsRoot, "thread-1");
    await mkdir(workspace, { recursive: true });
    await Promise.all([
      writeFile(path.join(workspace, "one.txt"), "1"),
      writeFile(path.join(workspace, "two.txt"), "2"),
    ]);
    const client = new MemoryObjectClient();
    const store = new PiObjectStore({ ...config, maxArchiveFiles: 1, maxArchiveBytes: 1 }, client);
    await assert.rejects(
      store.uploadDirectory("pi-threads/thread-1/snapshot/workspace/", workspace, sessionsRoot),
      /file count limit/,
    );
    assert.equal(client.putCalls, 0);

    const oversizedSession = path.join(root, "oversized-session.jsonl");
    await writeFile(oversizedSession, "12");
    await assert.rejects(
      store.uploadFile("pi-threads/thread-1/snapshot/session.jsonl", oversizedSession, root),
      /byte limit/,
    );
    assert.equal(client.putCalls, 0);

    const key = "pi-threads/thread-1/snapshot/session.jsonl";
    client.objects.set(key, Buffer.from("12"));
    await assert.rejects(
      store.downloadFile(key, path.join(root, "session.jsonl"), root),
      /byte limit/,
    );
    assert.equal(client.getCalls, 0);
    assert.equal(existsSync(path.join(root, "session.jsonl")), false);
  });
});
