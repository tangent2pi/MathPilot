"use client";

import {
  contentPolicy,
  declaredMimeTypeSchema,
  immutableObjectDescriptorSchema,
  storagePublicationRequestSchema,
  type ImmutableObjectDescriptor,
  type StoragePublicationRequest,
  type UploadPurpose,
} from "@mathpilot/content-integrity";
import { publishStorageObject } from "@mathpilot/content-integrity/publication";
import Uppy from "@uppy/core";
import AwsS3 from "@uppy/aws-s3";
import mime from "mime/lite";
import { responseProblem } from "./lib/http-problem";

const jsonHeaders = { "content-type": "application/json" } as const;

const byteLimit = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1)} MiB`;

/** Browser-only Uppy adapter; the shared package retains only domain policy. */
export function storageUploadFileTypes(purpose: UploadPurpose): readonly string[] {
  return contentPolicy(purpose).allowedMimeTypes;
}

export function storageUploadMimeType(file: File, purpose: UploadPurpose): string | undefined {
  const browserType = file.type.trim().toLowerCase();
  const candidate = !browserType || browserType === "application/octet-stream"
    ? mime.getType(file.name)
    : browserType;
  const parsed = declaredMimeTypeSchema.safeParse(candidate || undefined);
  if (!parsed.success) return undefined;
  return contentPolicy(purpose).allowedMimeTypes.includes(parsed.data) ? parsed.data : undefined;
}

export function storageUploadDeclaration(file: File, purpose: UploadPurpose): StoragePublicationRequest {
  const policy = contentPolicy(purpose);
  if (file.size < 1) throw new Error("文件不能为空");
  if (file.size > policy.maximumSourceBytes) {
    throw new Error(`文件不能超过 ${byteLimit(policy.maximumSourceBytes)}`);
  }
  const mimeType = storageUploadMimeType(file, purpose);
  if (!mimeType) throw new Error("不支持这种文件类型");
  return storagePublicationRequestSchema.parse({
    purpose,
    original_name: file.name,
    mime_type: mimeType,
    byte_size: file.size,
  });
}

export function storageUploadRestrictions(purpose: UploadPurpose) {
  const policy = contentPolicy(purpose);
  return {
    maxNumberOfFiles: 1,
    maxFileSize: policy.maximumSourceBytes,
    allowedFileTypes: Array.from(storageUploadFileTypes(purpose)),
  };
}

/** Keep cancellation semantics at the Uppy boundary instead of duplicating an upload state machine. */
export async function runUppyObjectUpload(
  uppy: Uppy,
  file: File,
  mimeType: string,
  signal: AbortSignal,
  onProgress?: (progress: number) => void,
): Promise<void> {
  signal.throwIfAborted();
  const abort = () => uppy.cancelAll();
  if (signal.aborted) abort(); else signal.addEventListener("abort",abort,{ once:true });
  uppy.on("upload-progress",(_file,progress) => {
    if (progress.bytesTotal) onProgress?.(progress.bytesUploaded/progress.bytesTotal);
  });
  try {
    // Abort may race listener installation. Re-check before a file can enter
    // Uppy so cancelAll on an empty queue cannot be followed by a new upload.
    signal.throwIfAborted();
    uppy.addFile({ name:file.name,type:mimeType,data:file,source:"mathpilot-browser" });
    try {
      const result = await uppy.upload();
      // Uppy may represent cancellation as a generic failed upload. The
      // caller's AbortSignal remains the cancellation authority.
      signal.throwIfAborted();
      const failed = result?.failed ?? [];
      const successful = result?.successful ?? [];
      if (failed.length>0 || successful.length!==1) {
        throw failed[0]?.error ?? new Error("direct object upload failed");
      }
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    }
  } finally {
    signal.removeEventListener("abort",abort);
    uppy.destroy();
  }
}

export async function uploadStorageObject(
  file: File,
  purpose: UploadPurpose,
  options: { signal?: AbortSignal; onProgress?: (progress: number) => void } = {},
): Promise<ImmutableObjectDescriptor> {
  const declaration = storageUploadDeclaration(file, purpose);
  return publishStorageObject({
    request: declaration,
    signal: options.signal,
    adapter: {
      async initialize(request,signal) {
        const response = await fetch("/api/storage/objects/init", {
          method:"POST",headers:jsonHeaders,signal,body:JSON.stringify(request),
        });
        if (!response.ok) throw await responseProblem(response,"storage initialization failed");
        return response.json();
      },
      async upload(descriptor,signal) {
        const uppy = new Uppy({
          autoProceed:false,
          restrictions:storageUploadRestrictions(purpose),
        });
        uppy.use(AwsS3,{
          shouldUseMultipart:false,
          retryDelays:[0,1_000,3_000],
          getUploadParameters:() => ({
            method:"POST",url:descriptor.upload.url,fields:descriptor.upload.fields,
            expires:Math.max(1,Math.floor((Date.parse(descriptor.expires_at)-Date.now())/1_000)),
            headers:{},
          }),
        });
        await runUppyObjectUpload(uppy,file,declaration.mime_type,signal,options.onProgress);
      },
      async complete(objectId,signal) {
        const response = await fetch(`/api/storage/objects/${encodeURIComponent(objectId)}/complete`,{
          method:"POST",headers:jsonHeaders,body:"{}",signal,
        });
        if (!response.ok) throw await responseProblem(response,"storage verification failed");
        return response.json();
      },
      async removeUnclaimed(objectId,signal) {
        await deleteStorageObject(objectId,{ signal });
      },
    },
  });
}

export async function deleteStorageObject(
  objectId: string,
  options: { signal?: AbortSignal; fetcher?: typeof fetch } = {},
): Promise<void> {
  const response = await (options.fetcher ?? fetch)(
    `/api/storage/objects/${encodeURIComponent(objectId)}`,
    options.signal ? { method:"DELETE",signal:options.signal } : { method:"DELETE" },
  );
  if (response.status===404 || response.status===410) {
    await response.body?.cancel().catch(() => undefined);
    return;
  }
  if (!response.ok) {
    throw await responseProblem(response,"storage object removal failed");
  }
}

export const mathpilotObjectMetadata = (value: unknown): ImmutableObjectDescriptor | undefined => {
  const parsed = immutableObjectDescriptorSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};
