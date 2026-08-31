import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";

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

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 5 });
}

export async function withTenant<T>(pool: pg.Pool, tenantId: string, run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.current_tenant', $1, true)", [tenantId]);
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function withPrincipal<T>(
  pool: pg.Pool,
  principal: { tenantId: string; userId: string; roles: readonly string[] },
  run: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "select set_config('app.current_tenant',$1,true),set_config('app.current_user',$2,true),set_config('app.current_roles',$3,true)",
      [principal.tenantId, principal.userId, principal.roles.join(",")],
    );
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}
