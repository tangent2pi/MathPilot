"use client";

import { defineToolkit, useAuiState } from "@assistant-ui/react";
import { useEffect, useState } from "react";
import { ArtifactCard } from "@/components/assistant-ui/elements/artifact-card";
import { QuestionCard, type QuestionCardArgs } from "@/components/assistant-ui/question-card";

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
    render: ({ args, status, toolCallId }) => (
      <LearningArtifactTool
        artifact={(args ?? {}) as ArtifactArgs}
        running={status.type === "running"}
        toolCallId={toolCallId}
      />
    ),
  },
  present_teaching_ui: {
    type: "backend",
    display: "standalone",
    // Keep historical tool calls silent while the presentation contract is
    // being redesigned. The runtime no longer exposes this tool to the model.
    render: () => null,
  },
});

function LearningArtifactTool({
  artifact,
  running,
  toolCallId,
}: {
  artifact: ArtifactArgs;
  running: boolean;
  toolCallId: string;
}) {
  const threadId = useAuiState((state) => state.threadListItem.remoteId);
  const [card, setCard] = useState<QuestionCardArgs | null>(null);
  const [loadError, setLoadError] = useState(false);
  const uri = threadId && artifact.artifact_id && artifact.entry
    ? `/api/pi/threads/${encodeURIComponent(threadId)}/artifacts/${encodeURIComponent(artifact.artifact_id)}/${artifact.entry.split("/").map(encodeURIComponent).join("/")}`
    : null;

  useEffect(() => {
    if (running || artifact.renderer !== "native_card" || !uri) return;
    const controller = new AbortController();
    setLoadError(false);
    void fetch(uri, { credentials: "include", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("artifact not found");
        return response.json() as Promise<QuestionCardArgs>;
      })
      .then(setCard)
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setLoadError(true);
      });
    return () => controller.abort();
  }, [artifact.renderer, running, uri]);

  if (artifact.renderer === "native_card" && card) {
    return <QuestionCard args={card} running={false} toolCallId={toolCallId} />;
  }

  const title = artifact.title || "教学产物";
  const kind = artifact.kind === "knowledge_visualization"
    ? "知识可视化"
    : artifact.kind === "mixed_lesson"
      ? "混合教学"
      : "互动题卡";
  const canOpen = artifact.renderer !== "native_card" && Boolean(uri);
  return (
    <ArtifactCard
      title={title}
      meta={loadError ? "产物发布失败" : `${kind}${artifact.version ? ` · ${artifact.version}` : ""}`}
      generating={running || (artifact.renderer === "native_card" && !loadError)}
      words={0}
      className={canOpen ? undefined : "cursor-default"}
      role={canOpen ? "link" : undefined}
      tabIndex={canOpen ? 0 : undefined}
      onClick={() => { if (canOpen && uri) window.open(uri, "_blank", "noopener,noreferrer"); }}
      onKeyDown={(event) => {
        if ((event.key === "Enter" || event.key === " ") && canOpen && uri) {
          event.preventDefault();
          window.open(uri, "_blank", "noopener,noreferrer");
        }
      }}
    />
  );
}
