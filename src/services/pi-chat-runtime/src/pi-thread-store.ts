import pg from "pg";
import { randomUUID } from "node:crypto";

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
  minioKey?: string;
  createdAt: string;
  archivedAt?: string;
}

type Row = {
  thread_id: string;
  tenant_id: string;
  owner_user_id: string;
  session_dir: string;
  session_file: string;
  minio_key: string | null;
  created_at: Date;
  archived_at: Date | null;
};

export interface PiAttachmentRecord {
  attachmentId: string;
  threadId: string;
  tenantId: string;
  storageObjectId?: string;
  workspacePath: string;
  originalName: string;
  mimeType: string;
  byteSize: number;
  sha256?: string;
}

type AttachmentRow = {
  attachment_id: string;
  thread_id: string;
  tenant_id: string;
  storage_object_id: string | null;
  workspace_path: string;
  original_name: string;
  mime_type: string;
  byte_size: number;
  sha256: string | null;
};

const mapAttachment = (row: AttachmentRow): PiAttachmentRecord => ({
  attachmentId: row.attachment_id,
  threadId: row.thread_id,
  tenantId: row.tenant_id,
  ...(row.storage_object_id ? { storageObjectId: row.storage_object_id } : {}),
  workspacePath: row.workspace_path,
  originalName: row.original_name,
  mimeType: row.mime_type,
  byteSize: Number(row.byte_size),
  ...(row.sha256 ? { sha256: row.sha256 } : {}),
});

const mapRow = (row: Row): PiThreadRecord => ({
  threadId: row.thread_id,
  tenantId: row.tenant_id,
  ownerUserId: row.owner_user_id,
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

  async accessible(principal: PiPrincipal, threadId: string, write = false): Promise<PiThreadRecord | undefined> {
    const result = await this.scopedQuery<Row>(principal,
      `select t.* from pi_threads t
       where t.thread_id=$1 and t.tenant_id=$2 and (
         t.owner_user_id=$3
         or exists (
           select 1 from pi_thread_acl a
           where a.thread_id=t.thread_id and a.tenant_id=t.tenant_id and a.user_id=$3
             and (not $4::boolean or a.access in ('write','admin'))
         )
       )`,
      [threadId, principal.tenantId, principal.userId, write],
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

  async list(principal: PiPrincipal): Promise<PiThreadRecord[]> {
    const result = await this.scopedQuery<Row>(principal,
      `select t.* from pi_threads t
       where t.tenant_id=$1 and (
         t.owner_user_id=$2 or exists (
           select 1 from pi_thread_acl a
           where a.thread_id=t.thread_id and a.tenant_id=t.tenant_id and a.user_id=$2
         )
       ) order by t.created_at desc`,
      [principal.tenantId, principal.userId],
    );
    return result.rows.map(mapRow);
  }

  async recordCardEvent(
    principal: PiPrincipal,
    value: {
      threadId: string;
      toolCallId: string;
      artifactId: string;
      cardId: string;
      responseType: "submitted" | "skipped" | "bypassed_free_text";
      payload: Record<string, unknown>;
    },
  ): Promise<{ eventId: string; created: boolean }> {
    const allowed = await this.accessible(principal, value.threadId, true);
    if (!allowed) throw new Error("Pi thread is not writable by this principal");
    const eventId = randomUUID();
    const result = await this.scopedQuery<{ event_id: string }>(principal,
      `insert into pi_card_events
         (event_id,thread_id,tenant_id,actor_user_id,tool_call_id,artifact_id,card_id,response_type,payload)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict(thread_id,tool_call_id) do nothing
       returning event_id`,
      [eventId, value.threadId, principal.tenantId, principal.userId, value.toolCallId,
       value.artifactId, value.cardId, value.responseType, JSON.stringify(value.payload)],
    );
    const inserted = result.rows[0]?.event_id;
    if (inserted) return { eventId: inserted, created: true };
    const existing = await this.scopedQuery<{ event_id: string }>(principal,
      `select event_id from pi_card_events
       where thread_id=$1 and tool_call_id=$2 and tenant_id=$3`,
      [value.threadId, value.toolCallId, principal.tenantId],
    );
    return { eventId: existing.rows[0]?.event_id ?? eventId, created: false };
  }

  async createAttachment(
    principal: PiPrincipal,
    value: {
      attachmentId: string;
      threadId: string;
      workspacePath: string;
      originalName: string;
      mimeType: string;
      byteSize: number;
      sha256?: string;
      storageObjectId: string;
    },
  ): Promise<string> {
    const allowed = await this.accessible(principal, value.threadId, true);
    if (!allowed) throw new Error("Pi thread is not writable by this principal");
    const result = await this.scopedQuery<{ attachment_id: string }>(principal,
      `insert into pi_attachments
         (attachment_id,thread_id,tenant_id,uploaded_by_user_id,storage_object_id,workspace_path,original_name,mime_type,byte_size,sha256)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (thread_id, storage_object_id) do update
         set original_name=excluded.original_name,mime_type=excluded.mime_type,
             byte_size=excluded.byte_size,sha256=excluded.sha256
       returning attachment_id`,
      [value.attachmentId, value.threadId, principal.tenantId, principal.userId,
       value.storageObjectId, value.workspacePath, value.originalName, value.mimeType,
       value.byteSize, value.sha256 ?? null],
    );
    return result.rows[0]?.attachment_id ?? value.attachmentId;
  }

  async attachment(principal: PiPrincipal, threadId: string, attachmentId: string): Promise<PiAttachmentRecord | undefined> {
    const allowed = await this.accessible(principal, threadId);
    if (!allowed) return undefined;
    const result = await this.scopedQuery<AttachmentRow>(principal,
      `select attachment_id,thread_id,tenant_id,storage_object_id,workspace_path,original_name,mime_type,byte_size,sha256
         from pi_attachments where attachment_id=$1 and thread_id=$2 and tenant_id=$3`,
      [attachmentId, threadId, principal.tenantId],
    );
    return result.rows[0] ? mapAttachment(result.rows[0]) : undefined;
  }

  async remove(principal: PiPrincipal, threadId: string): Promise<boolean> {
    const allowed = await this.deletable(principal, threadId);
    if (!allowed) return false;
    const result = await this.scopedQuery(principal,
      `delete from pi_threads where thread_id=$1 and tenant_id=$2`,
      [threadId, principal.tenantId],
    );
    return (result.rowCount ?? 0) === 1;
  }
}
