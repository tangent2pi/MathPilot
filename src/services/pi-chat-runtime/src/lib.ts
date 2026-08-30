import Fastify, { type FastifyInstance } from "fastify";

export async function startService(options: {
  name: string;
  port: number;
  register: (app: FastifyInstance) => void | Promise<void>;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, bodyLimit: 48 * 1024 * 1024 });
  app.get("/healthz", async () => ({ status: "ok", service: options.name }));
  app.get("/readyz", async () => ({ status: "ready", service: options.name }));
  await options.register(app);
  await app.listen({ port: options.port, host: "0.0.0.0" });
  return app;
}
