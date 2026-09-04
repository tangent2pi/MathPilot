"use client";

// 自我测评内部文本渲染：与消息流 MarkdownText 使用同一套
// remark-math / rehype-katex 与数学定界符预处理，保证公式一致。
import "katex/dist/katex.min.css";

import {
  escapeCurrencyDollars,
  normalizeMathDelimiters,
} from "@assistant-ui/react-markdown";
import { type FC } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { cn } from "@/lib/utils";

export const SelfTestMarkdown: FC<{ text: string; className?: string }> = ({
  text,
  className,
}) => {
  return (
    <div className={cn("aui-md text-sm leading-relaxed", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
      >
        {escapeCurrencyDollars(normalizeMathDelimiters(text))}
      </ReactMarkdown>
    </div>
  );
};
