import assert from "node:assert/strict";
import test from "node:test";
import { loadLearningTenantIds } from "../src/production-config.ts";

test("learning tenant configuration defaults only in explicit development", () => {
  assert.deepEqual(loadLearningTenantIds("development", {}), ["tnt_dev00001"]);
  assert.throws(() => loadLearningTenantIds("production", {}), /is required outside development/);
  assert.throws(() => loadLearningTenantIds("test", {}), /is required outside development/);
});

test("learning tenant configuration accepts an explicit default or validated override", () => {
  assert.deepEqual(loadLearningTenantIds("production", { DEFAULT_TENANT_ID: "tnt_primary01" }), ["tnt_primary01"]);
  assert.deepEqual(loadLearningTenantIds("production", {
    DEFAULT_TENANT_ID: "tnt_primary01",
    LEARNING_NEXT_TENANT_IDS: "tnt_primary01,tnt_second001,tnt_primary01",
  }), ["tnt_primary01", "tnt_second001"]);
  assert.throws(() => loadLearningTenantIds("production", {
    LEARNING_NEXT_TENANT_IDS: "legacy-tenant",
  }), /valid tenant IDs/);
});
