const TOOL_IMAGE_MESSAGE = "Attached image(s) from tool result:";

export const DEFAULT_TOOL_IMAGE_LIMITS = {
  maxImages: 4,
  maxDataUrlChars: 1_500_000,
} as const;

export interface MultimodalPayloadStats {
  changed: boolean;
  keptToolImages: number;
  omittedToolImages: number;
  keptDataUrlChars: number;
}

export interface MultimodalPayloadResult extends MultimodalPayloadStats {
  payload: unknown;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function imageUrl(part: unknown): string | null {
  if (!isObject(part) || part.type !== "image_url" || !isObject(part.image_url)) return null;
  return typeof part.image_url.url === "string" ? part.image_url.url : null;
}

function isToolImageMessage(message: unknown): message is JsonObject & { content: unknown[] } {
  if (!isObject(message) || message.role !== "user" || !Array.isArray(message.content)) return false;
  return message.content.some((part) => isObject(part) && part.type === "text" && part.text === TOOL_IMAGE_MESSAGE);
}

/**
 * Pi 会把每次工具结果里的图片转换成额外 user message，并在后续模型调用中累计回放。
 * 这里仅治理这些合成消息；学生最初上传的图片以及 tool message 文本均保持原样。
 */
export function governMultimodalProviderPayload(
  payload: unknown,
  limits: { maxImages?: number; maxDataUrlChars?: number } = {},
): MultimodalPayloadResult {
  if (!isObject(payload) || !Array.isArray(payload.messages)) {
    return { payload, changed: false, keptToolImages: 0, omittedToolImages: 0, keptDataUrlChars: 0 };
  }

  const maxImages = Math.max(0, Math.floor(limits.maxImages ?? DEFAULT_TOOL_IMAGE_LIMITS.maxImages));
  const maxDataUrlChars = Math.max(0, Math.floor(limits.maxDataUrlChars ?? DEFAULT_TOOL_IMAGE_LIMITS.maxDataUrlChars));
  const messages = [...payload.messages];
  let remainingImages = maxImages;
  let remainingChars = maxDataUrlChars;
  let keptToolImages = 0;
  let omittedToolImages = 0;
  let keptDataUrlChars = 0;
  let changed = false;

  // 最新的工具视觉证据最接近当前推理步骤，因此从后向前分配总预算。
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = messages[messageIndex];
    if (!isToolImageMessage(message)) continue;

    const keptParts = new Set<number>();
    let messageImages = 0;
    let messageKept = 0;
    for (const [partIndex, part] of message.content.entries()) {
      const url = imageUrl(part);
      if (url === null) continue;
      messageImages++;
      const chars = url.length;
      if (remainingImages > 0 && chars <= remainingChars) {
        keptParts.add(partIndex);
        remainingImages--;
        remainingChars -= chars;
        keptToolImages++;
        messageKept++;
        keptDataUrlChars += chars;
      }
    }

    const messageOmitted = messageImages - messageKept;
    if (!messageOmitted) continue;
    omittedToolImages += messageOmitted;
    changed = true;
    const content = message.content.filter((part, partIndex) => imageUrl(part) === null || keptParts.has(partIndex));
    content.push({
      type: "text",
      text: `Runtime image budget: kept ${messageKept} preview(s) from this result and omitted ${messageOmitted}. `
        + "Use the tool again with a page range of at most 4 pages when the omitted visual evidence is needed; rely on the tool/OCR text for the remaining pages.",
    });
    messages[messageIndex] = { ...message, content };
  }

  return {
    payload: changed ? { ...payload, messages } : payload,
    changed,
    keptToolImages,
    omittedToolImages,
    keptDataUrlChars,
  };
}
