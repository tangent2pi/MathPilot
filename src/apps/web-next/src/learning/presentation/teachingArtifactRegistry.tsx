"use client";

import katex from "katex";
import { SparklesIcon } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { MATH_DERIVATION_ARTIFACT_SCHEMA } from "@mathpilot/contracts";
import type { LearningThreadMessagePart, MathDerivationTeachingArtifact } from "@mathpilot/contracts";
import { MathBlock } from "@/components/assistant-ui/elements/math-block";

type TeachingArtifactPart = Extract<LearningThreadMessagePart, { type: "teaching_artifact" }>;

export function TeachingArtifactMessage({ data }: { data: unknown }) {
  const part = teachingArtifactPart(data);
  if (!part) return null;
  const derivation = mathDerivation(part.presentation);
  if (part.artifact_schema === MATH_DERIVATION_ARTIFACT_SCHEMA && derivation) {
    const steps = derivation.steps.map((step) => ({
      expression: <KaTeXExpression expression={step.expression} />,
      ...(step.note ? { note: step.note } : {}),
    }));
    return (
      <MathBlock
        aria-label={part.summary}
        role="group"
        className="my-3 max-w-2xl"
        label={derivation.label ?? "推导"}
        steps={steps}
        visibleSteps={steps.length}
      />
    );
  }
  return (
    <section className="bg-card my-3 rounded-2xl border p-4 shadow-sm" aria-label="教学材料">
      <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium">
        <SparklesIcon className="size-4" aria-hidden="true" />
        教学材料
      </div>
      <p className="mt-2 text-sm leading-6">{part.summary}</p>
    </section>
  );
}

function KaTeXExpression({ expression }: { expression: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!ref.current) return;
    katex.render(expression, ref.current, {
      displayMode: false,
      output: "htmlAndMathml",
      strict: "warn",
      throwOnError: false,
      trust: false,
    });
  }, [expression]);
  return <span ref={ref}>{expression}</span>;
}

function teachingArtifactPart(value: unknown): TeachingArtifactPart | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const part = value as Partial<TeachingArtifactPart>;
  if (part.type !== "teaching_artifact" || typeof part.artifact_ref !== "string"
    || typeof part.artifact_schema !== "string" || typeof part.summary !== "string") return undefined;
  return part as TeachingArtifactPart;
}

function mathDerivation(value: unknown): MathDerivationTeachingArtifact | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const artifact = value as Partial<MathDerivationTeachingArtifact>;
  if (artifact.schema !== MATH_DERIVATION_ARTIFACT_SCHEMA || !Array.isArray(artifact.steps)
    || artifact.steps.length < 1 || artifact.steps.length > 16
    || (artifact.label !== undefined && (typeof artifact.label !== "string"
      || !artifact.label.trim() || artifact.label.length > 120))) return undefined;
  if (artifact.steps.some((step) => !step || typeof step !== "object"
    || typeof step.expression !== "string" || !step.expression.trim() || step.expression.length > 2000
    || (step.note !== undefined && (typeof step.note !== "string"
      || !step.note.trim() || step.note.length > 500)))) return undefined;
  return artifact as MathDerivationTeachingArtifact;
}
