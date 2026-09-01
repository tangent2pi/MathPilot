import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ImmutableObjectDescriptor } from "@mathpilot/content-integrity";
import {
  candidateSourceObjects,
  materializeHostSourceManifest,
  parseHostSourceManifest,
  readHostSourceManifest,
  writeHostSourceManifest,
  type HostSourceManifest,
} from "../extensions/lib/host-source-manifest.ts";

const bytes = Buffer.from("verified source");
const digest = createHash("sha256").update(bytes).digest("hex");
const descriptor: ImmutableObjectDescriptor = {
  object_id: "obj_source01",
  object_ref: "storage-object:obj_source01",
  version_id: "version-source-01",
  sha256: digest,
  byte_size: bytes.byteLength,
  mime_type: "text/plain",
  original_name: "source.txt",
  source: {
    version_id: "source-version-01",
    sha256: digest,
    byte_size: bytes.byteLength,
    mime_type: "text/plain",
  },
  expires_at: null,
};
const manifest: HostSourceManifest = {
  schema: "mathpilot.pi-source-manifest/v1",
  source_objects: [{ workspace_path: "input/original/source.txt", descriptor }],
};

test("host source manifests are strict, non-empty, and stored outside the model workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mathpilot-pi-source-manifest-"));
  const workspace = path.join(root, "thread-one");
  await mkdir(workspace);
  try {
    await writeHostSourceManifest(workspace, manifest);
    assert.deepEqual(await readHostSourceManifest(workspace), manifest);
    assert.equal(
      await readFile(path.join(root, ".host-state", "thread-one", "source-manifest.json"), "utf8")
        .then(() => true),
      true,
    );
    await assert.rejects(readFile(path.join(workspace, "source-manifest.json"), "utf8"));
    assert.throws(
      () => parseHostSourceManifest({ ...manifest, unexpected: true }),
      /invalid or empty/,
    );
    assert.throws(
      () => parseHostSourceManifest({ ...manifest, source_objects: [] }),
      /invalid or empty/,
    );
    assert.throws(
      () => parseHostSourceManifest({
        ...manifest,
        source_objects: [{ workspace_path: "input/original/..", descriptor }],
      }),
      /workspace_path is invalid/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi stages verified Storage objects before replacing input/original", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mathpilot-pi-source-project-"));
  const workspace = path.join(root, "thread-one");
  const original = path.join(workspace, "input", "original");
  await mkdir(original, { recursive: true });
  await writeFile(path.join(original, "stale.txt"), "stale");
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-length": String(bytes.byteLength),
      "content-type": "text/plain",
    });
    response.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  let resolves = 0;
  const internalService = {
    async request(edge: string, _actor: unknown, route: string, options: { json?: unknown }) {
      resolves += 1;
      assert.equal(edge, "pi-to-storage");
      assert.equal(route, "/internal/objects/resolve");
      assert.deepEqual(options.json, { object_refs: [descriptor.object_ref] });
      return new Response(JSON.stringify({
        objects: [{
          ...descriptor,
          download: {
            url: `http://127.0.0.1:${address.port}/source`,
            expires_at: new Date(Date.now() + 60_000).toISOString(),
          },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  try {
    const input = {
      workspace,
      manifest,
      actor: {
        tenantId: "tnt_test",
        userId: "usr_teacher",
        roles: ["teacher"] as const,
      },
      internalService: internalService as never,
      signal: AbortSignal.timeout(10_000),
    };
    await materializeHostSourceManifest(input);
    assert.equal(await readFile(path.join(original, "source.txt"), "utf8"), bytes.toString());
    await assert.rejects(readFile(path.join(original, "stale.txt"), "utf8"));
    assert.deepEqual(await readHostSourceManifest(workspace), manifest);

    await rm(path.join(original, "source.txt"));
    await writeFile(path.join(original, "source.txt"), "tampered source");
    assert.equal((await readFile(path.join(original, "source.txt"))).byteLength, bytes.byteLength);
    await materializeHostSourceManifest(input);
    assert.equal(resolves, 2, "a replay must verify bytes through the shared resolver");
    assert.equal(await readFile(path.join(original, "source.txt"), "utf8"), bytes.toString());
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("KTQ source paths must be backed by the immutable host manifest", () => {
  assert.deepEqual(candidateSourceObjects("ktq", {
    questions: [{
      source: { path: "input/original/source.txt", page: 1 },
      image_refs: ["input/original/source.txt"],
    }],
  }, manifest), manifest.source_objects);

  assert.throws(() => candidateSourceObjects("ktq", {
    questions: [{ source_fragment_id: "fragment-only", image_refs: [] }],
  }, manifest), /no object-backed source/);
  assert.throws(() => candidateSourceObjects("ktq", {
    questions: [{
      source: { path: "input/original/unbound.txt", page: 1 },
      image_refs: [],
    }],
  }, manifest), /outside its host manifest/);
});
