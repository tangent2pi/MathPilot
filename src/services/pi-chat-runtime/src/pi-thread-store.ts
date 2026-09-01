import pg from "pg";

export interface PiPrincipal {
  tenantId: string;
  userId: string;
  roles: string[];
}

export interface PiThreadRecord {
  threadId: string;
  tenantId: string;
  ownerUserId: string;
  sessionDir: string;
  sessionFile: string;
  createdAt: string;
}

type Row = {
  thread_id: string;
  tenant_id: string;
  owner_user_id: string;
  session_dir: string;
  session_file: string;
  created_at: Date;
};

const mapRow = (row: Row): PiThreadRecord => ({
  threadId: row.thread_id,
  tenantId: row.tenant_id,
  ownerUserId: row.owner_user_id,
  sessionDir: row.session_dir,
  sessionFile: row.session_file,
  createdAt: row.created_at.toISOString(),
});

/** 独立 Pi 库只保存线程归属与位置，不保存对话、学习结果或身份领域数据。 */
export class PiThreadStore {
  private readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    if (!databaseUrl) throw new Error("PI_DATABASE_URL is required");
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async scopedQuery<Row extends pg.QueryResultRow>(
    principal: PiPrincipal,
    text: string,
    values: unknown[],
  ): Promise<pg.QueryResult<Row>> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `select
           set_config('mathpilot.tenant_id',$1,true),
           set_config('mathpilot.user_id',$2,true),
           set_config('mathpilot.roles',$3,true)`,
        [principal.tenantId, principal.userId, principal.roles.join(",")],
      );
      const result = await client.query<Row>(text, values);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async create(
    principal: PiPrincipal,
    value: { threadId: string; sessionDir: string; sessionFile: string },
  ): Promise<PiThreadRecord> {
    const result = await this.scopedQuery<Row>(principal,
      `insert into pi_threads(thread_id,tenant_id,owner_user_id,session_dir,session_file)
       values($1,$2,$3,$4,$5)
       on conflict (thread_id) do nothing
       returning *`,
      [value.threadId, principal.tenantId, principal.userId, value.sessionDir, value.sessionFile],
    );
    const row = result.rows[0] ?? (await this.scopedQuery<Row>(principal,
      `select * from pi_threads where thread_id=$1 and tenant_id=$2 and owner_user_id=$3`,
      [value.threadId, principal.tenantId, principal.userId],
    )).rows[0];
    if (!row) throw new Error("Pi thread mapping insert returned no row");
    return mapRow(row);
  }

  async accessible(principal: PiPrincipal, threadId: string): Promise<PiThreadRecord | undefined> {
    const result = await this.scopedQuery<Row>(principal,
      `select t.* from pi_threads t
       where t.thread_id=$1 and t.tenant_id=$2 and (
         t.owner_user_id=$3
         or exists (
           select 1 from pi_thread_acl a
           where a.thread_id=t.thread_id and a.tenant_id=t.tenant_id and a.user_id=$3
         )
       )`,
      [threadId, principal.tenantId, principal.userId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  /** Deletion is stricter than ordinary writes: only the owner may remove a
   * thread mapping. An ACL access level is not a product-wide admin role. */
  async deletable(principal: PiPrincipal, threadId: string): Promise<PiThreadRecord | undefined> {
    const result = await this.scopedQuery<Row>(principal,
      `select t.* from pi_threads t
       where t.thread_id=$1 and t.tenant_id=$2 and t.owner_user_id=$3`,
      [threadId, principal.tenantId, principal.userId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }
}
