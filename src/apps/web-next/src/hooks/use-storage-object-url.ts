import { useQuery } from "@tanstack/react-query";
import {
  canonicalObjectReference,
  parseObjectReference,
  storageObjectResolveRequestSchema,
  storageObjectResolveResponseSchema,
  type StorageObjectDownloadIntent,
} from "@mathpilot/content-integrity";

export function storageObjectResolveBody(reference: string, downloadIntent: StorageObjectDownloadIntent) {
  const objectId = parseObjectReference(reference);
  if (!objectId) return undefined;
  return storageObjectResolveRequestSchema.parse({
    object_refs: [canonicalObjectReference(objectId)],
    download_intent: downloadIntent,
  });
}

export function useStorageObjectUrl(
  reference: string | undefined,
  downloadIntent: StorageObjectDownloadIntent = "attachment",
): string | undefined {
  const body = reference ? storageObjectResolveBody(reference, downloadIntent) : undefined;
  const objectRef = body?.object_refs[0];
  const query = useQuery({
    queryKey: ["storage-object-url", objectRef, downloadIntent],
    enabled: Boolean(body),
    staleTime: 240_000,
    gcTime: 300_000,
    retry: 1,
    queryFn: async () => {
      const response = await fetch("/api/storage/objects/resolve", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`无法读取附件（${response.status}）`);
      const result = storageObjectResolveResponseSchema.parse(await response.json());
      const object=result.objects[0];
      if (!object) throw new Error("附件地址无效");
      return object.download.url;
    },
  });
  return query.data;
}
