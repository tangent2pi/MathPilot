import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMcpAdapter } from "pi-mcp-adapter";
import { CORE_TOOL_NAMES, coreCapabilityServer } from "./core.ts";
import { checkpointPaddleOcrResult } from "./ocr-checkpoint.ts";
import { normalizePaddleOcrInput, paddleOcrArguments } from "./ocr-input.ts";
import { OCR_TOOL_NAMES, ocrCapabilityServer } from "./ocr.ts";
import { governMultimodalProviderPayload } from "./multimodal-payload.ts";
import { SEARCH_TOOL_NAMES, searchCapabilityServer } from "./search.ts";

const REQUIRED_DIRECT_TOOLS = [...CORE_TOOL_NAMES, ...SEARCH_TOOL_NAMES, ...OCR_TOOL_NAMES];

/** Pi-discovered extension that owns the new runtime's Core/Search/OCR capability surface. */
export default function capabilitiesExtension(pi: ExtensionAPI): void {
  // pi-mcp-adapter waits for explicitly requested direct tools during
  // session_start. This closes the race between opening a thread and its first
  // user prompt without changing assistant-ui's supervisor.
  if (process.env.MCP_DIRECT_TOOLS === undefined) {
    process.env.MCP_DIRECT_TOOLS = REQUIRED_DIRECT_TOOLS.join(",");
  }

  createMcpAdapter({
    config: {
      settings: {
        toolPrefix: "none",
        disableProxyTool: true,
        // The headless Pi host has no TUI theme. Disabling the adapter footer
        // avoids touching ui.theme during startup and lets direct tools finish
        // registering before the first user turn.
        mcpFooterStatus: "off",
        notifyOnStartupConnect: false,
        scriptMode: false,
        outputGuard: {
          maxBytes: 48 * 1024,
          maxLines: 1200,
          detailsMaxBytes: 16 * 1024,
        },
      },
      mcpServers: {
        "qwen-mm-plugins-core": coreCapabilityServer(),
        "qwen-mm-plugins-search": searchCapabilityServer(),
        "paddleocr-vl": ocrCapabilityServer(),
      },
    },
  })(pi);

  pi.on("before_provider_request", (event) =>
    governMultimodalProviderPayload(event.payload).payload);

  pi.on("tool_call", async (event, ctx) => {
    const input = paddleOcrArguments(event);
    if (!input) return undefined;
    try {
      await normalizePaddleOcrInput(ctx.cwd, input);
      return undefined;
    } catch (error) {
      return {
        block: true,
        reason: `OCR 输入被拒绝：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    try {
      return await checkpointPaddleOcrResult(ctx.cwd, event);
    } catch (error) {
      return {
        content: [...event.content, {
          type: "text",
          text: `OCR 结果持久化失败：${error instanceof Error ? error.message : String(error)}。请缩小到连续 4 页以内后重试一次。`,
        }],
      };
    }
  });
}
