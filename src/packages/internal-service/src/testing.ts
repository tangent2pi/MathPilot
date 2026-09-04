import { createHash } from "node:crypto";
import { base64url } from "jose";
import { INTERNAL_TEST_KEY_SENTINEL } from "./config.ts";
import { INTERNAL_EDGES, type InternalEdgeId } from "./topology.ts";

export const testKeyForEdge = (edge: InternalEdgeId, version = "test-v1"): string => base64url.encode(Buffer.concat([
  INTERNAL_TEST_KEY_SENTINEL,
  createHash("sha256")
    .update(`mathpilot-internal-service-test:${edge}:${version}`, "utf8")
    .digest()
    .subarray(0, 32 - INTERNAL_TEST_KEY_SENTINEL.byteLength),
]));

export const testKeyringForEdge = (
  edge: InternalEdgeId,
  active = "test-v1",
  versions: readonly string[] = [active],
): string => JSON.stringify({
  active,
  keys: Object.fromEntries(versions.map((version) => [version, testKeyForEdge(edge, version)])),
});

export function internalServiceTestEnvironment(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  const source: Record<string, string | undefined> = {
    MATHPILOT_ENVIRONMENT: "test",
    MATHPILOT_INTERNAL_REPLAY_MODE: "memory-single-replica",
    MATHPILOT_INTERNAL_CONTENT_URL: "http://content-next.test:3016",
    MATHPILOT_INTERNAL_PI_URL: "http://pi-chat-runtime.test:3105",
    MATHPILOT_INTERNAL_STORAGE_URL: "http://storage-next.test:3017",
    MATHPILOT_INTERNAL_GROUP_URL: "http://group-next.test:3018",
  };
  for (const edge of Object.values(INTERNAL_EDGES)) source[edge.keyringEnv] = testKeyringForEdge(edge.id);
  return { ...source, ...overrides };
}
