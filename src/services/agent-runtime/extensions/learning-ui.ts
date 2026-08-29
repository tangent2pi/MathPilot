/**
 * MathPilot 教学 UI 工具协议。
 *
 * 工具由 Pi 正常调用并进入原生转录；浏览器只用 assistant-ui Toolkit
 * 按工具名提供领域渲染器。这里不修改 Pi，也不把前端工具定义反向注入 runtime。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const responsePolicy = Type.Object({
  required: Type.Literal(false),
  allow_skip: Type.Literal(true),
  allow_free_text_without_answer: Type.Literal(true),
});

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

const teachingUiNode = Type.Cyclic({
  Node: Type.Union([
    Type.String(),
    Type.Number(),
    Type.Object({
    $type: Type.Union([
      Type.Literal("Card"), Type.Literal("Col"), Type.Literal("Row"),
      Type.Literal("Header"), Type.Literal("Text"), Type.Literal("Caption"),
      Type.Literal("Markdown"), Type.Literal("Fact"), Type.Literal("Badge"),
      Type.Literal("Alert"), Type.Literal("Divider"),
    ]),
    children: Type.Optional(Type.Array(Type.Ref("Node"))),
    title: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    text: Type.Optional(Type.String()),
    value: Type.Optional(Type.String()),
    label: Type.Optional(Type.String()),
    padding: Type.Optional(Type.Integer({ minimum: 0, maximum: 8 })),
    gap: Type.Optional(Type.Integer({ minimum: 0, maximum: 8 })),
    align: Type.Optional(Type.Union([Type.Literal("start"), Type.Literal("center"), Type.Literal("end")])),
    justify: Type.Optional(Type.Union([Type.Literal("start"), Type.Literal("center"), Type.Literal("end"), Type.Literal("between")])),
    size: Type.Optional(Type.Union([Type.Literal("sm"), Type.Literal("md"), Type.Literal("lg"), Type.Literal("xl"), Type.Literal("2xl"), Type.Literal("3xl")])),
    weight: Type.Optional(Type.Union([Type.Literal("normal"), Type.Literal("medium"), Type.Literal("semibold"), Type.Literal("bold")])),
    color: Type.Optional(Type.Union([Type.Literal("emphasis"), Type.Literal("secondary"), Type.Literal("alpha-70")])),
    tone: Type.Optional(Type.Union([Type.Literal("info"), Type.Literal("success"), Type.Literal("warning"), Type.Literal("danger")])),
    variant: Type.Optional(Type.String()),
    flush: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
  ]),
}, "Node");

export default async (pi: ExtensionAPI) => {
  pi.registerTool({
    name: "present_teaching_ui",
    label: "Teaching UI",
    description:
      "用受限的 assistant-ui Generative UI 组件展示教学过程、概念对比、步骤结构或提醒。只负责解释性展示；需要学生作答时必须改用 present_question_card。不要用它承载判答结论、后台任务或任意 HTML。",
    parameters: Type.Object({
      schema: Type.Literal("mathpilot.teaching-ui/v1"),
      ui: teachingUiNode,
    }),
    async execute() {
      return {
        content: [{ type: "text", text: "已展示结构化教学内容。" }],
        details: { renderer: "assistant-ui-generative-ui" },
      };
    },
  });

  pi.registerTool({
    name: "present_question_card",
    label: "Question card",
    description:
      "在对话中展示一张非阻塞教学题卡。可用于会话开场题面，也可用于教学过程中的追问。卡片只收集学生回答，不能自行宣告判定；required 必须为 false，且必须允许跳过和改用文字回复。",
    parameters: Type.Object({
      schema: Type.Literal("mathpilot.question-card/v1"),
      artifact_id: Type.String(),
      card_id: Type.String(),
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
      "引用一个已经由 MathPilot ArtifactPublisher 校验并发布的教学产物。不得传工作区路径、file:// 或外部临时 URL。",
    parameters: Type.Object({
      schema: Type.Literal("mathpilot.learning-artifact/v1"),
      artifact_id: Type.String(),
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
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: `已引用教学产物 ${params.artifact_id}。` }],
        details: params,
      };
    },
  });
};
