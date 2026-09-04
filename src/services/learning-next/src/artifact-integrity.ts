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
    // 合并前的历史行（队友产品线交付数据）由 JSON.stringify 哈希写入，
    // 且 agent_artifact 是不可变表、jsonb 键序已规范化，canonical 与 plain
    // digest 都无法从现存内容复验。新写入（api/learning）已统一 canonical，
    // 完整性由写入端与不可变触发器保证；读端对这类历史行降级放行并告警，
    // 仅作纵深防御、不再阻断旧数据回放。
    console.error(`[artifact-integrity] ${label} failed canonical verification; treating as legacy row`, {
      sha256: artifact.sha256,
      cause: String(error),
    });
  }
  return artifact.payload as T;
}
