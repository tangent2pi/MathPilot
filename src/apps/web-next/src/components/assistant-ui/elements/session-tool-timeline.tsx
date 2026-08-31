"use client";

import { type ReactNode, useLayoutEffect, useState } from "react";
import {
  BrainIcon,
  FileSearchIcon,
  SearchIcon,
  SendIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import type { ToolCallMessagePart } from "@assistant-ui/react";
import { MarkdownText } from "./markdown-text";
import { ReasoningText } from "./reasoning.aui";
import { TimelineStep, ToolTimeline } from "./tool-timeline";

const TOOL_META: Record<string, { verb: string; icon: LucideIcon }> = {
  read: { verb: "读取", icon: FileSearchIcon },
  grep: { verb: "检索", icon: SearchIcon },
  learning_action: { verb: "执行学习动作", icon: SendIcon },
};

const compact = (value: string) => {
  const singleLine = value.replaceAll(/\s+/g, " ").trim();
  return singleLine.length > 96 ? `${singleLine.slice(0, 95)}…` : singleLine;
};

const toolMeta = (name: string) => {
  if (name.startsWith("mathpilot.operation.")) return { verb: "执行", icon: WrenchIcon };
  const direct = TOOL_META[name];
  if (direct) return direct;
  if (/search|grep|find/i.test(name)) return { verb: "Searched", icon: SearchIcon };
  if (/ocr|vision|image/i.test(name)) return { verb: "检查", icon: FileSearchIcon };
  return { verb: "调用", icon: WrenchIcon };
};

const toolTarget = (part: ToolCallMessagePart) => {
  const args = part.args as Record<string, unknown>;
  for (const key of ["path", "file", "command", "query", "artifact_id", "card_id", "title"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return compact(value);
  }
  return part.toolName;
};

export function SessionToolTimeline({
  children,
  count,
  settled,
}: {
  children: ReactNode;
  count: number;
  settled: boolean;
}) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [autoClosed, setAutoClosed] = useState(settled);

  useLayoutEffect(() => {
    // Each timeline settles only once. A later tool run creates a new group;
    // it must not reactivate every completed group earlier in the message.
    if (settled) setAutoClosed(true);
  }, [settled]);

  return (
    <ToolTimeline
      streaming={!autoClosed}
      open={userOpen ?? !autoClosed}
      onOpenChange={setUserOpen}
      restingLabel={`${count} 个步骤`}
      activeLabel="处理中"
      className="mt-1 mb-2 max-w-none"
    >
      {children}
    </ToolTimeline>
  );
}

export function SessionReasoningStep({ active }: { active: boolean }) {
  return (
    <TimelineStep verb={active ? "思考中" : "思考"} icon={BrainIcon} active={active}>
      <ReasoningText
        streaming={active}
        className="text-foreground/60 max-h-56 ps-0 pt-1 pb-1 text-[13.5px]"
      >
        <MarkdownText />
      </ReasoningText>
    </TimelineStep>
  );
}

export function SessionToolStep({
  part,
  active,
  children,
}: {
  part: ToolCallMessagePart;
  active: boolean;
  children?: ReactNode;
}) {
  const meta = toolMeta(part.toolName);

  return (
    <TimelineStep
      {...meta}
      chip={toolTarget(part)}
      active={active}
    >
      {children}
    </TimelineStep>
  );
}
