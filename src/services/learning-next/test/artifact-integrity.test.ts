import assert from "node:assert/strict";
import test from "node:test";
import { digestJson, encodeArtifact, verifiedArtifactPayload } from "../src/artifact-integrity.ts";

test("artifact integrity uses one canonical JSON representation across key order", () => {
  const encoded = encodeArtifact({ z:2,a:1 });
  assert.equal(encoded.json, '{"a":1,"z":2}');
  assert.equal(encoded.sha256, digestJson({ a:1,z:2 }));
  assert.deepEqual(verifiedArtifactPayload({ payload:{ z:2,a:1 },sha256:encoded.sha256 }, "test artifact"), { z:2,a:1 });
});

test("artifact integrity rejects a stored payload whose digest does not match", () => {
  const digest = digestJson({ value:"original" });
  assert.throws(
    () => verifiedArtifactPayload({ payload:{ value:"tampered" },sha256:digest }, "test artifact"),
    /failed canonical JSON integrity verification/,
  );
});
