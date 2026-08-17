/**
 * @agmath/service-kit — 服务骨架共享件。
 * 所有服务的第一个可运行实现就必须带身份、租户、审计与最小权限（实施规划 §9）。
 */
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";

export interface ServiceOptions {
  name: string;
  port: number;
  register?: (app: FastifyInstance) => void | Promise<void>;
}

export async function startService(opts: ServiceOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

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
 * 连接必须使用最小权限账号（agmath_app），RLS 才对非 owner 生效。
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
