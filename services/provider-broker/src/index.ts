/**
 * provider-broker 骨架：fake ModelProvider（实施规划 §4）。
 * fake 实现必须产生与正式 Provider 同构的 trace 字段；
 * implementation 以 "fake." 前缀标识，禁止静默回退。
 */
import { startService, newId } from "@agmath/service-kit";

interface GenerateBody {
  messages: { role: string; parts: { type: string; text?: string }[] }[];
  responseSchema?: Record<string, unknown>;
  correlationId?: string;
}

startService({
  name: "provider-broker",
  port: Number(process.env.PORT ?? 3004),
  register(app) {
    app.post("/providers/model/generate", async (req) => {
      const started = Date.now();
      const body = req.body as GenerateBody;
      const lastText = body.messages.at(-1)?.parts.find((p) => p.type === "text")?.text ?? "";
      const outputJson = body.responseSchema ? { echo: lastText, fake: true } : undefined;
      return {
        ok: true,
        value: {
          outputText: `[fake.model] echo: ${lastText.slice(0, 200)}`,
          ...(outputJson !== undefined ? { outputJson } : {}),
          finishReason: "stop",
          usage: { inputTokens: lastText.length, outputTokens: 16 },
        },
        trace: {
          traceId: newId("ptr"),
          correlationId: body.correlationId,
          providerKind: "model",
          implementation: "fake.model",
          operation: "generate",
          latencyMs: Date.now() - started,
          usage: { inputTokens: lastText.length, outputTokens: 16, costMicros: 0 },
          fallbackChain: [],
        },
      };
    });
  },
});
