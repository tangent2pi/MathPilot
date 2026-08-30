/** Pi 插件式结构化出口；不修改 Pi 本体。 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readHostPrincipal } from "./lib/host-principal.ts";
import { validateContentRespond } from "./lib/content-result-validation.ts";

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
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      const principal = params.result_file || params.validation_file
        ? await readHostPrincipal(context.cwd)
        : undefined;
      if (principal && !principal.roles.some((role) => ["teacher", "content_reviewer", "tenant_admin"].includes(role))) {
        throw new Error("KTQ/ER content respond requires a teacher principal");
      }
      const validated = params.result_file || params.validation_file
        ? await validateContentRespond(context.cwd, params)
        : undefined;
      const content = validated
        ? JSON.stringify({
            schema: "mathpilot.content-respond/v1",
            kind: validated.kind,
            itemCount: validated.itemCount,
            resultFile: validated.resultFile,
            validationFile: validated.validationFile,
            sha256: validated.sha256,
          })
        : "responded";
      return {
        content: [{ type: "text", text: content }],
        details: validated ?? params,
        terminate: true,
      };
    },
  });
};
