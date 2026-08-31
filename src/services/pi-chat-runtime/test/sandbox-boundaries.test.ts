import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { sandboxToolConfig } from "../extensions/sandbox.ts";
import { checkpointPaddleOcrResult } from "../src/capabilities/ocr-checkpoint.ts";
import { normalizePaddleOcrInput, paddleOcrArguments } from "../src/capabilities/ocr-input.ts";

const withWorkspace = async (run: (workspace: string) => Promise<void>) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "mathpilot-sandbox-"));
  const workspace = path.join(parent, "thread");
  try {
    await Promise.all([
      mkdir(path.join(workspace, "input/original"), { recursive: true }),
      mkdir(path.join(workspace, "output"), { recursive: true }),
      mkdir(path.join(workspace, "tmp"), { recursive: true }),
      mkdir(path.join(workspace, ".agent"), { recursive: true }),
    ]);
    await run(workspace);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
};

test("general tools deny host roots and write only output/tmp", async () => {
  await withWorkspace(async (workspace) => {
    const previous = process.env.PI_CHAT_SANDBOX_SKILLS_ROOT;
    process.env.PI_CHAT_SANDBOX_SKILLS_ROOT = "/model-readable-skills";
    try {
      const config = sandboxToolConfig(workspace);
      assert.equal(config.enableWeakerNestedSandbox, false);
      assert.ok(config.filesystem.denyRead.includes("/"));
      assert.ok(config.filesystem.denyRead.includes(path.join(workspace, ".agent")));
      assert.deepEqual(config.filesystem.allowWrite, [
        path.join(workspace, "output"),
        path.join(workspace, "tmp"),
      ]);
      assert.ok(!config.filesystem.allowRead?.includes(workspace));
      assert.ok(config.filesystem.allowRead?.includes(path.join(workspace, "input")));
      assert.ok(config.filesystem.allowRead?.includes("/model-readable-skills"));
    } finally {
      if (previous === undefined) delete process.env.PI_CHAT_SANDBOX_SKILLS_ROOT;
      else process.env.PI_CHAT_SANDBOX_SKILLS_ROOT = previous;
    }
  });
});

test("OCR paths are normalized inside one workspace and reject escapes", async () => {
  await withWorkspace(async (workspace) => {
    const source = path.join(workspace, "input/original/page.png");
    await writeFile(source, "image");
    const input: Record<string, unknown> = { input_data: "input/original/page.png" };
    await normalizePaddleOcrInput(workspace, input);
    assert.equal(input.input_data, source);

    const outside = path.join(path.dirname(workspace), "outside.png");
    await writeFile(outside, "outside");
    await assert.rejects(
      normalizePaddleOcrInput(workspace, { input_data: outside }),
      /current thread workspace/,
    );
  });
});

test("legacy MCP OCR calls use the same durable checkpoint path", async () => {
  await withWorkspace(async (workspace) => {
    const event = {
      type: "tool_result",
      toolCallId: "ocr-call",
      toolName: "mcp",
      input: { tool: "paddleocr_vl", args: JSON.stringify({ input_data: "input/original/page.png" }) },
      content: [{ type: "text", text: "recognized formula" }],
      details: {},
      isError: false,
    } as unknown as ToolResultEvent;
    assert.deepEqual(paddleOcrArguments(event), { input_data: "input/original/page.png" });
    const result = await checkpointPaddleOcrResult(workspace, event);
    assert.ok(result);
    assert.equal(
      await readFile(path.join(workspace, "output/ocr-evidence/raw/page-ocr-call.md"), "utf8"),
      "recognized formula",
    );
  });
});
