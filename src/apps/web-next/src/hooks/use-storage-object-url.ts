import { useQuery } from "@tanstack/react-query";

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
      const response = await fetch(`/api/storage/objects/${encodeURIComponent(objectId!)}/presign-get`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audience: "public" }),
      });
      if (!response.ok) throw new Error(`无法读取附件（${response.status}）`);
      const result = await response.json() as { download_url?: unknown };
      if (typeof result.download_url !== "string") throw new Error("附件地址无效");
      return result.download_url;
    },
  });
  return query.data;
}
