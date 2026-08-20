import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkpointPaddleOcrResult } from "../src/ocr-checkpoint.ts";

test("moves a truncated MCP spill into the visible session workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mathpilot-ocr-workspace-"));
  const spillDir = await mkdtemp(path.join(os.tmpdir(), "pi-mcp-output-"));
  const spill = path.join(spillDir, "output-call.txt");
  const full = `# page 1\n${"完整公式与题目\n".repeat(3000)}`;
  await writeFile(spill, full, "utf8");

  const result = await checkpointPaddleOcrResult(root, {
    toolName: "paddleocr_vl", toolCallId: "call/01", input: { input_data: "/workspace/tmp/book.pdf" },
    content: [{ type: "text", text: "truncated" }], isError: false,
    details: { outputGuard: { truncated: true, fullOutputPath: spill } },
  });

  assert.ok(result);
  const visible = (result.details as { outputGuard: { fullOutputPath: string } }).outputGuard.fullOutputPath;
  assert.match(visible, /^\/workspace\/output\/ocr-evidence\/raw\/book-call_01\.md$/);
  assert.equal(await readFile(path.join(root, visible.replace("/workspace/", "")), "utf8"), full);
  await assert.rejects(stat(spill));
  assert.ok((result.content[0].text as string).length < 18 * 1024);
  assert.match(result.content[0].text as string, /不要重新 OCR/);
});

test("persists a normal PaddleOCR result and ignores unrelated tools", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mathpilot-ocr-workspace-"));
  await mkdir(path.join(root, "output"), { recursive: true });
  const result = await checkpointPaddleOcrResult(root, {
    toolName: "paddleocr_vl", toolCallId: "call-02", input: { input_data: ["/workspace/input/page.png"] },
    content: [{ type: "text", text: "x² + y² = 1" }, { type: "image", data: "preview" }], isError: false,
  });
  assert.ok(result);
  assert.equal(result.content.filter((item) => item.type === "image").length, 1);
  assert.equal(await readFile(path.join(root, "output/ocr-evidence/raw/page-call-02.md"), "utf8"), "x² + y² = 1");
  assert.equal(await checkpointPaddleOcrResult(root, {
    toolName: "save_view", toolCallId: "x", input: {}, content: [], isError: false,
  }), undefined);
});
