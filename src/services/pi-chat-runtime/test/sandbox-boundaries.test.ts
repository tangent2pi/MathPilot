import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import {
  collectBoundedBytes,
  detectSandboxedImageMimeType,
  detectVerifiedImageMimeType,
  sandboxToolConfig,
} from "../extensions/sandbox.ts";
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

test("sandbox file collection preserves arbitrary bytes and rejects oversized output", async () => {
  const binary = Buffer.from([0x00, 0xff, 0x80, 0xc3, 0x28, 0x0a]);
  assert.deepEqual(
    await collectBoundedBytes(Readable.from([binary.subarray(0, 2), binary.subarray(2)]), binary.length),
    binary,
  );
  await assert.rejects(
    collectBoundedBytes(Readable.from([binary]), binary.length - 1),
    /exceeds 5 bytes/,
  );
});

test("sandbox image detection fully decodes through the shared integrity mechanism", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  assert.equal(await detectVerifiedImageMimeType(png), "image/png");
  assert.equal(await detectVerifiedImageMimeType(Buffer.from("not an image")), undefined);
  await assert.rejects(
    detectSandboxedImageMimeType(async () => { throw new Error("sandbox read permission denied"); }),
    /sandbox read permission denied/,
  );
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
