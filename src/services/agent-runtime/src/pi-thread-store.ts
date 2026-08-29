import pg from "pg";

export interface PiPrincipal {
  tenantId: string;
  userId: string;
  roles: string[];
  accessibleStudentIds: string[];
}

export interface PiThreadRecord {
  threadId: string;
  tenantId: string;
  ownerUserId: string;
  studentId: string;
  sessionDir: string;
  sessionFile: string;
  minioKey?: string;
  createdAt: string;
  archivedAt?: string;
}

type Row = {
  thread_id: string;
  tenant_id: string;
  owner_user_id: string;
  student_id: string;
  session_dir: string;
  session_file: string;
  minio_key: string | null;
  created_at: Date;
  archived_at: Date | null;
};

const mapRow = (row: Row): PiThreadRecord => ({
  threadId: row.thread_id,
  tenantId: row.tenant_id,
  ownerUserId: row.owner_user_id,
  studentId: row.student_id,
  sessionDir: row.session_dir,
  sessionFile: row.session_file,
  ...(row.minio_key ? { minioKey: row.minio_key } : {}),
  createdAt: row.created_at.toISOString(),
  ...(row.archived_at ? { archivedAt: row.archived_at.toISOString() } : {}),
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
           set_config('mathpilot.roles',$3,true),
           set_config('mathpilot.accessible_student_ids',$4,true)`,
        [principal.tenantId, principal.userId, principal.roles.join(","), principal.accessibleStudentIds.join(",")],
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
    value: { threadId: string; studentId: string; sessionDir: string; sessionFile: string },
  ): Promise<PiThreadRecord> {
    const result = await this.scopedQuery<Row>(principal,
      `insert into pi_threads(thread_id,tenant_id,owner_user_id,student_id,session_dir,session_file)
       values($1,$2,$3,$4,$5,$6)
       returning *`,
      [value.threadId, principal.tenantId, principal.userId, value.studentId, value.sessionDir, value.sessionFile],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Pi thread mapping insert returned no row");
    return mapRow(row);
  }

  async accessible(principal: PiPrincipal, threadId: string, write = false): Promise<PiThreadRecord | undefined> {
    const result = await this.scopedQuery<Row>(principal,
      `select t.* from pi_threads t
       where t.thread_id=$1 and t.tenant_id=$2 and (
         t.owner_user_id=$3
         or $4::boolean
         or t.student_id=any($6::text[])
         or exists (
           select 1 from pi_thread_acl a
           where a.thread_id=t.thread_id and a.tenant_id=t.tenant_id and a.user_id=$3
             and (not $5::boolean or a.access in ('write','admin'))
         )
       )`,
      [threadId, principal.tenantId, principal.userId, principal.roles.includes("tenant_admin"), write, principal.accessibleStudentIds],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async list(principal: PiPrincipal): Promise<PiThreadRecord[]> {
    const result = await this.scopedQuery<Row>(principal,
      `select t.* from pi_threads t
       where t.tenant_id=$1 and (
         t.owner_user_id=$2 or $3::boolean or t.student_id=any($4::text[]) or exists (
           select 1 from pi_thread_acl a
           where a.thread_id=t.thread_id and a.tenant_id=t.tenant_id and a.user_id=$2
         )
       ) order by t.created_at desc`,
      [principal.tenantId, principal.userId, principal.roles.includes("tenant_admin"), principal.accessibleStudentIds],
    );
    return result.rows.map(mapRow);
  }

  async setMinioKey(principal: PiPrincipal, threadId: string, minioKey: string): Promise<boolean> {
    const allowed = await this.accessible(principal, threadId, true);
    if (!allowed) return false;
    const result = await this.scopedQuery(principal,
      `update pi_threads set minio_key=$2 where thread_id=$1 and tenant_id=$3`,
      [threadId, minioKey, principal.tenantId],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async markArchived(principal: PiPrincipal, threadId: string, archived: boolean): Promise<boolean> {
    const allowed = await this.accessible(principal, threadId, true);
    if (!allowed) return false;
    const result = await this.scopedQuery(principal,
      `update pi_threads set archived_at=case when $2 then now() else null end
       where thread_id=$1 and tenant_id=$3`,
      [threadId, archived, principal.tenantId],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async remove(principal: PiPrincipal, threadId: string): Promise<boolean> {
    const allowed = await this.accessible(principal, threadId, true);
    if (!allowed) return false;
    const result = await this.scopedQuery(principal,
      `delete from pi_threads where thread_id=$1 and tenant_id=$2`,
      [threadId, principal.tenantId],
    );
    return (result.rowCount ?? 0) === 1;
  }
}
