/**
 * 服务自身引导件（设计 §2.4：模块自包含，不共享私有包；各服务内联自身引导）。
 */
import Fastify, { type FastifyInstance } from "fastify";

export interface ServiceOptions {
  name: string;
  port: number;
  register?: (app: FastifyInstance) => void | Promise<void>;
}

export async function startService(opts: ServiceOptions): Promise<FastifyInstance> {
  // 最大 32MiB 的 base64 字段还有 JSON 封装开销，入口需留出余量。
  const app = Fastify({ logger: true, bodyLimit: 48 * 1024 * 1024 });

  app.get("/healthz", async () => ({ status: "ok", service: opts.name }));
  app.get("/readyz", async () => ({ status: "ready", service: opts.name }));

  if (opts.register) await opts.register(app);

  await app.listen({ port: opts.port, host: "0.0.0.0" });
  return app;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}
