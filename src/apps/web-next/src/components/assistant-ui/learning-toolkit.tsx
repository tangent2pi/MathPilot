"use client";

import { defineToolkit, useAuiState } from "@assistant-ui/react";
import { ArtifactCard } from "@/components/assistant-ui/elements/artifact-card";
import { QuestionCard, type QuestionCardArgs } from "@/components/assistant-ui/question-card";
import { TeachingGenerativeUI } from "@/components/assistant-ui/teaching-generative-ui";

type ArtifactArgs = {
  artifact_id?: string;
  title?: string;
  kind?: "knowledge_visualization" | "question_card" | "mixed_lesson";
  renderer?: "native_card" | "sandboxed_html" | "media";
  entry?: string;
  version?: string;
};

export const learningToolkit = defineToolkit({
  present_question_card: {
    type: "backend",
    display: "standalone",
    render: ({ args, status, toolCallId }) => (
      <QuestionCard
        args={(args ?? {}) as QuestionCardArgs}
        running={status.type === "running"}
        toolCallId={toolCallId}
      />
    ),
  },
  present_learning_artifact: {
    type: "backend",
    display: "standalone",
    render: function LearningArtifactTool({ args, status }) {
      const threadId = useAuiState((state) => state.threadListItem.remoteId);
      const artifact = (args ?? {}) as ArtifactArgs;
      const title = artifact.title || "教学产物";
      const kind = artifact.kind === "knowledge_visualization"
        ? "知识可视化"
        : artifact.kind === "mixed_lesson"
          ? "混合教学"
          : "互动题卡";
      return (
        <ArtifactCard
          title={title}
          meta={`${kind}${artifact.version ? ` · ${artifact.version}` : ""}`}
          generating={status.type === "running"}
          words={0}
          className={threadId && artifact.artifact_id && artifact.entry ? undefined : "cursor-default"}
          role={threadId && artifact.artifact_id && artifact.entry ? "link" : undefined}
          tabIndex={threadId && artifact.artifact_id && artifact.entry ? 0 : undefined}
          onClick={() => {
            if (!threadId || !artifact.artifact_id || !artifact.entry) return;
            const uri = `/api/pi/threads/${encodeURIComponent(threadId)}/artifacts/${encodeURIComponent(artifact.artifact_id)}/${artifact.entry.split("/").map(encodeURIComponent).join("/")}`;
            window.open(uri, "_blank", "noopener,noreferrer");
          }}
          onKeyDown={(event) => {
            if ((event.key === "Enter" || event.key === " ") && threadId && artifact.artifact_id && artifact.entry) {
              event.preventDefault();
              const uri = `/api/pi/threads/${encodeURIComponent(threadId)}/artifacts/${encodeURIComponent(artifact.artifact_id)}/${artifact.entry.split("/").map(encodeURIComponent).join("/")}`;
              window.open(uri, "_blank", "noopener,noreferrer");
            }
          }}
        />
      );
    },
  },
  present_teaching_ui: {
    type: "backend",
    display: "standalone",
    render: ({ args, status }) => (
      <TeachingGenerativeUI
        spec={(args as { ui?: unknown } | undefined)?.ui}
        running={status.type === "running"}
      />
    ),
  },
});
