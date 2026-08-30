/**
 * MathPilot 教学 UI 工具协议。
 *
 * 工具由 Pi 正常调用并进入原生转录；浏览器只用 assistant-ui Toolkit
 * 按工具名提供领域渲染器。这里不修改 Pi，也不把前端工具定义反向注入 runtime。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const responsePolicy = Type.Object({
  required: Type.Literal(false),
  allow_skip: Type.Literal(true),
  allow_free_text_without_answer: Type.Literal(true),
});

const artifactId = Type.String({ pattern: "^art_[A-Za-z0-9]{8,92}$" });
const cardId = Type.String({ pattern: "^card_[A-Za-z0-9]+$" });

const option = Type.Object({
  id: Type.String(),
  content: Type.String(),
});

const blank = Type.Object({
  name: Type.String(),
  expected_format: Type.Optional(Type.Union([
    Type.Literal("number"),
    Type.Literal("expression"),
    Type.Literal("text"),
  ])),
});

export default async (pi: ExtensionAPI) => {
  pi.registerTool({
    name: "present_question_card",
    label: "Question card",
    description:
      "在对话中展示一张非阻塞教学题卡。artifact_id 必须是 art_ 加至少 8 位字母数字，card_id 必须是 card_ 加字母数字；不得使用 demo、虚构或其他格式的标识。卡片只收集学生回答，不能自行宣告判定；required 必须为 false，且必须允许跳过和改用文字回复。",
    parameters: Type.Object({
      schema: Type.Literal("mathpilot.question-card/v1"),
      artifact_id: artifactId,
      card_id: cardId,
      type: Type.Union([
        Type.Literal("single_choice"),
        Type.Literal("multiple_choice"),
        Type.Literal("fill_blank"),
        Type.Literal("true_false"),
        Type.Literal("short_answer"),
      ]),
      prompt: Type.String(),
      options: Type.Optional(Type.Array(option)),
      blanks: Type.Optional(Type.Array(blank)),
      answer_hint: Type.Optional(Type.String()),
      response_policy: responsePolicy,
      evidence_policy: Type.Union([
        Type.Literal("teaching_only"),
        Type.Literal("eligible_if_independent"),
      ]),
      source_refs: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: `已展示题卡 ${params.card_id}，学生可作答、跳过或改用普通消息回复。` }],
        details: params,
      };
    },
  });

  pi.registerTool({
    name: "present_learning_artifact",
    label: "Learning artifact",
    description:
      "引用 output/artifacts/<artifact_id>/ 中已经完成构建并通过 Skill 校验、等待 MathPilot ArtifactPublisher 发布的教学产物。artifact_id 必须是 art_ 加至少 8 位字母数字；不得引用 demo、虚构或不存在的产物，也不得写入 .agent、传工作区路径、file:// 或外部临时 URL。",
    parameters: Type.Object({
      schema: Type.Literal("mathpilot.learning-artifact/v1"),
      artifact_id: artifactId,
      title: Type.String(),
      kind: Type.Union([
        Type.Literal("knowledge_visualization"),
        Type.Literal("question_card"),
        Type.Literal("mixed_lesson"),
      ]),
      renderer: Type.Union([
        Type.Literal("native_card"),
        Type.Literal("sandboxed_html"),
        Type.Literal("media"),
      ]),
      entry: Type.String({ pattern: "^(index\\.html|card\\.json|media/[A-Za-z0-9._-]+)$" }),
      version: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      const root = path.join(context.cwd, "output", "artifacts", params.artifact_id);
      const manifestPath = path.join(root, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
      if (
        manifest.schema !== params.schema
        || manifest.artifact_id !== params.artifact_id
        || manifest.title !== params.title
        || manifest.kind !== params.kind
        || manifest.renderer !== params.renderer
        || manifest.entry !== params.entry
      ) throw new Error("artifact manifest does not match present_learning_artifact arguments");
      const entry = path.resolve(root, params.entry);
      if (!entry.startsWith(`${path.resolve(root)}${path.sep}`) || !(await stat(entry)).isFile()) {
        throw new Error("artifact entry does not exist in the candidate directory");
      }
      return {
        content: [{ type: "text", text: `已提交教学产物 ${params.artifact_id} 的发布引用；宿主将从候选目录独立校验并发布。` }],
        details: params,
      };
    },
  });
};
