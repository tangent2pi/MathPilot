/** Pi 插件式结构化出口；不修改 Pi 本体。 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default async (pi: ExtensionAPI) => {
  pi.registerTool({
    name: "respond",
    label: "Respond",
    description:
      "提交最终结果。KTQ/ER 必须引用已经由对应 Skill 验证的工作区文件；其他任务可使用 output。",
    parameters: Type.Object({
      output: Type.Optional(Type.Unknown()),
      result_file: Type.Optional(Type.String()),
      validation_file: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: "responded" }],
        details: params,
        terminate: true,
      };
    },
  });
};
