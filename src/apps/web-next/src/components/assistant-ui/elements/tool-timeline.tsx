"use client";

import type { ReactNode } from "react";
import { ChevronRightIcon, type LucideIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { collapsePanel, ShimmerLabel, SwapLabel } from "./surfaces";

export interface TimelineStepProps {
  verb: string;
  chip?: string;
  icon: LucideIcon;
  active?: boolean;
  children?: ReactNode;
  className?: string;
}

export interface ToolTimelineProps {
  children: ReactNode;
  streaming: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  restingLabel: string;
  activeLabel: string;
  className?: string;
}

export function TimelineStep({
  verb,
  chip,
  icon: Icon,
  active = false,
  children,
  className,
}: TimelineStepProps) {
  return (
    <div
      data-slot="tool-timeline-step"
      className={cn(
        "text-foreground/55 flex min-w-0 flex-col text-[13.5px]",
        className,
      )}
    >
      <div className="grid min-w-0 grid-cols-[0.875rem_auto_minmax(0,1fr)] items-center gap-2">
        <Icon className="text-foreground/35 size-3.5 shrink-0" />
        <ShimmerLabel
          active={active}
          className="relative inline-block shrink-0 leading-none"
        >
          {verb}
        </ShimmerLabel>
        {chip ? (
          <span
            className="bg-foreground/[0.06] text-foreground/70 min-w-0 truncate rounded-md px-1.5 py-0.5 font-mono text-[11px]"
            title={chip}
          >
            {chip}
          </span>
        ) : null}
      </div>
      {children ? <div className="min-w-0 ps-[1.375rem] pt-1">{children}</div> : null}
    </div>
  );
}

export function ToolTimeline({
  children,
  streaming,
  open,
  onOpenChange,
  restingLabel,
  activeLabel,
  className,
}: ToolTimelineProps) {
  return (
    <Collapsible
      data-slot="tool-timeline"
      open={open}
      onOpenChange={onOpenChange}
      className={cn("w-full max-w-sm self-stretch", className)}
    >
      <CollapsibleTrigger className="group/trigger text-foreground/55 hover:text-foreground/90 grid w-fit grid-cols-[0.875rem_auto] items-center justify-start gap-1.5 rounded-md py-1 text-start text-[13.5px] transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <ChevronRightIcon className="size-3.5 shrink-0 opacity-60 transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-open/trigger:rotate-90 group-data-panel-open/trigger:rotate-90 motion-reduce:transition-none" />
        <SwapLabel
          active={streaming ? 0 : 1}
          className="text-start tabular-nums"
        >
          <ShimmerLabel
            active={streaming}
            className="relative inline-block leading-none"
          >
            {activeLabel}
          </ShimmerLabel>
          <>{restingLabel}</>
        </SwapLabel>
      </CollapsibleTrigger>
      <CollapsibleContent className={cn(collapsePanel, "outline-none")}>
        <div className="flex flex-col gap-2.5 ps-1 pt-2.5">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
