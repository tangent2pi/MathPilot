/**
 * 服务自身引导件（设计 §2.4：模块自包含，不共享私有包；各服务内联自身引导）。
 */
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";

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

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 5 });
}

/**
 * 在事务内激活 RLS 租户上下文后执行 fn。
 * 连接必须使用最小权限账号（mathpilot_app），RLS 才对非 owner 生效（设计 §16.1）。
 */
export async function withTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.current_tenant', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}
