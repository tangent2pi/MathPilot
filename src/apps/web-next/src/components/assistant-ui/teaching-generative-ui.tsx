"use client";

import {
  renderGenerativeUI,
  type GenerativeUILibrary,
} from "@assistant-ui/react-generative-ui";
import { styledGenerativeUILibrary } from "@/components/assistant-ui/elements/generative-ui";

const componentNames = [
  "Card", "Col", "Row", "Header", "Text", "Caption", "Markdown",
  "Fact", "Badge", "Alert", "Divider",
] as const;

// 教学 Agent 只能从这一小组官方组件中组合展示，不可生成任意 React/HTML。
const teachingLibrary = Object.fromEntries(
  componentNames.map((name) => [name, styledGenerativeUILibrary[name]]),
) as GenerativeUILibrary;

export function TeachingGenerativeUI({ spec, running }: { spec: unknown; running: boolean }) {
  return (
    <section
      data-aui-theme="elements"
      className="bg-card my-3 w-full max-w-2xl overflow-hidden rounded-2xl border p-4 shadow-sm"
      aria-label="教学过程卡片"
    >
      {renderGenerativeUI(spec, teachingLibrary, { status: running ? "streaming" : "done" })}
    </section>
  );
}
