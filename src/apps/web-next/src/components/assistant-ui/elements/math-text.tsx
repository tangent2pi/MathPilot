"use client";

import renderMathInElement from "katex/contrib/auto-render";
import "katex/dist/katex.min.css";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

const mathOptions = {
  delimiters: [
    { left: "$$", right: "$$", display: true },
    { left: "\\[", right: "\\]", display: true },
    { left: "\\(", right: "\\)", display: false },
    { left: "$", right: "$", display: false },
  ],
  ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "option"],
  throwOnError: false,
  strict: "warn" as const,
  trust: false,
};

/** 把文本中的 LaTeX（$...$、$$...$$ 等）渲染为数学符号，保持普通换行。 */
export function MathText({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) renderMathInElement(ref.current, mathOptions);
  }, [text]);
  return (
    <div ref={ref} className={cn("whitespace-pre-wrap break-words", className)}>
      {text}
    </div>
  );
}
