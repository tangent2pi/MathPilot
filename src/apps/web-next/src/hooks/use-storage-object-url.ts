import { useQuery } from "@tanstack/react-query";
import { storageObjectResolveResponseSchema } from "@mathpilot/content-integrity";

const OBJECT_REF = /^storage-object:(obj_[A-Za-z0-9]{8,})$/;

export function useStorageObjectUrl(reference: string | undefined): string | undefined {
  const objectId = reference ? OBJECT_REF.exec(reference)?.[1] : undefined;
  const query = useQuery({
    queryKey: ["storage-object-url", objectId],
    enabled: Boolean(objectId),
    staleTime: 240_000,
    gcTime: 300_000,
    retry: 1,
    queryFn: async () => {
      const response = await fetch("/api/storage/objects/resolve", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ object_refs:[`storage-object:${objectId!}`] }),
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
