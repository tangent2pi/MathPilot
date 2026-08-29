"use client";

import {
  generateId,
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

type PendingUpload = {
  attachment: PendingAttachment;
  base64: string;
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
  private readonly readyUploads = new Map<string, PendingUpload>();

  /**
   * AttachmentAdapter.send 只负责把本次发送涉及的附件标记为就绪。
   * react-pi 随后会按官方流程 initialize 远端线程，再以真实 threadId 调用
   * PiClient.sendMessage；PiRuntimeProvider 在那个调用点先上传，再发送消息。
   */
  async flushToThread(threadId: string): Promise<UploadedAttachment[]> {
    const uploads = [...this.readyUploads.entries()];
    if (uploads.length === 0) return [];
    for (const [id] of uploads) this.readyUploads.delete(id);
    try {
      return await Promise.all(uploads.map(([, upload]) => this.upload(threadId, upload)));
    } catch (error) {
      for (const [id, upload] of uploads) this.readyUploads.set(id, upload);
      throw error;
    }
  }

  async add(state: { file: File }): Promise<PendingAttachment> {
    const isImage = state.file.type.startsWith("image/");
    return {
      id: generateId(),
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
    const dataUrl = await toDataUrl(file);
    const base64 = dataUrl.split(",")[1] ?? "";
    const upload = { attachment, base64 };

    // 这里不猜线程状态。真正的 remote threadId 只由 PiClient.sendMessage 提供。
    this.readyUploads.set(attachment.id, upload);

    if (attachment.type === "image") {
      // 图片：保留 Pi 视觉输入（回合内直接可见）。
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
        data: dataUrl,
        mimeType: file.type || "application/octet-stream",
        filename: file.name,
      }],
    } as CompleteAttachment;
  }

  private async upload(threadId: string, upload: PendingUpload): Promise<UploadedAttachment> {
    const file = upload.attachment.file;
    const res = await apiFetch(`/api/pi/threads/${encodeURIComponent(threadId)}/files`, {
      method: "POST",
      body: JSON.stringify({ name: file.name, mimeType: file.type, data: upload.base64 }),
    });
    if (!res.ok) throw new Error(`upload failed: ${res.status}`);
    return await res.json() as UploadedAttachment;
  }
}
