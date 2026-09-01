import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { loadApiNextSecurityConfig } from "../src/security-config.ts";

const authSecret = "a".repeat(32);
const evidenceSecret = "e".repeat(32);

test("explicit development is the only profile that receives distinct development defaults", () => {
  const config = loadApiNextSecurityConfig({ MATHPILOT_ENVIRONMENT: "development" });
  assert.equal(config.environment, "development");
  assert.ok(Buffer.byteLength(config.betterAuthSecret) >= 32);
  assert.ok(Buffer.byteLength(config.evidenceSecret) >= 32);
  assert.notEqual(config.betterAuthSecret, config.evidenceSecret);
});

test("non-development profiles fail fast for missing, short, shared, or development-default secrets", () => {
  assert.throws(() => loadApiNextSecurityConfig({}), /BETTER_AUTH_SECRET is required/);
  assert.throws(() => loadApiNextSecurityConfig({
    MATHPILOT_ENVIRONMENT: "production",
    BETTER_AUTH_SECRET: authSecret,
  }), /LEARNING_EVIDENCE_SECRET is required/);
  assert.throws(() => loadApiNextSecurityConfig({
    MATHPILOT_ENVIRONMENT: "production",
    BETTER_AUTH_SECRET: "short",
    LEARNING_EVIDENCE_SECRET: evidenceSecret,
  }), /BETTER_AUTH_SECRET must contain at least 32 bytes/);
  assert.throws(() => loadApiNextSecurityConfig({
    MATHPILOT_ENVIRONMENT: "production",
    BETTER_AUTH_SECRET: authSecret,
    LEARNING_EVIDENCE_SECRET: authSecret,
  }), /must be independent/);
  assert.throws(() => loadApiNextSecurityConfig({
    MATHPILOT_ENVIRONMENT: "production",
    BETTER_AUTH_SECRET: "mathpilot-dev-secret-change-me-at-least-32-characters",
    LEARNING_EVIDENCE_SECRET: evidenceSecret,
  }), /cannot use a MathPilot development default/);
  assert.throws(() => loadApiNextSecurityConfig({
    MATHPILOT_ENVIRONMENT: "production",
    BETTER_AUTH_SECRET: "mathpilot-dev-evidence-secret-change-me-at-least-32-characters",
    LEARNING_EVIDENCE_SECRET: evidenceSecret,
  }), /cannot use a MathPilot development default/);
  assert.throws(() => loadApiNextSecurityConfig({
    MATHPILOT_ENVIRONMENT: "production",
    BETTER_AUTH_SECRET: authSecret,
    LEARNING_EVIDENCE_SECRET: "mathpilot-dev-secret-change-me-at-least-32-characters",
  }), /cannot use a MathPilot development default/);
  assert.throws(() => loadApiNextSecurityConfig({
    MATHPILOT_ENVIRONMENT: "staging",
    BETTER_AUTH_SECRET: authSecret,
    LEARNING_EVIDENCE_SECRET: evidenceSecret,
  }), /MATHPILOT_ENVIRONMENT/);
});

test("production accepts explicit independent secrets", () => {
  assert.deepEqual(loadApiNextSecurityConfig({
    MATHPILOT_ENVIRONMENT: "production",
    BETTER_AUTH_SECRET: authSecret,
    LEARNING_EVIDENCE_SECRET: evidenceSecret,
  }), {
    environment: "production",
    betterAuthSecret: authSecret,
    evidenceSecret,
  });
});

test("evidence handles use only the configured evidence key and reject tampering", async () => {
  const previous = {
    environment: process.env.MATHPILOT_ENVIRONMENT,
    auth: process.env.BETTER_AUTH_SECRET,
    evidence: process.env.LEARNING_EVIDENCE_SECRET,
  };
  process.env.MATHPILOT_ENVIRONMENT = "test";
  process.env.BETTER_AUTH_SECRET = authSecret;
  process.env.LEARNING_EVIDENCE_SECRET = evidenceSecret;
  try {
    const { evidenceHandle, parseEvidenceHandle } = await import("../src/learning-read/cursor.ts");
    const reference = { kind: "judgment" as const, id: "jdg_security01", studentId: "stu_security01" };
    const handle = evidenceHandle(reference);
    const [payload, signature] = handle.split(".") as [string, string];
    assert.equal(signature, createHmac("sha256", evidenceSecret).update(payload).digest("base64url"));
    assert.notEqual(signature, createHmac("sha256", authSecret).update(payload).digest("base64url"));
    assert.deepEqual(parseEvidenceHandle(handle), reference);
    const tampered = `${payload}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
    assert.throws(() => parseEvidenceHandle(tampered), /依据不存在或已失效/);
  } finally {
    if (previous.environment === undefined) delete process.env.MATHPILOT_ENVIRONMENT;
    else process.env.MATHPILOT_ENVIRONMENT = previous.environment;
    if (previous.auth === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = previous.auth;
    if (previous.evidence === undefined) delete process.env.LEARNING_EVIDENCE_SECRET;
    else process.env.LEARNING_EVIDENCE_SECRET = previous.evidence;
  }
});
