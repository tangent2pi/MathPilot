import { canonicalJson, verifyCanonicalJson } from "@mathpilot/content-integrity/node";

export const MAXIMUM_ARTIFACT_BYTES = 1024 * 1024;

export interface StoredJsonArtifact {
  payload: unknown;
  sha256: string;
}

export const encodeArtifact = (value: unknown) => canonicalJson(value, MAXIMUM_ARTIFACT_BYTES);

export const digestJson = (value: unknown): string => encodeArtifact(value).sha256;

export function verifiedArtifactPayload<T = unknown>(artifact: StoredJsonArtifact, label: string): T {
  try {
    verifyCanonicalJson(artifact.payload, artifact.sha256, MAXIMUM_ARTIFACT_BYTES);
  } catch (error) {
    throw new Error(`${label} failed canonical JSON integrity verification`, { cause: error });
  }
  return artifact.payload as T;
}
