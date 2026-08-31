import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { chmod, lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { paddleOcrArguments } from "./ocr-input.ts";

type ToolContent = TextContent | ImageContent;
type OcrCheckpointResult = { content: ToolContent[]; details: unknown };
const MAX_INLINE_OCR_CHARS = 16 * 1024;

const safePart = (value: string, fallback: string): string => {
  const normalized = value.normalize("NFKC")
    .replaceAll(/[^A-Za-z0-9._-]/g, "_")
    .replaceAll(/^[_\-.]+|[_\-.]+$/g, "");
  return normalized.slice(0, 80) || fallback;
};

const inputSource = (input: Record<string, unknown>): string => {
  const value = input.input_data ?? input.path ?? input.file;
  const first = Array.isArray(value) ? value.find((item) => typeof item === "string") : value;
  if (typeof first !== "string") return "ocr";
  return safePart(path.basename(first, path.extname(first)), "ocr");
};

const guardedSpillPath = (value: unknown, tempRoot: string): string | null => {
  if (typeof value !== "string" || !path.isAbsolute(value)) return null;
  const relative = path.relative(path.resolve(tempRoot), path.resolve(value));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const parts = relative.split(path.sep);
  if (parts.length !== 2 || !parts[0]!.startsWith("pi-mcp-output-") || !/^output-[^/]+\.txt$/.test(parts[1]!)) return null;
  return path.resolve(value);
};

const textFromContent = (content: ToolContent[]): string =>
  content.filter((item): item is TextContent => item.type === "text").map((item) => item.text).join("\n");

const boundedPreview = (text: string): string => {
  if (text.length <= MAX_INLINE_OCR_CHARS) return text;
  const tailChars = 4 * 1024;
  return `${text.slice(0, MAX_INLINE_OCR_CHARS - tailChars)}\n\n… OCR 中间内容已省略，请读取持久化文件 …\n\n${text.slice(-tailChars)}`;
};

/** Move adapter spill files into durable, model-visible output before history records the result. */
export async function checkpointPaddleOcrResult(
  workspaceRoot: string,
  event: ToolResultEvent,
  tempRoot = os.tmpdir(),
): Promise<OcrCheckpointResult | undefined> {
  const ocrInput = paddleOcrArguments(event);
  if (!ocrInput || event.isError) return undefined;

  const details = event.details && typeof event.details === "object"
    ? event.details as Record<string, unknown>
    : {};
  const guard = details.outputGuard && typeof details.outputGuard === "object"
    ? details.outputGuard as Record<string, unknown>
    : {};
  const spill = guardedSpillPath(guard.fullOutputPath, tempRoot);
  let completeText = textFromContent(event.content);

  if (spill) {
    const info = await lstat(spill);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(spill) !== spill) {
      throw new Error("unsafe MCP output spill file");
    }
    completeText = await readFile(spill, "utf8");
  }
  if (!completeText.trim()) return undefined;

  const outputDir = path.join(workspaceRoot, "output", "ocr-evidence", "raw");
  await mkdir(outputDir, { recursive: true });
  const filename = `${inputSource(ocrInput)}-${safePart(event.toolCallId, "result")}.md`;
  const checkpoint = path.join(outputDir, filename);
  await writeFile(checkpoint, completeText, { encoding: "utf8", mode: 0o600 });
  await chmod(checkpoint, 0o600);
  if (spill) await unlink(spill).catch(() => undefined);

  const workspacePath = `output/ocr-evidence/raw/${filename}`;
  const note = `完整 OCR 结果已持久化到 ${workspacePath}。后续先用 read/Bash 检索该文件，不要重新 OCR 同一页。`;
  const images = event.content.filter((item): item is ImageContent => item.type === "image");
  return {
    content: [{ type: "text", text: `${boundedPreview(completeText)}\n\n${note}` }, ...images],
    details: {
      ...details,
      outputGuard: { ...guard, fullOutputPath: workspacePath, checkpointPath: workspacePath },
    },
  };
}
