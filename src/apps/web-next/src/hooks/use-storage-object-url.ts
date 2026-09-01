import { useQuery } from "@tanstack/react-query";
import {
  canonicalObjectReference,
  parseObjectReference,
  storageObjectResolveRequestSchema,
  storageObjectResolveResponseSchema,
  type StorageObjectDownloadIntent,
} from "@mathpilot/content-integrity";
import { responseJson } from "../lib/http-problem";

type StorageObjectResolveBody = ReturnType<typeof storageObjectResolveRequestSchema.parse>;

export function storageObjectResolveBody(reference: string, downloadIntent: StorageObjectDownloadIntent) {
  const objectId = parseObjectReference(reference);
  if (!objectId) return undefined;
  return storageObjectResolveRequestSchema.parse({
    object_refs: [canonicalObjectReference(objectId)],
    download_intent: downloadIntent,
  });
}

export async function resolveStorageObjectUrl(
  body: StorageObjectResolveBody,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const response = await fetcher("/api/storage/objects/resolve", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = storageObjectResolveResponseSchema.parse(
    await responseJson<unknown>(response, "无法读取附件"),
  );
  const object = result.objects[0];
  if (!object) throw new Error("附件地址无效");
  return object.download.url;
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
    queryFn: () => resolveStorageObjectUrl(body!),
  });
  return query.data;
}
