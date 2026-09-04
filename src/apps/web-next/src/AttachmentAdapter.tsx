"use client";

import {
  type Attachment,
  type AttachmentAdapter,
  type CompleteAttachment,
  type PendingAttachment,
} from "@assistant-ui/react";
import type { ImmutableObjectDescriptor, UploadPurpose } from "@mathpilot/content-integrity";
import {
  deleteStorageObject,
  mathpilotObjectMetadata,
  storageUploadDeclaration,
  storageUploadFileTypes,
  uploadStorageObject,
} from "./storage-upload";

/**
 * Science v3 的附件只持有 Storage Object 引用。完成上传后，稳定引用会
 * 留在 CompleteAttachment 内；消息提交失败时 assistant-ui 可把同一个附件
 * 恢复到 composer，不会出现上传成功却被旧 Pi 注册步骤吞掉的情况。
 */
const newAttachmentId = (): string => globalThis.crypto.randomUUID();

type AttachmentStorage = {
  upload: (
    file: File,
    purpose: UploadPurpose,
    options?: { signal?: AbortSignal; onProgress?: (progress: number) => void },
  ) => Promise<ImmutableObjectDescriptor>;
  remove: (objectId: string) => Promise<void>;
};

type InFlightUpload = {
  kind: "in-flight";
  file: File;
  controller: AbortController;
  promise: Promise<ImmutableObjectDescriptor>;
};

type CompletedUpload = {
  kind: "complete";
  file: File;
  descriptor: ImmutableObjectDescriptor;
};

type UploadState = InFlightUpload | CompletedUpload;

/**
 * The Pi gateway receives immutable storage descriptors, never browser file
 * bytes or an opaque UI-only attachment id.  `attachment_id` remains useful
 * for projecting the materialized workspace file back onto the user turn.
 */
export type PiTurnAttachment = ImmutableObjectDescriptor & {
  attachment_id: string;
};

const defaultStorage: AttachmentStorage = {
  upload: uploadStorageObject,
  remove: deleteStorageObject,
};

const imageDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(new Error("读取图片失败"));
  reader.onload = () => resolve(String(reader.result));
  reader.readAsDataURL(file);
});

export class UnifiedAttachmentAdapter implements AttachmentAdapter {
  private readonly uploads = new Map<string, UploadState>();
  private readonly claimedPiUploads = new Map<string, CompletedUpload>();

  constructor(private readonly storage: AttachmentStorage = defaultStorage) {}

  accept = storageUploadFileTypes("thread").join(",");
  async add(state: { file: File }): Promise<PendingAttachment> {
    const declaration = storageUploadDeclaration(state.file, "thread");
    const isImage = declaration.mime_type.startsWith("image/");
    return {
      id: newAttachmentId(),
      type: isImage ? "image" : "document",
      name: state.file.name,
      contentType: declaration.mime_type,
      file: state.file,
      status: { type: "requires-action", reason: "composer-send" },
    } as PendingAttachment;
  }

  async remove(attachment: Attachment): Promise<void> {
    const upload = this.uploads.get(attachment.id);
    if (upload?.kind === "in-flight") {
      upload.controller.abort();
      const descriptor = await upload.promise.catch(() => undefined);
      if (descriptor) {
        await this.storage.remove(descriptor.object_id);
        if (this.uploads.get(attachment.id)?.kind === "complete") {
          this.uploads.delete(attachment.id);
        }
      }
      return;
    }
    if (upload?.kind === "complete") {
      await this.storage.remove(upload.descriptor.object_id);
      if (this.uploads.get(attachment.id) === upload) this.uploads.delete(attachment.id);
      return;
    }
    const claimed = this.claimedPiUploads.get(attachment.id);
    if (claimed) {
      await this.storage.remove(claimed.descriptor.object_id);
      if (this.claimedPiUploads.get(attachment.id) === claimed) {
        this.claimedPiUploads.delete(attachment.id);
      }
      return;
    }
    const file = attachment.content?.find((part) => part.type === "file");
    const descriptor = file?.type === "file"
      ? mathpilotObjectMetadata(file.providerMetadata?.mathpilot)
      : undefined;
    if (descriptor) await this.storage.remove(descriptor.object_id);
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const descriptor = await this.upload(attachment);
    const filePart = {
      type: "file" as const,
      data: descriptor.object_ref,
      mimeType: descriptor.mime_type,
      filename: descriptor.original_name,
      sourceType: "id" as const,
      providerMetadata: { mathpilot: descriptor },
    };
    const imagePart = attachment.type === "image"
      ? [{ type: "image" as const, image: await imageDataUrl(attachment.file), filename: descriptor.original_name }]
      : [];
    return {
      ...attachment,
      status: { type: "complete" },
      // Keep the immutable file reference for the canonical ledger and the
      // standard image part for react-pi's native visual input.
      content: [filePart, ...imagePart],
    } as CompleteAttachment;
  }

  /** A command receipt transfers lifecycle ownership to the canonical message. */
  markCommitted(attachments: readonly CompleteAttachment[]): void {
    for (const attachment of attachments) {
      if (this.uploads.get(attachment.id)?.kind === "complete") this.uploads.delete(attachment.id);
    }
  }

  /**
   * Atomically reserves the completed objects for one Pi gateway message.
   * A transport failure can restore the exact same immutable references, so a
   * retry does not upload a second object or accidentally attach it to a later
   * text-only turn.
   */
  claimForPiTurn(): readonly PiTurnAttachment[] {
    const claimed: PiTurnAttachment[] = [];
    for (const [attachmentId, upload] of this.uploads) {
      if (upload.kind !== "complete") continue;
      this.uploads.delete(attachmentId);
      this.claimedPiUploads.set(attachmentId, upload);
      claimed.push({ ...upload.descriptor, attachment_id: attachmentId });
    }
    return claimed;
  }

  /** Return an unaccepted Pi gateway claim to the next retry of this turn. */
  restorePiTurn(attachments: readonly PiTurnAttachment[]): void {
    for (const attachment of attachments) {
      const claimed = this.claimedPiUploads.get(attachment.attachment_id);
      if (!claimed) continue;
      this.claimedPiUploads.delete(attachment.attachment_id);
      if (!this.uploads.has(attachment.attachment_id)) {
        this.uploads.set(attachment.attachment_id, claimed);
      }
    }
  }

  /** The Pi gateway accepted ownership; the canonical receipt now owns it. */
  markPiTurnAccepted(attachments: readonly PiTurnAttachment[]): void {
    for (const attachment of attachments) {
      this.claimedPiUploads.delete(attachment.attachment_id);
    }
  }

  private async upload(attachment: PendingAttachment): Promise<ImmutableObjectDescriptor> {
    const existing = this.uploads.get(attachment.id);
    if (existing) {
      if (existing.file !== attachment.file) throw new Error("附件标识已用于其他文件");
      return existing.kind === "complete" ? existing.descriptor : existing.promise;
    }

    const controller = new AbortController();
    let inFlight: InFlightUpload;
    const promise = this.storage.upload(attachment.file, "thread", { signal: controller.signal })
      .then((descriptor) => {
        if (this.uploads.get(attachment.id) === inFlight) {
          this.uploads.set(attachment.id, { kind: "complete", file: attachment.file, descriptor });
        }
        return descriptor;
      })
      .catch((error: unknown) => {
        if (this.uploads.get(attachment.id) === inFlight) this.uploads.delete(attachment.id);
        throw error;
      });
    inFlight = { kind: "in-flight", file: attachment.file, controller, promise };
    this.uploads.set(attachment.id, inFlight);
    return promise;
  }
}
