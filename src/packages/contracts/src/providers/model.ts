/**
 * ModelProvider：主/辅助大模型统一接口（设计 §4.2）。
 * 领域代码只依赖本接口；qwen3.8-max-preview / deepseek-v4-flash 等只是配置实例，
 * 禁止出现在领域类型名中。
 */
import type { ProviderRequestBase, ProviderResult } from "../errors.js";

export interface ModelCapabilities {
  readonly text: boolean;
  readonly vision: boolean;
  readonly tools: boolean;
  readonly streaming: boolean;
  readonly structuredOutput: boolean;
  readonly maxContextTokens: number;
}

export type ModelMessagePart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly mediaRef: string; readonly alt?: string };

export interface ModelMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly parts: readonly ModelMessagePart[];
  /** role=tool 时必填：对应工具调用 id */
  readonly toolCallId?: string;
}

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parametersSchema: Record<string, unknown>;
}

export interface CapabilityRequest {
  /** 本次调用是否需要视觉输入；文本模型+媒体 Provider 组合时由宿主在启动校验保证 */
  readonly vision?: boolean;
  readonly structuredOutput?: boolean;
  readonly streaming?: boolean;
}

export interface GenerateRequest extends ProviderRequestBase {
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly ToolSpec[];
  /** JSON Schema；提供时实现必须返回可通过该校验的 outputJson */
  readonly responseSchema?: Record<string, unknown>;
  readonly capabilityRequest?: CapabilityRequest;
  readonly maxOutputTokens?: number;
}

export interface GenerateResponse {
  readonly outputText?: string;
  readonly outputJson?: unknown;
  readonly toolCalls?: readonly { readonly id: string; readonly name: string; readonly argumentsJson: string }[];
  readonly finishReason: "stop" | "length" | "tool_call" | "content_filter";
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

export interface ModelProvider {
  /** 启动健康检查用；文本模型+独立媒体 Provider 的组合必须在此声明 effective vision=false 并由宿主另行校验 effective_multimodal */
  capabilities(): ModelCapabilities;
  generate(req: GenerateRequest): Promise<ProviderResult<GenerateResponse>>;
}
