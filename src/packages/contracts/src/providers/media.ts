/**
 * MediaUnderstandingProvider：独立视觉/媒体理解（设计 §4.2、§13）。
 * 文本主模型 + 本 Provider 的组合必须通过启动健康检查（effective_multimodal=true）。
 * Qwen-MM-Plugins core/api 是候选实现。
 */
import type { ProviderRequestBase, ProviderResult } from "../errors.js";

export interface MediaRef {
  /** artifact://、对象存储键或 Session 工作区内引用 */
  readonly ref: string;
  readonly mediaType: "image" | "video";
  readonly contentHash?: string;
}

export type MediaTask =
  | { readonly kind: "describe" }
  | { readonly kind: "ocr_text" }
  | { readonly kind: "grounding"; readonly query: string }
  | { readonly kind: "math_read"; readonly hint?: string };

export interface MediaInspectRequest extends ProviderRequestBase {
  readonly mediaRefs: readonly MediaRef[];
  readonly task: MediaTask;
  readonly responseSchema?: Record<string, unknown>;
}

export interface MediaInspectResponse {
  readonly outputJson?: unknown;
  readonly outputText?: string;
  /** 结论对应的媒体区域/帧引用，供证据链回放 */
  readonly evidenceRefs: readonly string[];
}

export interface MediaUnderstandingProvider {
  inspect(req: MediaInspectRequest): Promise<ProviderResult<MediaInspectResponse>>;
}
