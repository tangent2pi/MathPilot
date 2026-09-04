import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 0055 is the merged-line adaptation of the local 0041_content_integrity
// migration (applied after teammate 0041-0054). This test pins the boundary
// decisions that keep the teammate product flows working:
//   - purpose enum extends with the teammate 'paper' purpose
//   - the storage guard permits the teammate pending->ready transition
//   - candidate-source seal, audit claim trigger, avatar reshape and
//     message-attachment claim triggers are NOT ported
//   - the additive claim/lease/FK machinery IS ported

const migration = await readFile(
  new URL("../../../../db/migrations/0055_content_integrity.sql", import.meta.url),
  "utf8",
);

test("0055 keeps the teammate paper purpose in the storage enum", () => {
  assert.match(migration, /purpose in \('source','candidate','package','thread','derived','paper','avatar'\)/);
});

test("0055 permits the teammate pending->ready storage transition", () => {
  assert.match(migration, /old\.state='pending' and new\.state in \('verifying','ready','failed','deleting'\)/);
});

test("0055 keeps storage object rows as lifecycle facts", () => {
  assert.match(migration, /storage object rows are lifecycle facts and cannot be deleted/);
});

test("0055 does not port the candidate-source seal machinery", () => {
  assert.doesNotMatch(migration, /content_candidate_source_object/);
  assert.doesNotMatch(migration, /content_candidate_set_requires_sources/);
  assert.doesNotMatch(migration, /mathpilot_content_bind_candidate_source_object/);
  assert.doesNotMatch(migration, /mathpilot_content_claim_candidate_audit_object/);
});

test("0055 does not port the object-based avatar reshape", () => {
  assert.doesNotMatch(migration, /drop table identity_user_avatar/);
  assert.doesNotMatch(migration, /create or replace function mathpilot_identity_set_avatar/);
});

test("0055 does not port the canonical-message attachment claim triggers", () => {
  assert.doesNotMatch(migration, /science_v3_message_attachment/);
  assert.doesNotMatch(migration, /mathpilot_science_v3_claim_message_attachments/);
});

test("0055 does not carry fresh-cutover refusal guards", () => {
  assert.doesNotMatch(migration, /fresh Next database/);
});

test("0055 keeps the additive claim and deletion-lease machinery", () => {
  assert.match(migration, /create table storage_object_claim/);
  assert.match(migration, /mathpilot_storage_begin_deletions/);
  assert.match(migration, /mathpilot_storage_finish_deletion/);
  assert.match(migration, /mathpilot_storage_retry_deletion/);
});

test("0055 keeps tenant-composite object foreign keys", () => {
  assert.match(migration, /content_source_storage_object_tenant_fk/);
  assert.match(migration, /content_package_manifest_object_tenant_fk/);
  assert.match(migration, /content_candidate_set_result_object_tenant_fk/);
});

test("0055 records its own version", () => {
  assert.match(migration, /values \('0055_content_integrity'\)/);
});
