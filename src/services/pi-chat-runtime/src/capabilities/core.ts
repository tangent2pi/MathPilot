import type { McpAdapterOptions } from "pi-mcp-adapter";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

type CapabilityServer = NonNullable<McpAdapterOptions["config"]>["mcpServers"][string];

export const CORE_TOOL_NAMES = [
  "read_image",
  "read_video",
  "media_info",
  "visualize",
  "crop",
  "draw_bbox",
  "save_view",
] as const;

const SANDBOX_LAUNCHER = fileURLToPath(new URL("./sandbox-launcher.ts", import.meta.url));
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

/** Visual/media tools, jailed to the current Pi thread workspace by SRT. */
export function coreCapabilityServer(): CapabilityServer {
  return {
    command: process.execPath,
    args: ["--import", TSX_LOADER, SANDBOX_LAUNCHER, "core"],
    lifecycle: "eager",
    requestTimeoutMs: 90_000,
    directTools: [...CORE_TOOL_NAMES],
    includeTools: [...CORE_TOOL_NAMES],
    toolPrefix: "none",
  };
}
