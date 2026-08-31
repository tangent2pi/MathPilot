import pg from "pg";
import type { FastifyInstance } from "fastify";

export interface Principal {
  tenantId: string;
  userId: string;
  roles: string[];
}

export interface ServiceOptions {
  name: string;
  port: number;
  register?: (app: FastifyInstance) => void | Promise<void>;
}

export async function startService(options: ServiceOptions): Promise<FastifyInstance> {
  const app = (await import("fastify")).default({ logger: true, bodyLimit: 40 * 1024 * 1024 });
  app.get("/healthz", async () => ({ status: "ok", service: options.name }));
  app.get("/readyz", async () => ({ status: "ready", service: options.name }));
  if (options.register) await options.register(app);
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

export function trustedRuntime(request: { headers: Record<string, unknown> }): boolean {
  const expected = process.env.CONTENT_NEXT_SECRET ?? process.env.PI_GATEWAY_SECRET ?? "";
  const actual = request.headers["x-mathpilot-runtime-secret"];
  return expected.length >= 32 && actual === expected;
}

export function principalFromHeaders(request: { headers: Record<string, unknown> }): Principal | null {
  const tenant = request.headers["x-tenant-id"];
  const user = request.headers["x-user-id"];
  const rawRoles = request.headers["x-user-roles"];
  if (typeof tenant !== "string" || !tenant || typeof user !== "string" || !user) return null;
  const roles = typeof rawRoles === "string"
    ? rawRoles.split(",").map((role) => role.trim()).filter((role) => role === "teacher" || role === "student")
    : [];
  return { tenantId: tenant, userId: user, roles };
}

export function isTeacher(principal: Principal): boolean {
  return principal.roles.includes("teacher");
}

export function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}

export function finiteNumber(value: unknown, fallback = 0.5): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
