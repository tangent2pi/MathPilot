import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { publishWorkspaceArtifacts, readPublishedArtifact } from "../src/artifact-publisher.ts";

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agmath-artifact-"));
  await mkdir(path.join(root, "output", "artifacts", "art_demo1234"), { recursive: true });
  await mkdir(path.join(root, ".agent"), { recursive: true });
  return root;
}

async function writeHtmlArtifact(root: string, html: string): Promise<void> {
  const artifact = path.join(root, "output", "artifacts", "art_demo1234");
  const bytes = Buffer.from(html);
  await writeFile(path.join(artifact, "index.html"), bytes);
  await writeFile(path.join(artifact, "manifest.json"), JSON.stringify({
    schema: "agmath.learning-artifact/v1", artifact_id: "art_demo1234", session_id: "s_demo1234",
    kind: "knowledge_visualization", renderer: "sandboxed_html", title: "正弦函数交互演示", entry: "index.html",
    files: [{ path: "index.html", mime_type: "text/html", byte_size: bytes.length, content_hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }],
    response_policy: { required: false, allow_skip: true, allow_free_text_without_answer: true },
  }));
}

test("publishes a validated immutable sandboxed HTML artifact", async () => {
  const root = await workspace();
  try {
    const artifact = path.join(root, "output", "artifacts", "art_demo1234");
    await writeHtmlArtifact(root, "<!doctype html><button id=b>提交</button><script>b.onclick=()=>parent.postMessage({type:'card.skipped'},'*')</script>");
    const published = await publishWorkspaceArtifacts(root, "s_demo1234");
    assert.equal(published.length, 1);
    assert.equal(published[0]?.kind, "html");
    assert.equal(published[0]?.artifact_ref, "artifact://s_demo1234/art_demo1234");
    assert.match(published[0]?.uri ?? "", /^\/api\/sessions\/s_demo1234\/artifacts\/art_demo1234\/index\.html$/);
    const bytes = await readPublishedArtifact(root, "art_demo1234", "index.html");
    assert.match(bytes?.bytes.toString("utf8") ?? "", /postMessage/);
    assert.deepEqual(await publishWorkspaceArtifacts(root, "s_demo1234"), [], "unchanged candidate is not re-announced on a later Pi turn");
    await writeFile(path.join(artifact, "index.html"), "mutated candidate");
    const immutable = await readPublishedArtifact(root, "art_demo1234", "index.html");
    assert.match(immutable?.bytes.toString("utf8") ?? "", /postMessage/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects HTML that attempts network access", async () => {
  const root = await workspace();
  try {
    await writeHtmlArtifact(root, "<script>fetch('https://example.com')</script>");
    await assert.rejects(publishWorkspaceArtifacts(root, "s_demo1234"), /network, storage, forms, or cookie/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
