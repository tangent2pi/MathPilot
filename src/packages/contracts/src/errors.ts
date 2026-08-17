/**
 * Provider 统一错误与结果语义（实施规划 §3.5：
 * 每个接口同时定义成功结果、可重试错误、不可重试错误、超时、取消和降级语义）。
 */

export type ProviderErrorKind =
  /** 可重试：限流、瞬时网络、供应商 5xx。调用方应按 retryAfterMs 退避 */
  | "retryable"
  /** 不可重试：输入违反契约、权限不足、内容被安全策略拒绝。重试无意义 */
  | "fatal"
  /** 超时：超过请求 timeoutMs；调用方可在更高级别决定降级 */
  | "timeout"
  /** 取消：调用方主动取消（如 Session 关闭） */
  | "cancelled";

export interface ProviderError {
  readonly kind: ProviderErrorKind;
  /** 稳定错误码，如 rate_limited / schema_violation / unsafe_content */
  readonly code: string;
  readonly message: string;
  readonly retryAfterMs?: number;
}

/**
 * Provider 调用追踪的 TS 投影；权威定义见
 * schemas/providers/provider-trace.schema.json（字段由 ui-sdk 生成器对齐）。
 */
export interface ProviderTraceLike {
  readonly traceId: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly providerKind:
    | "model" | "ocr" | "search" | "media"
    | "explanation" | "artifact" | "sandbox" | "auth";
  /** 实际实现标识，如 pi.scnet.Qwen3.8-Max；回退时必须记录真实实现 */
  readonly implementation: string;
  readonly operation: string;
  readonly modelId?: string;
  readonly latencyMs: number;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly pages?: number;
    readonly costMicros?: number;
  };
  /** 发生回退时按顺序记录实际尝试的实现；无回退为空数组 */
  readonly fallbackChain: readonly string[];
}

export type ProviderResult<T> =
  | { readonly ok: true; readonly value: T; readonly trace: ProviderTraceLike }
  | { readonly ok: false; readonly error: ProviderError; readonly trace: ProviderTraceLike };

/** 所有 Provider 请求的公共字段 */
export interface ProviderRequestBase {
  readonly correlationId: string;
  readonly timeoutMs: number;
  /** 取消信号；实现必须将其映射为 "cancelled" 错误而非挂起 */
  readonly signal?: AbortSignal;
}
