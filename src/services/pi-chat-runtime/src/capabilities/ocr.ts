import type { McpAdapterOptions } from "pi-mcp-adapter";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

type CapabilityServer = NonNullable<McpAdapterOptions["config"]>["mcpServers"][string];

export const OCR_TOOL_NAMES = ["paddleocr_vl"] as const;

const SANDBOX_LAUNCHER = fileURLToPath(new URL("./sandbox-launcher.ts", import.meta.url));
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

/** Bounded high-fidelity OCR, jailed to the current Pi thread workspace by SRT. */
export function ocrCapabilityServer(): CapabilityServer {
  return {
    command: process.execPath,
    args: ["--import", TSX_LOADER, SANDBOX_LAUNCHER, "ocr"],
    lifecycle: "eager",
    requestTimeoutMs: 660_000,
    directTools: [...OCR_TOOL_NAMES],
    includeTools: [...OCR_TOOL_NAMES],
    toolPrefix: "none",
  };
}
