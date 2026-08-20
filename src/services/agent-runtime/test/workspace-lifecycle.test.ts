import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";

test("Session Capsule audits evidence and compacts only the selected lifecycle", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "mathpilot-workspace-lifecycle-"));
  process.env.WORKSPACE_ROOT = path.join(temporary, "workspaces");
  process.env.CONTENT_ARTIFACT_ROOT = path.join(temporary, "content-artifacts");
  process.env.PI_SESSION_ROOT = path.join(temporary, "pi-sessions");
  await mkdir(path.join(process.env.CONTENT_ARTIFACT_ROOT, "tnt/source"), { recursive: true });
  await writeFile(path.join(process.env.CONTENT_ARTIFACT_ROOT, "tnt/source/original.txt"), "original evidence\n");

  const { createWorkspace, finalizeWorkspaceRun, compactExpiredFailedWorkspaces } = await import(`../src/workspace.ts?test=${Date.now()}`);
  const ktq = await createWorkspace("tnt", "run_ktq_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", { task_type: "ktq_extract" }, "agents", [
    { artifactRef: "tnt/source/original.txt", workspacePath: "sources/doc/original/original.txt" },
  ]);
  await writeFile(path.join(ktq.root, "output", "ktq-result.json"), "{}\n");
  await mkdir(path.join(ktq.root, "output", "ocr-evidence"), { recursive: true });
  await writeFile(path.join(ktq.root, "output", "ocr-evidence", "page.json"), "{}\n");
  await writeFile(path.join(ktq.root, "tmp", "scratch.txt"), "scratch\n");
  const ktqCapsule = await finalizeWorkspaceRun("tnt", "run_ktq_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
    status: "completed", lifecycle: "terminal", taskType: "ktq_extract",
  });
  await assert.rejects(stat(path.join(ktq.root, "input", "sources", "doc", "original", "original.txt")));
  await assert.rejects(stat(path.join(ktq.root, "tmp", "scratch.txt")));
  assert.equal((await readFile(path.join(ktq.root, "output", "ktq-result.json"), "utf8")).trim(), "{}");
  const ktqManifest = JSON.parse(await readFile(path.join(ktq.root, ktqCapsule.manifest), "utf8"));
  assert.ok(ktqManifest.inventory.some((item: { path: string; retention: string }) =>
    item.path === "input/sources/doc/original/original.txt" && item.retention === "source_copy"));

  const er = await createWorkspace("tnt", "run_er_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", { task_type: "er_research" }, "agents", [], [], [{
    sessionRef: "run_ktq_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", sourcePath: "output", workspacePath: "ktq-evidence",
  }]);
  assert.equal((await readFile(path.join(er.root, "input", "ktq-evidence", "ktq-result.json"), "utf8")).trim(), "{}");
  assert.equal((await readFile(path.join(er.root, "input", "ktq-evidence", "ocr-evidence", "page.json"), "utf8")).trim(), "{}");

  await writeFile(path.join(er.root, "tmp", "debug.txt"), "debug\n");
  const failedTranscriptDirectory = path.join(process.env.PI_SESSION_ROOT, "tnt", "run_er_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  await mkdir(failedTranscriptDirectory, { recursive: true });
  const failedTranscript = path.join(failedTranscriptDirectory, "session.jsonl");
  await writeFile(failedTranscript, '{"role":"assistant","content":"failure evidence"}\n');
  await finalizeWorkspaceRun("tnt", "run_er_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", {
    status: "failed", lifecycle: "terminal", taskType: "er_research", detail: "fixture failure",
  });
  assert.equal((await readFile(path.join(er.root, "tmp", "debug.txt"), "utf8")).trim(), "debug");
  const failedState = JSON.parse(await readFile(path.join(er.root, ".agent", "capsule", "state.json"), "utf8"));
  assert.equal(failedState.status, "failed");
  failedState.failure_retain_until = "2000-01-01T00:00:00.000Z";
  await writeFile(path.join(er.root, ".agent", "capsule", "state.json"), JSON.stringify(failedState));
  assert.deepEqual(await compactExpiredFailedWorkspaces(new Date("2000-01-02T00:00:00.000Z")), { compacted: 1 });
  await assert.rejects(stat(path.join(er.root, "tmp", "debug.txt")));
  await assert.rejects(stat(failedTranscript));
  const transcriptIndex = (await readFile(path.join(er.root, ".agent", "capsule", "transcripts", "index.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(transcriptIndex.length, 1);
  assert.equal(transcriptIndex[0].raw_byte_size, 50);
  const archivedTranscript = await readFile(path.join(er.root, transcriptIndex[0].archive));
  assert.equal(gunzipSync(archivedTranscript).toString("utf8"), '{"role":"assistant","content":"failure evidence"}\n');
  const compactedState = JSON.parse(await readFile(path.join(er.root, ".agent", "capsule", "state.json"), "utf8"));
  assert.equal(compactedState.failure_transcript_refs.length, 1);
  assert.match(compactedState.failure_transcript_refs[0], /^capsule:\/\/session\/run_er_.+\.jsonl\.[0-9a-f]{12}\.gz$/);
  assert.ok(Number.isInteger(compactedState.bytes_retained) && compactedState.bytes_retained > 0);
});
