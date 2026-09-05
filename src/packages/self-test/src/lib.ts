import { randomUUID } from "node:crypto";
import type pg from "pg";

export const newId = (prefix: string): string => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;

export async function withPrincipal<T>(pool: pg.Pool,
  principal: { tenantId: string; userId: string; roles: readonly string[] },
  run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.current_tenant',$1,true),set_config('app.current_user',$2,true),set_config('app.current_roles',$3,true)",
      [principal.tenantId, principal.userId, principal.roles.join(",")]);
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
