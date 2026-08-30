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
  // bodyLimit 32MiB：文档上传（base64 PDF）经 api→content 传递
  const app = Fastify({ logger: true, bodyLimit: 32 * 1024 * 1024 });

  app.get("/healthz", async () => ({ status: "ok", service: opts.name }));
  app.get("/readyz", async () => ({ status: "ready", service: opts.name }));

  if (opts.register) await opts.register(app);

  await app.listen({ port: opts.port, host: "0.0.0.0" });
  return app;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}
