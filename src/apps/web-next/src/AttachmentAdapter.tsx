"use client";

import {
  type AttachmentAdapter,
  type CompleteAttachment,
  type PendingAttachment,
} from "@assistant-ui/react";

/**
 * 统一附件适配器：图片与文件同一入口，落盘工作区 input/original/（只读区），
 * 由模型自行决定用什么工具阅读。
 *
 * - 图片：image part（Pi 视觉输入，回合内直接可见）+ 服务端落盘
 * - 文件：file part（前端展示）+ 服务端落盘；Pi 扩展按本轮注入隐藏文件上下文
 *
 * TODO(数据分析 skills)：教模型读取 word/excel/pdf 等格式的工具与流程。
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

const toDataUrl = (file: File): Promise<string> =>
  typeof FileReader === "undefined"
    ? file.arrayBuffer().then((buffer) => {
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        return `data:${file.type || "application/octet-stream"};base64,${btoa(binary)}`;
      })
    : new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("read file failed"));
        reader.onload = () => resolve(String(reader.result));
        reader.readAsDataURL(file);
      });

type ReadyUpload = {
  attachment: PendingAttachment;
  objectId: string;
};

type UploadedAttachment = {
  id: string;
  path: string;
  mimeType: string;
};

export class UnifiedAttachmentAdapter implements AttachmentAdapter {
  // assistant-ui 以 "*" 表示不给原生 file input 设 accept。
  // "*/*" 会被原样写入 input.accept，在部分浏览器中会过滤掉所有文件。
  accept = "*";
  private readonly readyUploads = new Map<string, ReadyUpload>();

  /**
   * AttachmentAdapter.send 已完成对象上传与校验；react-pi 随后按官方流程
   * initialize 远端线程，再由 PiRuntimeProvider 用真实 threadId 完成关联。
   */
  async flushToThread(threadId: string): Promise<UploadedAttachment[]> {
    const uploads = [...this.readyUploads.entries()];
    if (uploads.length === 0) return [];
    for (const [id] of uploads) this.readyUploads.delete(id);
    // A failed registration must not leave an invisible attachment queued:
    // otherwise every later text-only send retries the same stale upload.
    return Promise.all(uploads.map(([, upload]) => this.register(threadId, upload)));
  }

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

  async remove(attachment: PendingAttachment): Promise<void> {
    this.readyUploads.delete(attachment.id);
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const file = attachment.file;
    // Upload and verify before assistant-ui clears the composer attachment.
    // Only the final thread association waits for the remote Pi thread id.
    const objectId = await this.uploadObject(file);
    this.readyUploads.set(attachment.id, { attachment, objectId });

    if (attachment.type === "image") {
      // 图片：保留 Pi 视觉输入（回合内直接可见）。
      const dataUrl = await toDataUrl(file);
      return {
        ...attachment,
        status: { type: "complete" },
        content: [{ type: "image", image: dataUrl }],
      } as CompleteAttachment;
    }
    // 文件：前端展示 file part；模型经 before_agent_start 的隐藏消息感知。
    return {
      ...attachment,
      status: { type: "complete" },
      content: [{
        type: "file",
        data: attachment.id,
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

  private async register(threadId: string, upload: ReadyUpload): Promise<UploadedAttachment> {
    const res = await apiFetch(`/api/pi/threads/${encodeURIComponent(threadId)}/files/from-object`, {
      method: "POST",
      body: JSON.stringify({ object_id: upload.objectId, attachment_id: upload.attachment.id }),
    });
    if (!res.ok) throw new Error(`thread attachment registration failed: ${res.status}`);
    return await res.json() as UploadedAttachment;
  }
}
