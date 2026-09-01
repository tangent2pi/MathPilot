import pg from "pg";

export interface Principal {
  tenantId: string;
  userId: string;
  roles: readonly string[];
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
