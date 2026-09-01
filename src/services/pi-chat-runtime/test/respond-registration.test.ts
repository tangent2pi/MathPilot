import assert from "node:assert/strict";
import test from "node:test";
import type { ImmutableObjectDescriptor } from "@mathpilot/content-integrity";
import { candidateRegistrationDisposition } from "../extensions/respond.ts";

const digest = "a".repeat(64);
const descriptor = (objectId: string): ImmutableObjectDescriptor => ({
  object_id: objectId,
  object_ref: `storage-object:${objectId}`,
  version_id: `version-${objectId}`,
  sha256: digest,
  byte_size: 1,
  mime_type: "application/json",
  original_name: `${objectId}.json`,
  source: {
    version_id: `source-${objectId}`,
    sha256: digest,
    byte_size: 1,
    mime_type: "application/json",
  },
  expires_at: null,
});

const audits = [descriptor("obj_result01"), descriptor("obj_receipt01")] as const;

test("candidate registration claims only the exact audit pair reported by Content", () => {
  assert.deepEqual(candidateRegistrationDisposition({ registration: {
    created: true,
    result_object_id: audits[0].object_id,
    receipt_object_id: audits[1].object_id,
    result_sha256: digest,
  } }, audits, digest), { claimed: true, replayed: false });

  assert.deepEqual(candidateRegistrationDisposition({ registration: {
    created: false,
    result_object_id: "obj_previous1",
    receipt_object_id: "obj_previous2",
    result_sha256: digest,
  } }, audits, digest), { claimed: false, replayed: true });
});

test("candidate registration rejects an inconsistent create receipt", () => {
  assert.throws(() => candidateRegistrationDisposition({ registration: {
    created: true,
    result_object_id: "obj_different1",
    receipt_object_id: "obj_different2",
    result_sha256: digest,
  } }, audits, digest), /claimed different audit objects/);
});
