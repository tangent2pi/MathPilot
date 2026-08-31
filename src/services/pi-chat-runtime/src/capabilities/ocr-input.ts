import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Resolve direct-tool and legacy MCP-gateway calls to the same OCR arguments object. */
export function paddleOcrArguments(event: { toolName: string; input: JsonObject }): JsonObject | undefined {
  if (event.toolName === "paddleocr_vl") return event.input;
  if (event.toolName !== "mcp" || event.input.tool !== "paddleocr_vl") return undefined;
  if (isObject(event.input.args)) return event.input.args;
  if (typeof event.input.args !== "string") return undefined;
  try {
    const parsed = JSON.parse(event.input.args) as unknown;
    if (!isObject(parsed)) return undefined;
    event.input.args = parsed;
    return parsed;
  } catch {
    return undefined;
  }
}

const insideWorkspace = (workspace: string, candidate: string): boolean => {
  const relative = path.relative(workspace, candidate);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
    && relative !== ".agent"
    && !relative.startsWith(`.agent${path.sep}`);
};

const normalizeOne = async (workspace: string, value: string): Promise<string> => {
  const candidate = value.startsWith("/workspace/")
    ? path.resolve(workspace, value.slice("/workspace/".length))
    : path.resolve(workspace, value);
  if ((await lstat(candidate)).isSymbolicLink()) throw new Error("OCR input may not be a symbolic link");
  const resolved = await realpath(candidate);
  if (!insideWorkspace(workspace, resolved)) throw new Error("OCR input must be a file in the current thread workspace");
  if (!(await stat(resolved)).isFile()) throw new Error("OCR input must be a regular file");
  return resolved;
};

/**
 * PaddleOCR validates local paths before making its request. Normalize the
 * model-facing relative path to the unchanged host path exposed by SRT and
 * reject any cross-thread/host path before the MCP server sees it.
 */
export async function normalizePaddleOcrInput(workspaceRoot: string, input: JsonObject): Promise<void> {
  const workspace = await realpath(workspaceRoot);
  for (const field of ["input_data", "path", "file"] as const) {
    const value = input[field];
    if (typeof value === "string") {
      input[field] = await normalizeOne(workspace, value);
      return;
    }
    if (Array.isArray(value)) {
      const normalized: unknown[] = [];
      for (const item of value) {
        normalized.push(typeof item === "string" ? await normalizeOne(workspace, item) : item);
      }
      input[field] = normalized;
      return;
    }
  }
}
