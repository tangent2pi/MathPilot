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
