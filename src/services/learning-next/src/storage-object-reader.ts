import {
  immutableObjectDescriptorSchema,
  MAXIMUM_THREAD_OBJECT_BYTES,
  storageObjectResolveRequestSchema,
} from "@mathpilot/content-integrity";
import { resolveAndMaterializeObjects } from "@mathpilot/content-integrity/node";
import type { InternalServiceRuntime } from "@mathpilot/internal-service";
import {
  type WorkspaceObjectReader,
} from "./runtime-types.ts";

export class StorageNextObjectReader implements WorkspaceObjectReader {
  constructor(private readonly internalService: InternalServiceRuntime) {}

  async materialize(input: Parameters<WorkspaceObjectReader["materialize"]>[0]): Promise<void> {
    await resolveAndMaterializeObjects({
      signal: input.signal,
      maximumAggregateBytes: MAXIMUM_THREAD_OBJECT_BYTES,
      objects: input.objects.map(({ object, destination }) => ({
        descriptor: immutableObjectDescriptorSchema.parse(object.descriptor),
        destination,
      })),
      resolve: (objectRefs, signal) => this.internalService.request(
        "learning-to-storage",
        { tenantId: input.tenantId, userId: input.accountUserId, roles: input.roles },
        "/internal/objects/resolve",
        {
          method: "POST",
          json: storageObjectResolveRequestSchema.parse({
            object_refs: objectRefs,
            download_intent: "attachment",
          }),
          signal,
          timeoutMs: 30_000,
        },
      ),
    });
  }
}
