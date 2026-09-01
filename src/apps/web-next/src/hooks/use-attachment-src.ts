"use client";

import { useEffect, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import { useShallow } from "zustand/react/shallow";
import { useStorageObjectUrl } from "./use-storage-object-url";

const useFileSrc = (file: File | undefined) => {
  const [entry, setEntry] = useState<{ file: File; url: string } | undefined>(
    undefined,
  );

  useEffect(() => {
    if (!file) {
      setEntry(undefined);
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setEntry({ file, url: objectUrl });

    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  return entry !== undefined && entry.file === file ? entry.url : undefined;
};

export const useAttachmentSrc = () => {
  const { file, src, objectRef } = useAuiState(
    useShallow((s): { file?: File; src?: string; objectRef?: string } => {
      if (s.attachment.type !== "image") return {};
      if (s.attachment.file) return { file: s.attachment.file };
      const src = s.attachment.content?.filter((c) => c.type === "image")[0]
        ?.image;
      if (src) return { src };
      const filePart = s.attachment.content?.find((candidate) => candidate.type === "file");
      return filePart?.type === "file" ? { objectRef: filePart.data } : {};
    }),
  );
  const storageUrl = useStorageObjectUrl(objectRef, "inline");

  return useFileSrc(file) ?? src ?? storageUrl;
};
