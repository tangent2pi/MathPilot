import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  publishWorkspaceArtifacts,
  publishedArtifactContentType,
  readPublishedArtifact,
  type PublishedArtifact,
} from "../src/artifact-publisher.ts";

const SESSION_REF = "thread-artifact-policy";
const RESPONSE_POLICY = {
  required: false,
  allow_skip: true,
  allow_free_text_without_answer: true,
};
const MIME_BY_EXTENSION: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
};

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "mathpilot-artifact-policy-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function stageArtifact(
  workspace: string,
  artifactId: string,
  renderer: "native_card" | "sandboxed_html" | "media",
  entry: string,
  files: Record<string, string | Buffer>,
): Promise<void> {
  const root = path.join(workspace, "output", "artifacts", artifactId);
  await mkdir(root, { recursive: true });
  const declarations = [];
  for (const [relative, value] of Object.entries(files)) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), bytes);
    declarations.push({
      path: relative,
      mime_type: MIME_BY_EXTENSION[path.extname(relative)],
      byte_size: bytes.length,
      content_hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    });
  }
  await writeFile(path.join(root, "manifest.json"), JSON.stringify({
    schema: "mathpilot.learning-artifact/v1",
    artifact_id: artifactId,
    session_id: SESSION_REF,
    kind: renderer === "native_card" ? "question_card" : "knowledge_visualization",
    renderer,
    title: `Artifact ${artifactId}`,
    entry,
    files: declarations,
    response_policy: RESPONSE_POLICY,
  }));
}

function questionCard(artifactId: string): string {
  return JSON.stringify({
    schema: "mathpilot.question-card/v1",
    artifact_id: artifactId,
    card_id: "card_policy01",
    type: "short_answer",
    prompt: "Explain the next step.",
    evidence_policy: "teaching_only",
    response_policy: RESPONSE_POLICY,
  });
}

test("active renderer and file types have no published content type", () => {
  assert.equal(publishedArtifactContentType(".html"), null);
  assert.equal(publishedArtifactContentType(".JS"), null);
  assert.equal(publishedArtifactContentType(".svg"), null);
  assert.equal(publishedArtifactContentType(".unknown"), null);
  assert.equal(publishedArtifactContentType(".json"), "application/json; charset=utf-8");
  assert.equal(publishedArtifactContentType(".png"), "image/png");
});

test("publisher rejects sandboxed HTML before it can enter the published index", async () => {
  await withWorkspace(async (workspace) => {
    const artifactId = "art_sandbox01";
    await stageArtifact(workspace, artifactId, "sandboxed_html", "index.html", {
      "index.html": "<!doctype html><title>active</title>",
    });
    await assert.rejects(
      publishWorkspaceArtifacts(workspace, SESSION_REF, artifactId),
      /invalid artifact type/,
    );
  });
});

test("publisher rejects HTML, JavaScript, and SVG payloads under the media renderer", async (t) => {
  const cases = [
    ["art_htmlfile", "media/page.html", "<!doctype html><title>active</title>"],
    ["art_jsfile00", "media/app.js", "globalThis.compromised = true"],
    ["art_svgfile0", "media/figure.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"><circle r=\"4\"/></svg>"],
  ] as const;
  for (const [artifactId, entry, body] of cases) {
    await t.test(path.extname(entry), async () => {
      await withWorkspace(async (workspace) => {
        await stageArtifact(workspace, artifactId, "media", entry, { [entry]: body });
        await assert.rejects(
          publishWorkspaceArtifacts(workspace, SESSION_REF, artifactId),
          /active or unsupported artifact file type is forbidden/,
        );
      });
    });
  }
});

test("publisher and reader retain native cards and passive raster media", async () => {
  await withWorkspace(async (workspace) => {
    const cardId = "art_native01";
    const imageId = "art_pngmedia";
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    await stageArtifact(workspace, cardId, "native_card", "card.json", {
      "card.json": questionCard(cardId),
    });
    await stageArtifact(workspace, imageId, "media", "media/figure.png", {
      "media/figure.png": png,
    });

    const published = await publishWorkspaceArtifacts(workspace, SESSION_REF);
    assert.deepEqual(new Set(published.map((artifact) => artifact.artifact_id)), new Set([cardId, imageId]));
    assert.equal((await readPublishedArtifact(workspace, cardId, "card.json"))?.extension, ".json");
    assert.deepEqual((await readPublishedArtifact(workspace, imageId, "media/figure.png"))?.bytes, png);
  });
});

test("legacy published index reads fail closed for active renderer and file types", async () => {
  await withWorkspace(async (workspace) => {
    const cases = [
      { artifactId: "art_oldhtml0", renderer: "sandboxed_html", file: "style.css", bytes: Buffer.from("body{}") },
      { artifactId: "art_oldhtml1", renderer: "media", file: "page.html", bytes: Buffer.from("<!doctype html>") },
      { artifactId: "art_oldjs000", renderer: "media", file: "app.js", bytes: Buffer.from("alert(1)") },
      { artifactId: "art_oldsvg00", renderer: "media", file: "figure.svg", bytes: Buffer.from("<svg/>") },
      { artifactId: "art_oldpng00", renderer: "media", file: "figure.png", bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) },
    ] as const;
    const index: PublishedArtifact[] = [];
    for (const item of cases) {
      const root = path.join(workspace, ".agent", "published", item.artifactId);
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, item.file), item.bytes);
      index.push({
        artifact_id: item.artifactId,
        kind: "image",
        artifact_kind: "knowledge_visualization",
        renderer: item.renderer,
        title: item.artifactId,
        artifact_ref: `artifact://${SESSION_REF}/${item.artifactId}`,
        uri: `/artifacts/${item.artifactId}/${item.file}`,
        entrypoint: item.file,
        manifest_hash: "sha256:legacy",
        interaction_token: "legacy",
        manifest: {
          schema: "mathpilot.learning-artifact/v1",
          artifact_id: item.artifactId,
          session_id: SESSION_REF,
          kind: "knowledge_visualization",
          renderer: item.renderer,
          title: item.artifactId,
          entry: item.file,
          files: [],
          response_policy: RESPONSE_POLICY,
        },
      });
    }
    await writeFile(path.join(workspace, ".agent", "published-artifacts.json"), JSON.stringify(index));

    for (const item of cases.slice(0, 4)) {
      assert.equal(await readPublishedArtifact(workspace, item.artifactId, item.file), null);
    }
    assert.deepEqual(
      (await readPublishedArtifact(workspace, "art_oldpng00", "figure.png"))?.bytes,
      cases[4].bytes,
    );
  });
});
