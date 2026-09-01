import { createHash } from "node:crypto";
import { base64url } from "jose";
import { z } from "zod";
import {
  INTERNAL_EDGES,
  INTERNAL_SERVICE_IDS,
  internalEdgesForService,
  type InternalEdgeDefinition,
  type InternalEdgeId,
  type InternalServiceId,
} from "./topology.ts";
import type { MathPilotEnvironment } from "./types.ts";

type EnvironmentSource = Readonly<Record<string, string | undefined>>;

const keyIdSchema = z.string().min(1).max(32).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const isValidInternalKeyId = (value: unknown): value is string => keyIdSchema.safeParse(value).success;
export const INTERNAL_TEST_KEY_SENTINEL = Buffer.from("mathpilot:test-key:v1\u0000", "utf8");
const encodedKeySchema = z.string().min(43).max(128).regex(/^[A-Za-z0-9_-]+$/);
const rawKeyringSchema = z.object({
  active: keyIdSchema,
  keys: z.record(keyIdSchema, encodedKeySchema),
}).strict();

export interface InternalEdgeKeyring {
  edge: InternalEdgeDefinition;
  activeKeyId: string;
  keys: ReadonlyMap<string, Uint8Array>;
}

export interface InternalServiceConfiguration {
  environment: MathPilotEnvironment;
  replayMode: "memory-single-replica";
  service: InternalServiceId;
  keyrings: ReadonlyMap<InternalEdgeId, InternalEdgeKeyring>;
  targetUrls: ReadonlyMap<InternalServiceId, string>;
}

export class InternalServiceConfigurationError extends Error {
  override readonly name = "InternalServiceConfigurationError";
}

const environmentOf = (source: EnvironmentSource): MathPilotEnvironment => {
  const value = source.MATHPILOT_ENVIRONMENT?.trim() || "production";
  if (value !== "development" && value !== "test" && value !== "production") {
    throw new InternalServiceConfigurationError("MATHPILOT_ENVIRONMENT must be development, test, or production");
  }
  return value;
};

export const developmentKeyForEdge = (edge: InternalEdgeId): string =>
  base64url.encode(createHash("sha256").update(`mathpilot-public-development-key:${edge}`, "utf8").digest());

export const developmentKeyringForEdge = (edge: InternalEdgeId): string => JSON.stringify({
  active: "dev-v1",
  keys: { "dev-v1": developmentKeyForEdge(edge) },
});

const publicDevelopmentKeys = new Set(
  (Object.keys(INTERNAL_EDGES) as InternalEdgeId[]).map(developmentKeyForEdge),
);

const decodeKey = (
  edge: InternalEdgeDefinition,
  keyId: string,
  value: string,
  environment: MathPilotEnvironment,
): Uint8Array => {
  let decoded: Uint8Array;
  try {
    decoded = base64url.decode(value);
  } catch {
    throw new InternalServiceConfigurationError(`${edge.keyringEnv} contains an invalid key encoding`);
  }
  if (base64url.encode(decoded) !== value || decoded.byteLength < 32 || decoded.byteLength > 64) {
    throw new InternalServiceConfigurationError(`${edge.keyringEnv} keys must be canonical base64url values containing 32 to 64 bytes`);
  }
  if (environment !== "development" && publicDevelopmentKeys.has(value)) {
    throw new InternalServiceConfigurationError(`${edge.keyringEnv} cannot use any public development key outside development`);
  }
  if (environment === "production"
    && Buffer.from(decoded).subarray(0, INTERNAL_TEST_KEY_SENTINEL.byteLength).equals(INTERNAL_TEST_KEY_SENTINEL)) {
    throw new InternalServiceConfigurationError(`${edge.keyringEnv} cannot use a test fixture key in production`);
  }
  if (!keyId) throw new InternalServiceConfigurationError(`${edge.keyringEnv} contains an invalid key id`);
  return decoded;
};

