const TOOL_IMAGE_MESSAGE = "Attached image(s) from tool result:";

export const DEFAULT_TOOL_IMAGE_LIMITS = {
  maxImages: 4,
  maxDataUrlChars: 1_500_000,
} as const;

export interface MultimodalPayloadResult {
  payload: unknown;
  changed: boolean;
  keptToolImages: number;
  omittedToolImages: number;
  keptDataUrlChars: number;
}

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const imageUrl = (part: unknown): string | null => {
  if (!isObject(part) || part.type !== "image_url" || !isObject(part.image_url)) return null;
  return typeof part.image_url.url === "string" ? part.image_url.url : null;
};

const isToolImageMessage = (message: unknown): message is JsonObject & { content: unknown[] } =>
  isObject(message)
  && message.role === "user"
  && Array.isArray(message.content)
  && message.content.some((part) => isObject(part) && part.type === "text" && part.text === TOOL_IMAGE_MESSAGE);

/** Keep recent tool previews bounded without touching the user's original images. */
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
      if (remainingImages > 0 && url.length <= remainingChars) {
        keptParts.add(partIndex);
        remainingImages--;
        remainingChars -= url.length;
        keptToolImages++;
        messageKept++;
        keptDataUrlChars += url.length;
      }
    }

    const messageOmitted = messageImages - messageKept;
    if (messageOmitted === 0) continue;
    omittedToolImages += messageOmitted;
    changed = true;
    const content = message.content.filter((part, partIndex) => imageUrl(part) === null || keptParts.has(partIndex));
    content.push({
      type: "text",
      text: `Runtime image budget: kept ${messageKept} preview(s) from this result and omitted ${messageOmitted}. `
        + "Request only the next needed range of at most 4 pages; rely on the retained tool/OCR text for other pages.",
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
