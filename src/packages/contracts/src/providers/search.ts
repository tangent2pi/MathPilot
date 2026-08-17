/**
 * SearchProvider：独立搜索接口（设计 §4.2）。
 * 诊断场景默认关闭；内容调研场景按 policy 开放。Serper/Exa/Tavily/自建 均为可替换实现。
 */
import type { ProviderRequestBase, ProviderResult } from "../errors.js";

export interface SearchPolicy {
  readonly maxResults: number;
  readonly allowedDomains?: readonly string[];
  readonly blockedDomains?: readonly string[];
  readonly safeSearch: boolean;
  /** 单次返回内容大小上限（字符） */
  readonly maxSnippetChars: number;
}

export interface SearchCitation {
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
  readonly publishedAt?: string;
  readonly sourceType: "official" | "edu" | "forum" | "unknown";
}

export interface SearchRequest extends ProviderRequestBase {
  readonly query: string;
  readonly policy: SearchPolicy;
  /** 引用结构约束 */
  readonly citationSchema?: Record<string, unknown>;
}

export interface SearchResponse {
  readonly results: readonly SearchCitation[];
  readonly providerName: string;
}

export interface SearchProvider {
  search(req: SearchRequest): Promise<ProviderResult<SearchResponse>>;
}
