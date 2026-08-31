"use client";

import {
  type Attachment,
  type AttachmentAdapter,
  type CompleteAttachment,
  type PendingAttachment,
} from "@assistant-ui/react";

/**
 * Science v3 的附件只持有 Storage Object 引用。完成上传后，稳定引用会
 * 留在 CompleteAttachment 内；消息提交失败时 assistant-ui 可把同一个附件
 * 恢复到 composer，不会出现上传成功却被旧 Pi 注册步骤吞掉的情况。
 */
const apiFetch = (url: string, options: RequestInit): Promise<Response> =>
  fetch(url, { ...options, headers: { "content-type": "application/json" } });

const newAttachmentId = (): string => {
  // The Pi attachment manifest and its database row use UUIDs. Modern
  // browsers expose crypto.randomUUID; the small fallback keeps local test
  // environments deterministic without reverting to a short UI-only id.
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export class UnifiedAttachmentAdapter implements AttachmentAdapter {
  // assistant-ui 以 "*" 表示不给原生 file input 设 accept。
  // "*/*" 会被原样写入 input.accept，在部分浏览器中会过滤掉所有文件。
  accept = "*";
  async add(state: { file: File }): Promise<PendingAttachment> {
    const isImage = state.file.type.startsWith("image/");
    return {
      id: newAttachmentId(),
      type: isImage ? "image" : "document",
      name: state.file.name,
      contentType: state.file.type,
      file: state.file,
      status: { type: "requires-action", reason: "composer-send" },
    } as PendingAttachment;
  }

  async remove(_attachment: Attachment): Promise<void> {}

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const file = attachment.file;
    const objectId = await this.uploadObject(file);
    return {
      ...attachment,
      status: { type: "complete" },
      content: [{
        type: "file",
        data: `storage-object:${objectId}`,
        mimeType: file.type || "application/octet-stream",
        filename: file.name,
        sourceType: "id",
      }],
    } as CompleteAttachment;
  }

  private async uploadObject(file: File): Promise<string> {
    const init = await apiFetch("/api/storage/objects/init", {
      method: "POST",
      body: JSON.stringify({
        purpose: "thread",
        original_name: file.name,
        mime_type: file.type || "application/octet-stream",
        byte_size: file.size,
      }),
    });
    if (!init.ok) throw new Error(`storage initialization failed: ${init.status}`);
    const descriptor = await init.json() as { object_id?: unknown; upload_url?: unknown };
    if (typeof descriptor.object_id !== "string" || typeof descriptor.upload_url !== "string") throw new Error("storage returned an invalid upload descriptor");
    const put = await fetch(descriptor.upload_url, {
      method: "PUT",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
    });
    if (!put.ok) throw new Error(`direct object upload failed: ${put.status}`);
    const complete = await apiFetch(`/api/storage/objects/${encodeURIComponent(descriptor.object_id)}/complete`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    if (!complete.ok) throw new Error(`storage verification failed: ${complete.status}`);
    return descriptor.object_id;
  }

}
