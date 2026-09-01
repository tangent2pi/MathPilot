import assert from "node:assert/strict";
import test from "node:test";
import type pg from "pg";
import { ObjectGarbageCollector } from "../src/object-garbage-collector.ts";

const logger = { info() {}, warn() {}, error() {} };

test("a deletion lease removes each known immutable version once and then records completion", async () => {
  const queries: string[] = [];
  const removed: string[] = [];
  const pool = {
    async query(text: string) {
      queries.push(text);
      if (text.includes("mathpilot_storage_begin_deletions")) return { rows: [{
        object_id: "obj_delete0001", bucket_name: "mathpilot-session",
        source_object_key: "objects/t/o/content", source_version_id: "version-1",
        object_key: "objects/t/o/content", version_id: "version-1", deletion_attempts: 1,
      }] };
      if (text.includes("mathpilot_storage_finish_deletion")) return { rows: [{ finished: true }] };
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  const collector = new ObjectGarbageCollector({
    pool, logger,
    objects: { async removeVersion(bucket, key, versionId) { removed.push(`${bucket}/${key}@${versionId}`); } },
  });

  await collector.sweepOnce(new AbortController().signal);

  assert.deepEqual(removed, ["mathpilot-session/objects/t/o/content@version-1"]);
  assert.equal(queries.filter((query) => query.includes("mathpilot_storage_finish_deletion")).length, 1);
  assert.equal(queries.some((query) => query.includes("mathpilot_storage_retry_deletion")), false);
});

test("a physical deletion failure releases the lease through the shared retry function", async () => {
  const queries: string[] = [];
  const pool = {
    async query(text: string) {
      queries.push(text);
      if (text.includes("mathpilot_storage_begin_deletions")) return { rows: [{
        object_id: "obj_delete0002", bucket_name: "mathpilot-working",
        source_object_key: "quarantine/t/o", source_version_id: "source-version",
        object_key: "objects/t/o/content", version_id: null, deletion_attempts: 2,
      }] };
      return { rows: [{ mathpilot_storage_retry_deletion: true }] };
    },
  } as unknown as pg.Pool;
  const collector = new ObjectGarbageCollector({
    pool, logger,
    objects: { async removeVersion() { throw new Error("S3-compatible object store unavailable"); } },
  });

  await collector.sweepOnce(new AbortController().signal);

  assert.equal(queries.some((query) => query.includes("mathpilot_storage_retry_deletion")), true);
  assert.equal(queries.some((query) => query.includes("mathpilot_storage_finish_deletion")), false);
});