const parseKeyring = (
  edge: InternalEdgeDefinition,
  source: EnvironmentSource,
  environment: MathPilotEnvironment,
): InternalEdgeKeyring => {
  const configured = source[edge.keyringEnv];
  const serialized = configured?.trim()
    || (environment === "development" ? developmentKeyringForEdge(edge.id) : "");
  if (!serialized) throw new InternalServiceConfigurationError(`${edge.keyringEnv} is required`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new InternalServiceConfigurationError(`${edge.keyringEnv} must be a JSON keyring`);
  }
  const result = rawKeyringSchema.safeParse(parsed);
  if (!result.success) throw new InternalServiceConfigurationError(`${edge.keyringEnv} must contain one active key and a bounded key map`);
  const entries = Object.entries(result.data.keys);
  if (entries.length < 1 || entries.length > 3 || !Object.hasOwn(result.data.keys, result.data.active)) {
    throw new InternalServiceConfigurationError(`${edge.keyringEnv} must contain one to three keys including its active key`);
  }
  const keys = new Map(entries.map(([keyId, value]) => [keyId, decodeKey(edge, keyId, value, environment)]));
  return Object.freeze({ edge, activeKeyId: result.data.active, keys });
};

const targetUrl = (edge: InternalEdgeDefinition, source: EnvironmentSource): string => {
  const configured = source[edge.targetUrlEnv]?.trim();
  if (!configured) throw new InternalServiceConfigurationError(`${edge.targetUrlEnv} is required by ${edge.caller}`);
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new InternalServiceConfigurationError(`${edge.targetUrlEnv} must be an absolute HTTP URL`);
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new InternalServiceConfigurationError(`${edge.targetUrlEnv} must be an absolute HTTP URL without credentials, query, or fragment`);
  }
  return url.toString().replace(/\/$/, "");
};

const assertDistinctKeys = (keyrings: Iterable<InternalEdgeKeyring>): void => {
  const seen = new Map<string, string>();
  for (const keyring of keyrings) {
    for (const [keyId, key] of keyring.keys) {
      const fingerprint = createHash("sha256").update(key).digest("hex");
      const owner = seen.get(fingerprint);
      if (owner) {
        throw new InternalServiceConfigurationError(`internal service keys must be independent; duplicate key material is configured for ${owner} and ${keyring.edge.id}/${keyId}`);
      }
      seen.set(fingerprint, `${keyring.edge.id}/${keyId}`);
    }
  }
};

const replayModeOf = (source: EnvironmentSource, environment: MathPilotEnvironment): "memory-single-replica" => {
  const configured = source.MATHPILOT_INTERNAL_REPLAY_MODE?.trim()
    || (environment === "development" || environment === "test" ? "memory-single-replica" : "");
  if (configured !== "memory-single-replica") {
    throw new InternalServiceConfigurationError("MATHPILOT_INTERNAL_REPLAY_MODE must explicitly acknowledge memory-single-replica in production");
  }
  return configured;
};

export function loadInternalServiceConfiguration(
  service: InternalServiceId,
  source: EnvironmentSource = process.env,
): InternalServiceConfiguration {
  if (!(INTERNAL_SERVICE_IDS as readonly string[]).includes(service)) {
    throw new InternalServiceConfigurationError("unknown internal service id");
  }
  const environment = environmentOf(source);
  const replayMode = replayModeOf(source, environment);
  const edges = internalEdgesForService(service);
  const keyrings = new Map<InternalEdgeId, InternalEdgeKeyring>();
  const targetUrls = new Map<InternalServiceId, string>();
  for (const edge of edges) {
    keyrings.set(edge.id, parseKeyring(edge, source, environment));
    if (edge.caller === service) {
      const url = targetUrl(edge, source);
      const previous = targetUrls.get(edge.audience);
      if (previous && previous !== url) throw new InternalServiceConfigurationError(`${edge.targetUrlEnv} must resolve consistently for ${edge.audience}`);
      targetUrls.set(edge.audience, url);
    }
  }
  assertDistinctKeys(keyrings.values());
  return Object.freeze({ environment, replayMode, service, keyrings, targetUrls });
}

export function validateInternalDeploymentConfiguration(source: EnvironmentSource = process.env): void {
  const environment = environmentOf(source);
  replayModeOf(source, environment);
  const keyrings = Object.values(INTERNAL_EDGES).map((edge) => parseKeyring(edge as InternalEdgeDefinition, source, environment));
  assertDistinctKeys(keyrings);
}
