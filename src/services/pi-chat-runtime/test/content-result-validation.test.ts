import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateContentRespond } from "../extensions/lib/content-result-validation.ts";

const validKtq = {
  schema: "mathpilot.ktq-result/v1",
  questions: [{
    source: { path: "input/original/example.pdf", page: 1, bbox: null },
    stem_markdown: "已知 a=1，求 a+1？",
    stem_format: "open_solution",
    options: [],
    image_refs: [],
    knowledge_components: [{ id: "K_ADD", name: "加法" }],
    question_type: { id: "T_CALC", name: "直接计算" },
    difficulty: 0.2,
    measurement_targets: [{ dim: "K_ADD", role: "primary", evidence_rule: "能完成加法" }],
    rubric: [{ id: "rubric_1", description: "步骤和结果正确" }],
    answer: { value: "2" },
    dedup_action: "new",
  }],
};

const withWorkspace = async (run: (workspace: string) => Promise<void>) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "mathpilot-result-"));
  try {
    await mkdir(path.join(workspace, "output"), { recursive: true });
    await mkdir(path.join(workspace, "input/original"), { recursive: true });
    await writeFile(path.join(workspace, "input/original/example.pdf"), "fixture");
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
};

test("accepts a matching, hashed KTQ receipt", async () => {
  await withWorkspace(async (workspace) => {
    const resultBytes = Buffer.from(JSON.stringify(validKtq));
    await writeFile(path.join(workspace, "output/ktq-result.json"), resultBytes);
    await writeFile(path.join(workspace, "output/ktq-result.validation.json"), JSON.stringify({
      schema: "mathpilot.validation-receipt/v1",
      skill: "ktq-extraction",
      result_file: "output/ktq-result.json",
      sha256: createHash("sha256").update(resultBytes).digest("hex"),
      valid: true,
    }));
    const validated = await validateContentRespond(workspace, {
      result_file: "output/ktq-result.json",
      validation_file: "output/ktq-result.validation.json",
    });
    assert.deepEqual(validated.kind, "ktq");
    assert.equal(validated.itemCount, 1);
  });
});

test("rejects a tampered result and paths outside output", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(path.join(workspace, "output/result.json"), JSON.stringify(validKtq));
    await writeFile(path.join(workspace, "output/receipt.json"), JSON.stringify({
      schema: "mathpilot.validation-receipt/v1", skill: "ktq-extraction", result_file: "output/result.json", sha256: "0".repeat(64), valid: true,
    }));
    await assert.rejects(() => validateContentRespond(workspace, { result_file: "output/result.json", validation_file: "output/receipt.json" }), /hash mismatch/);
    await assert.rejects(() => validateContentRespond(workspace, { result_file: "../result.json", validation_file: "output/receipt.json" }), /below output/);
  });
});
