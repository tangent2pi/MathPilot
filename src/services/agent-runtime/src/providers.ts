/**
 * 模型提供商注册（设计 §4.2、架构修订 v4 §1）：全部使用 pi-ai 原生机制——
 * createProvider + openAICompletionsApi + envApiKeyAuth（官方"Any OpenAI-compatible API"
 * 标准模式），不再手写 auth resolve / 请求组装。
 *
 * scnet 是 OpenAI 兼容网关端点；Qwen3.8-Max（主，教学）与 DeepSeek-V4-Flash-0731
 * （辅，内容生产线/画像异步更新）只是配置实例（设计 §1.2.2），不是架构名称。
 * 凭据从环境变量解析（MODEL_API_KEY），沙箱/前端/领域服务不持有。
 */
import { createProvider, envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export interface ProviderConfig {
  baseUrl: string;
  mainModelId: string;
  auxModelId: string;
}

/** 模型定义：仅声明身份与能力（推理端点：content 为最终答案，reasoning 消耗 max_tokens） */
function model(id: string, baseUrl: string): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "scnet",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    // 部分 OpenAI 兼容服务器不认识 developer role；system 消息即可
    compat: { supportsDeveloperRole: false },
  };
}

export function buildScnetProvider(cfg: ProviderConfig) {
  return createProvider({
    id: "scnet",
    name: "scnet",
    baseUrl: cfg.baseUrl,
    auth: { apiKey: envApiKeyAuth("scnet", ["MODEL_API_KEY"]) },
    models: [model(cfg.mainModelId, cfg.baseUrl), model(cfg.auxModelId, cfg.baseUrl)],
    api: openAICompletionsApi(),
  });
}
