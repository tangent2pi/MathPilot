import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";
import { BUCKETS, type BucketName, type ObjectStore } from "./object-store.ts";

interface DeletionLease {
  object_id: string;
  bucket_name: string;
  source_object_key: string;
  source_version_id: string | null;
  object_key: string;
  version_id: string | null;
  deletion_attempts: number;
}

export interface ObjectDeletionStore {
  removeVersion(bucket: BucketName, key: string, versionId: string, signal: AbortSignal): Promise<void>;
}

export class ObjectGarbageCollector {
  constructor(private readonly dependencies: {
    pool: pg.Pool;
    objects: Pick<ObjectStore, "removeVersion">;
    logger: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
  }) {}

  async sweepOnce(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const leaseId = randomUUID();
    const startedAt = Date.now();
    const leased = await this.dependencies.pool.query<DeletionLease>(
      "select * from mathpilot_storage_begin_deletions($1,$2)",
      [leaseId, 32],
    );
    if (leased.rows.length === 0) return;

    const outcomes = await Promise.allSettled(leased.rows.map((row) => this.deleteLeased(leaseId, row, signal)));
    const failures = outcomes.filter((outcome) => outcome.status === "rejected").length;
    this.dependencies.logger.info({
      leased: leased.rows.length,
      deleted: leased.rows.length - failures,
      failures,
      durationMs: Date.now() - startedAt,
    }, "storage object deletion sweep completed");
  }

  private async deleteLeased(leaseId: string, row: DeletionLease, signal: AbortSignal): Promise<void> {
    try {
      if (!BUCKETS.includes(row.bucket_name as BucketName)) throw new Error("invalid object bucket in deletion lease");
      const versions = new Map<string, { key: string; versionId: string }>();
      if (row.source_version_id) {
        versions.set(`${row.source_object_key}\0${row.source_version_id}`, {
          key: row.source_object_key,
          versionId: row.source_version_id,
        });
      }
      if (row.version_id) {
        versions.set(`${row.object_key}\0${row.version_id}`, {
          key: row.object_key,
          versionId: row.version_id,
        });
      }
      await Promise.all([...versions.values()].map((version) => this.dependencies.objects.removeVersion(
        row.bucket_name as BucketName,
        version.key,
        version.versionId,
        signal,
      )));
      const finished = await this.dependencies.pool.query<{ finished: boolean }>(
        "select mathpilot_storage_finish_deletion($1,$2) as finished",
        [leaseId, row.object_id],
      );
      if (!finished.rows[0]?.finished) {
        this.dependencies.logger.warn({ objectId: row.object_id }, "storage deletion lease was lost after byte removal");
      }
    } catch (error) {
      await this.dependencies.pool.query(
        "select mathpilot_storage_retry_deletion($1,$2,$3)",
        [leaseId, row.object_id, "storage_delete_failed"],
      ).catch((retryError) => {
        this.dependencies.logger.error({ err: retryError, objectId: row.object_id }, "storage deletion retry could not be recorded");
      });
      this.dependencies.logger.warn({
        err: error,
        objectId: row.object_id,
        attempt: row.deletion_attempts,
      }, "storage object deletion failed and was rescheduled");
      throw error;
    }
  }
}
