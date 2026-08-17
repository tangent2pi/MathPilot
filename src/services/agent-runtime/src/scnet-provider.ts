/**
 * scnet OpenAI 兼容端点 → pi-ai Provider（设计 §4.3：领域服务不绑定具体模型供应商，
 * 通过 Pi 的统一多供应商模型 API 接入；Qwen3.8-Max / DeepSeek-V4-Flash-0731 只是配置实例）。
 *
 * 密钥不落本文件：由 agent-runtime 从本服务环境变量读取后注入（宿主侧持有，设计 §4.4）。
 */
import { createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export interface ScnetConfig {
  baseUrl: string;
  apiKey: string;
  mainModelId: string;
  auxModelId: string;
}

function model(id: string, baseUrl: string): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "scnet",
    baseUrl,
    // 推理模型：content 为最终答案（reasoning 消耗 max_tokens，须给足）
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    // 部分 OpenAI 兼容服务器不认识 developer role；system 消息即可
    compat: { supportsDeveloperRole: false },
  };
}

export function buildScnetProvider(cfg: ScnetConfig) {
  return createProvider({
    id: "scnet",
    name: "scnet",
    baseUrl: cfg.baseUrl,
    auth: {
      apiKey: {
        name: "scnet",
        resolve: async () => ({ auth: { apiKey: cfg.apiKey } }),
      },
    },
    models: [model(cfg.mainModelId, cfg.baseUrl), model(cfg.auxModelId, cfg.baseUrl)],
    api: openAICompletionsApi(),
  });
}
