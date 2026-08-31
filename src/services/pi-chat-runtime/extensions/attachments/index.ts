/** Per-turn file context for Pi, injected through the official extension hook. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ATTACHMENT_CONTEXT_TYPE, findAttachmentTurn } from "./manifest.ts";

type AttachmentDetails = { version?: unknown; turnId?: unknown };

export default async (pi: ExtensionAPI) => {
  pi.on("before_agent_start", async (event, ctx) => {
    const announcedTurnIds = new Set<string>();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom_message" || entry.customType !== ATTACHMENT_CONTEXT_TYPE) continue;
      const details = entry.details as AttachmentDetails | undefined;
      if (details?.version === 1 && typeof details.turnId === "string") announcedTurnIds.add(details.turnId);
    }

    const match = await findAttachmentTurn(ctx.cwd, event.prompt, announcedTurnIds);
    if (!match) return;

    const content = [
      "本轮用户上传了以下文件。文件已由宿主完成权限校验并放入当前线程工作区；需要读取时仅使用所列相对路径：",
      ...match.attachments.map((file) =>
        `- ${file.workspacePath}（对象：${file.storageObjectId}；版本：${file.versionId}；SHA-256：${file.sha256}；MIME：${file.mimeType}；${file.byteSize} bytes）`,
      ),
    ].join("\n");

    return {
      message: {
        customType: ATTACHMENT_CONTEXT_TYPE,
        content,
        display: false,
        details: {
          version: 1,
          turnId: match.turn.id,
          attachments: match.attachments,
        },
      },
    };
  });
};
