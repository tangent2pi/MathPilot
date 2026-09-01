import { createHash } from "node:crypto";
import type { InternalServiceRuntime } from "@mathpilot/internal-service";
import type { WorkspaceObjectReader } from "./runtime-types.ts";

const objectIdPattern = /^obj_[A-Za-z0-9]{8,}$/;

export class StorageNextObjectReader implements WorkspaceObjectReader {
  constructor(private readonly internalService: InternalServiceRuntime) {}

  async read(input: Parameters<WorkspaceObjectReader["read"]>[0]): Promise<Buffer> {
    if (!objectIdPattern.test(input.object.objectId)) throw new Error("invalid WorkspaceProjection object ID");
    const response = await this.internalService.request(
      "learning-to-storage",
      { tenantId: input.tenantId, userId: input.accountUserId, roles: input.roles },
      `/internal/objects/${encodeURIComponent(input.object.objectId)}/presign-get`,
      { method: "POST", json: { audience: "runtime" }, signal: input.signal },
    );
    if (!response.ok) throw new Error(`storage-next rejected an authorized object read (${response.status})`);
    const metadata = await response.json() as Record<string, unknown>;
    if (metadata.object_id !== input.object.objectId
      || metadata.mime_type !== input.object.mimeType
      || metadata.byte_size !== input.object.byteSize
      || metadata.sha256 !== input.object.sha256
      || typeof metadata.download_url !== "string") {
      throw new Error("storage-next object metadata does not match the frozen WorkspaceProjection");
    }
    const download = await fetch(metadata.download_url, { signal: input.signal });
    if (!download.ok) throw new Error(`object download failed (${download.status})`);
    const content = Buffer.from(await download.arrayBuffer());
    if (content.byteLength !== input.object.byteSize) throw new Error("WorkspaceProjection object size changed");
    const digest = createHash("sha256").update(content).digest("hex");
    if (digest !== input.object.sha256) throw new Error("WorkspaceProjection object digest changed");
    return content;
  }
}
