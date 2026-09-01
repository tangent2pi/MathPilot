import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("0041 refuses legacy avatar and object bytes before any schema mutation", async () => {
  const migration = await readFile(
    new URL("../../../../db/migrations/0041_content_integrity.sql", import.meta.url),
    "utf8",
  );
  const avatarGuard = migration.indexOf("if exists (select 1 from identity_user_avatar)");
  const objectGuard = migration.indexOf("if exists (select 1 from storage_object)");
  const attachmentGuard = migration.indexOf("pre-integrity message attachments require a fresh Next database");
  const firstMutation = migration.indexOf("alter table storage_object");
  const avatarDrop = migration.indexOf("drop table identity_user_avatar");
  assert.ok(avatarGuard > 0);
  assert.ok(avatarGuard < firstMutation);
  assert.ok(objectGuard > avatarGuard);
  assert.ok(objectGuard < firstMutation);
  assert.ok(attachmentGuard > objectGuard);
  assert.ok(attachmentGuard < firstMutation);
  assert.ok(avatarGuard < avatarDrop);
  assert.match(migration, /0041 did not modify identity_user_avatar/);
  assert.match(migration, /0041 did not infer source versions or retire pending storage objects/);
  assert.match(migration, /0041 did not rewrite attachment parts or synthesize immutable claims/);
  assert.doesNotMatch(migration, /pre_integrity_object_retired/);
  assert.doesNotMatch(migration, /Strictly upgrade current Next messages/);
  assert.doesNotMatch(migration, /disable trigger science_v3_canonical_message/);
  assert.doesNotMatch(migration, /with upgraded as/);
  assert.doesNotMatch(migration, /with bound as/);
});

test("the Pi bootstrap rejects legacy tables before creating the final schema", async () => {
  const migration = await readFile(
    new URL("../../../apps/web-next/db/migrations/0001_pi_session_schema.sql", import.meta.url),
    "utf8",
  );
  assert.ok(migration.indexOf("unsupported legacy mathpilot_pi schema") < migration.indexOf("create table if not exists pi_threads"));
  assert.match(migration, /keep\/export it and provision a separate empty mathpilot_pi database/);
});
