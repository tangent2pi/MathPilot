/**
 * ExplanationRenderer：普通/交互 HTML、视频讲解渲染（设计 §4.2、§13）。
 * edu-agent 是候选实现；输出遵循 agmath.learning-artifact/v1，由 ArtifactPublisher 发布。
 */
import type { ProviderRequestBase, ProviderResult } from "../errors.js";

export interface ExplanationSpec {
  readonly kind: "knowledge_visualization" | "question_card" | "mixed_lesson";
  readonly targetKnowledge: readonly string[];
  readonly questionRef?: string;
  readonly studentLevelHint?: "weak" | "learning" | "mastered";
  readonly evidenceRefs: readonly string[];
  /** 同步预算；超过时宿主应回退普通图文而非无限等待 */
  readonly latencyBudgetMs: number;
}

export type RenderTarget = "sandboxed_html" | "native_card" | "video";

export interface RenderRequest extends ProviderRequestBase {
  readonly spec: ExplanationSpec;
  readonly target: RenderTarget;
}

export interface RenderResponse {
  /** 生成的 Artifact 草稿目录（未发布）；结构必须符合 learning-artifact-manifest schema */
  readonly draftDirRef: string;
  readonly manifestJson: Record<string, unknown>;
  /** 耗时产物（视频）允许 pending，完成后经事件变 ready */
  readonly async?: { readonly jobId: string };
}

export interface ExplanationRenderer {
  render(req: RenderRequest): Promise<ProviderResult<RenderResponse>>;
}
