import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionFactory, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type ToolContent = TextContent | ImageContent;
type ToolResultPatch = { content?: ToolContent[]; details?: unknown; isError?: boolean };

export interface OcrToolResultEvent {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  content: ToolContent[];
  details?: unknown;
  isError: boolean;
}

const MAX_INLINE_OCR_CHARS = 16 * 1024;

function safePart(value: string, fallback: string): string {
  const normalized = value.normalize("NFKC").replaceAll(/[^A-Za-z0-9._-]/g, "_").replaceAll(/^[_\-.]+|[_\-.]+$/g, "");
  return normalized.slice(0, 80) || fallback;
}

function inputSource(input: Record<string, unknown>): string {
  const value = input.input_data ?? input.path ?? input.file;
  const first = Array.isArray(value) ? value.find((item) => typeof item === "string") : value;
  if (typeof first !== "string") return "ocr";
  return safePart(path.basename(first, path.extname(first)), "ocr");
}

function guardedSpillPath(value: unknown, tempRoot: string): string | null {
  if (typeof value !== "string" || !path.isAbsolute(value)) return null;
  const relative = path.relative(path.resolve(tempRoot), path.resolve(value));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const parts = relative.split(path.sep);
  if (parts.length !== 2 || !parts[0]!.startsWith("pi-mcp-output-") || !/^output-[^/]+\.txt$/.test(parts[1]!)) return null;
  return path.resolve(value);
}

function textFromContent(content: ToolContent[]): string {
  return content.filter((item): item is TextContent => item.type === "text").map((item) => item.text).join("\n");
}

function boundedPreview(text: string): string {
  if (text.length <= MAX_INLINE_OCR_CHARS) return text;
  const tailChars = 4 * 1024;
  const headChars = MAX_INLINE_OCR_CHARS - tailChars;
  return `${text.slice(0, headChars)}\n\n… OCR 中间内容已省略，请从持久化文件读取 …\n\n${text.slice(-tailChars)}`;
}

/**
 * pi-mcp-adapter 会把超限结果写到宿主 /tmp；工具沙箱有私有 /tmp，模型无法读取。
 * 此处在 tool_result 进入模型历史前把完整 OCR 原文迁入当前 Session 工作区，并压缩行内副本。
 */
export async function checkpointPaddleOcrResult(
  workspaceRoot: string,
  event: OcrToolResultEvent,
  tempRoot = os.tmpdir(),
): Promise<{ content: ToolContent[]; details: unknown } | undefined> {
  if (event.toolName !== "paddleocr_vl" || event.isError) return undefined;

  const details = event.details && typeof event.details === "object" ? event.details as Record<string, unknown> : {};
  const guard = details.outputGuard && typeof details.outputGuard === "object"
    ? details.outputGuard as Record<string, unknown>
    : {};
  const spill = guardedSpillPath(guard.fullOutputPath, tempRoot);
  let completeText = textFromContent(event.content);

  if (spill) {
    const info = await lstat(spill);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(spill) !== spill) throw new Error("unsafe MCP output spill file");
    completeText = await readFile(spill, "utf8");
  }
  if (!completeText.trim()) return undefined;

  const outputDir = path.join(workspaceRoot, "output", "ocr-evidence", "raw");
  await mkdir(outputDir, { recursive: true });
  const filename = `${inputSource(event.input)}-${safePart(event.toolCallId, "result")}.md`;
  await writeFile(path.join(outputDir, filename), completeText, "utf8");
  if (spill) await unlink(spill).catch(() => undefined);

  const workspacePath = `/workspace/output/ocr-evidence/raw/${filename}`;
  const note = `完整 OCR 结果已持久化到 ${workspacePath}。后续必须用 Bash 从该文件读取/检索，不要重新 OCR 同一批页面。`;
  const images = event.content.filter((item) => item.type === "image");
  return {
    content: [{ type: "text", text: `${boundedPreview(completeText)}\n\n${note}` }, ...images],
    details: {
      ...details,
      outputGuard: { ...guard, fullOutputPath: workspacePath, checkpointPath: workspacePath },
    },
  };
}

export function createOcrCheckpointExtension(workspaceRoot: string): ExtensionFactory {
  return (pi) => {
    pi.on("tool_result", async (event: ToolResultEvent): Promise<ToolResultPatch | undefined> => {
      try {
        return await checkpointPaddleOcrResult(workspaceRoot, event as unknown as OcrToolResultEvent);
      } catch (error) {
        return {
          content: [...event.content, {
            type: "text",
            text: `OCR 结果持久化失败：${error instanceof Error ? error.message : String(error)}。请缩小到连续 4 页以内后重试一次。`,
          }],
        };
      }
    });
  };
}
