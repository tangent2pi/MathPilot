import type { McpAdapterOptions } from "pi-mcp-adapter";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

type CapabilityServer = NonNullable<McpAdapterOptions["config"]>["mcpServers"][string];

export const SEARCH_TOOL_NAMES = ["web_search", "web_extractor", "image_search"] as const;

const SANDBOX_LAUNCHER = fileURLToPath(new URL("./sandbox-launcher.ts", import.meta.url));
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

/** External research tools with allowlisted egress and masked provider keys. */
export function searchCapabilityServer(): CapabilityServer {
  return {
    command: process.execPath,
    args: ["--import", TSX_LOADER, SANDBOX_LAUNCHER, "search"],
    lifecycle: "eager",
    requestTimeoutMs: 60_000,
    directTools: [...SEARCH_TOOL_NAMES],
    includeTools: [...SEARCH_TOOL_NAMES],
    toolPrefix: "none",
  };
}
