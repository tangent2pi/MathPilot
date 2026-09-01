"use client";

import {
  immutableObjectDescriptorSchema,
  type ImmutableObjectDescriptor,
  type UploadPurpose,
} from "@mathpilot/content-integrity";
import { publishStorageObject } from "@mathpilot/content-integrity/publication";
import Uppy from "@uppy/core";
import AwsS3 from "@uppy/aws-s3";

const jsonHeaders = { "content-type": "application/json" } as const;

const responseError = async (response: Response, fallback: string): Promise<Error> => {
  const body = await response.json().catch(() => ({})) as { error?: unknown };
  return new Error(typeof body.error === "string" ? body.error : `${fallback} (${response.status})`);
};

export async function uploadStorageObject(
  file: File,
  purpose: UploadPurpose,
  options: { signal?: AbortSignal; onProgress?: (progress: number) => void } = {},
): Promise<ImmutableObjectDescriptor> {
  return publishStorageObject({
    request: { purpose,original_name:file.name,mime_type:file.type,byte_size:file.size },
    signal: options.signal,
    adapter: {
      async initialize(request,signal) {
        const response = await fetch("/api/storage/objects/init", {
          method:"POST",headers:jsonHeaders,signal,body:JSON.stringify(request),
        });
        if (!response.ok) throw await responseError(response,"storage initialization failed");
        return response.json();
      },
      async upload(descriptor,signal) {
        signal.throwIfAborted();
        const uppy = new Uppy({ autoProceed:false,restrictions:{ maxNumberOfFiles:1,maxFileSize:file.size } });
        uppy.use(AwsS3,{
          shouldUseMultipart:false,
          retryDelays:[0,1_000,3_000],
          getUploadParameters:() => ({
            method:"POST",url:descriptor.upload.url,fields:descriptor.upload.fields,
            expires:Math.max(1,Math.floor((Date.parse(descriptor.expires_at)-Date.now())/1_000)),
            headers:{},
          }),
        });
        const abort = () => uppy.cancelAll();
        if (signal.aborted) abort(); else signal.addEventListener("abort",abort,{ once:true });
        uppy.on("upload-progress",(_file,progress) => {
          if (progress.bytesTotal) options.onProgress?.(progress.bytesUploaded/progress.bytesTotal);
        });
        try {
          uppy.addFile({ name:file.name,type:file.type,data:file,source:"mathpilot-browser" });
          const result = await uppy.upload();
          const failed = result?.failed ?? [];
          const successful = result?.successful ?? [];
          if (failed.length>0 || successful.length!==1) {
            throw failed[0]?.error ?? new Error("direct object upload failed");
          }
        } finally {
          signal.removeEventListener("abort",abort);
          uppy.destroy();
        }
      },
      async complete(objectId,signal) {
        const response = await fetch(`/api/storage/objects/${encodeURIComponent(objectId)}/complete`,{
          method:"POST",headers:jsonHeaders,body:"{}",signal,
        });
        if (!response.ok) throw await responseError(response,"storage verification failed");
        return response.json();
      },
      async removeUnclaimed(objectId,signal) {
        await fetch(`/api/storage/objects/${encodeURIComponent(objectId)}`,{ method:"DELETE",signal });
      },
    },
  });
}

export async function deleteStorageObject(objectId: string): Promise<void> {
  const response = await fetch(`/api/storage/objects/${encodeURIComponent(objectId)}`,{ method:"DELETE" });
  if (!response.ok && response.status!==404 && response.status!==410) {
    throw await responseError(response,"storage object removal failed");
  }
}

export const mathpilotObjectMetadata = (value: unknown): ImmutableObjectDescriptor | undefined => {
  const parsed = immutableObjectDescriptorSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};
