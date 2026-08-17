/**
 * ArtifactPublisher：Learning Artifact 唯一发布通道（设计 §5.4）。
 * 未发布文件、越界路径、符号链接逃逸、危险 MIME、伪造交互事件一律拒绝。
 */
import type { ProviderRequestBase, ProviderResult } from "../errors.js";

export interface PublishFile {
  /** 相对 Artifact 根的路径；仅允许 manifest.json / card.json / index.html / content.md / media/* */
  readonly path: string;
  readonly mimeType: string;
  readonly bytesRef: string;
  readonly contentHash: string;
}

export interface PublishRequest extends ProviderRequestBase {
  readonly sessionId: string;
  readonly artifactId: string;
  /** 必须符合 schemas/learning/learning-artifact-manifest.schema.json */
  readonly manifest: Record<string, unknown>;
  readonly files: readonly PublishFile[];
}

export interface PublishResponse {
  /** 发布成功后的稳定引用：artifact://<session>/<artifact> */
  readonly artifactUri: string;
  /** 不可变版本标识 */
  readonly artifactVersionId: string;
}

export type PublishRejection =
  | "invalid_manifest"
  | "path_escape"
  | "symlink_escape"
  | "dangerous_mime"
  | "size_exceeded"
  | "hash_mismatch"
  | "html_sanitize_failed";

export interface ArtifactPublisher {
  publish(
    req: PublishRequest,
  ): Promise<ProviderResult<PublishResponse> | { readonly ok: false; readonly rejection: PublishRejection; readonly detail: string }>;
}
