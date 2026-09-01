import pg from "pg";
import type { FastifyInstance } from "fastify";

export interface Principal {
  tenantId: string;
  userId: string;
  roles: readonly string[];
}

export async function startService(options: {
  name: string;
  port: number;
  register: (app: FastifyInstance) => void | Promise<void>;
}): Promise<FastifyInstance> {
  const app = (await import("fastify")).default({ logger: true, bodyLimit: 2 * 1024 * 1024 });
  app.get("/healthz", async () => ({ status: "ok", service: options.name }));
  app.get("/readyz", async () => ({ status: "ready", service: options.name }));
  await options.register(app);
  await app.listen({ host: "0.0.0.0", port: options.port });
  return app;
}

export function createPool(connectionString = process.env.DATABASE_URL ?? "postgres://localhost:5432/mathpilot"): pg.Pool {
  return new pg.Pool({ connectionString, max: 8 });
}

export async function withPrincipal<T>(
  pool: pg.Pool,
  principal: Principal,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `select set_config('app.current_tenant',$1,true),
              set_config('app.current_user',$2,true),
              set_config('app.current_roles',$3,true)`,
      [principal.tenantId, principal.userId, principal.roles.join(",")],
    );
    const result = await fn(client);
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
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

export function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

export function finiteInteger(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : fallback;
}
