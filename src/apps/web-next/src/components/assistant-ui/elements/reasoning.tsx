"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export const ANIMATION_DURATION = 200;

const ReasoningPreviewContext = createContext(false);

const reasoningVariants = cva("aui-reasoning-root mb-3 w-full", {
  variants: {
    variant: {
      outline: "rounded-lg border px-3 py-2",
      ghost: "",
      muted: "bg-muted/50 rounded-lg px-3 py-2",
    },
  },
  defaultVariants: { variant: "ghost" },
});

export type ReasoningRootProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  "open" | "onOpenChange"
> &
  VariantProps<typeof reasoningVariants> & {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    defaultOpen?: boolean;
    streaming?: boolean;
    onAnimationStart?: () => void;
  };

function ReasoningRoot({
  className,
  variant,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  streaming,
  onAnimationStart,
  children,
  ...props
}: ReasoningRootProps) {
  const initialOpenRef = useRef(defaultOpen);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled
    ? controlledOpen
    : (userOpen ?? (streaming || initialOpenRef.current));
  const isPreview = streaming === true && isOpen;
  const previousStreaming = useRef(streaming);

  useLayoutEffect(() => {
    if (previousStreaming.current === streaming) return;
    previousStreaming.current = streaming;
    if (!isControlled && userOpen === null && !initialOpenRef.current) {
      onAnimationStart?.();
    }
  }, [streaming, isControlled, userOpen, onAnimationStart]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      onAnimationStart?.();
      if (!isControlled) setUserOpen(open);
      controlledOnOpenChange?.(open);
    },
    [onAnimationStart, isControlled, controlledOnOpenChange],
  );

  return (
    <Collapsible
      data-slot="reasoning-root"
      data-variant={variant}
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn(
        "group/reasoning-root",
        reasoningVariants({ variant, className }),
      )}
      style={{ "--animation-duration": `${ANIMATION_DURATION}ms` } as React.CSSProperties}
      {...props}
    >
      <ReasoningPreviewContext.Provider value={isPreview}>
        {children}
      </ReasoningPreviewContext.Provider>
    </Collapsible>
  );
}

function ReasoningFade({
  side = "bottom",
  className,
  ...props
}: React.ComponentProps<"div"> & { side?: "top" | "bottom" }) {
  return (
    <div
      data-slot="reasoning-fade"
      className={cn(
        "aui-reasoning-fade pointer-events-none absolute inset-x-0 z-10 h-8",
        side === "top"
          ? "top-0 bg-[linear-gradient(to_bottom,var(--color-background),transparent)]"
          : "bottom-0 bg-[linear-gradient(to_top,var(--color-background),transparent)]",
        "fade-in-0 animate-in animation-duration-(--animation-duration) motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}

function ReasoningTrigger({
  active,
  duration,
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  active?: boolean;
  duration?: number;
}) {
  const durationText = duration ? ` (${duration}s)` : "";

  return (
    <CollapsibleTrigger
      data-slot="reasoning-trigger"
      className={cn(
        "aui-reasoning-trigger group/trigger text-muted-foreground hover:text-foreground flex max-w-[75%] origin-left items-center gap-2 rounded-md py-1.5 text-sm transition-[color,scale] outline-none active:scale-[0.98] focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none",
        className,
      )}
      {...props}
    >
      <BrainIcon className="size-4 shrink-0" aria-hidden="true" />
      <span
        className={cn(
          "inline-block leading-none tabular-nums",
          active && "shimmer motion-reduce:animate-none",
        )}
      >
        Reasoning{durationText}
      </span>
      <ChevronDownIcon
        className="mt-0.5 size-4 shrink-0 -rotate-90 transition-transform duration-(--animation-duration) ease-[cubic-bezier(0.32,0.72,0,1)] group-data-open/trigger:rotate-0 group-data-panel-open/trigger:rotate-0 motion-reduce:transition-none"
        aria-hidden="true"
      />
    </CollapsibleTrigger>
  );
}

function ReasoningContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  const isPreview = useContext(ReasoningPreviewContext);

  return (
    <CollapsibleContent
      data-slot="reasoning-content"
      className={cn(
        "aui-reasoning-content text-muted-foreground group/collapsible-content relative overflow-hidden text-sm outline-none ease-[cubic-bezier(0.32,0.72,0,1)]",
        "data-closed:animate-collapsible-up data-open:animate-collapsible-down data-closed:fill-mode-forwards data-closed:pointer-events-none [--tw-duration:var(--animation-duration)] motion-reduce:animate-none",
        className,
      )}
      {...props}
    >
      <ReasoningFade side="top" />
      {children}
      {isPreview ? <ReasoningFade /> : null}
    </CollapsibleContent>
  );
}

function ReasoningText({
  streaming,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & { streaming?: boolean }) {
  const contextPreview = useContext(ReasoningPreviewContext);
  const isPreview = streaming ?? contextPreview;
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isPreview) return;
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll || !content) return;
    let pinned = true;
    let previousTop = scroll.scrollTop;
    let previousHeight = scroll.scrollHeight;
    const isAtBottom = () =>
      Math.abs(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight) <= 1
      || scroll.scrollHeight <= scroll.clientHeight;
    const pin = () => {
      if (pinned) scroll.scrollTop = scroll.scrollHeight;
    };
    const onScroll = () => {
      if (isAtBottom()) pinned = true;
      else if (scroll.scrollTop < previousTop && scroll.scrollHeight === previousHeight) pinned = false;
      previousTop = scroll.scrollTop;
      previousHeight = scroll.scrollHeight;
    };
    pin();
    scroll.addEventListener("scroll", onScroll);
    const observer = new ResizeObserver(pin);
    observer.observe(content);
    return () => {
      scroll.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [isPreview]);

  return (
    <div
      ref={scrollRef}
      data-slot="reasoning-text"
      className={cn(
        "aui-reasoning-text no-scrollbar relative z-0 max-h-64 overflow-y-auto ps-6 pt-2 pb-2 leading-relaxed text-pretty",
        "transform-gpu transition-[transform,opacity] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none",
        "group-data-open/collapsible-content:animate-in group-data-closed/collapsible-content:animate-out group-data-open/collapsible-content:fade-in-0 group-data-closed/collapsible-content:fade-out-0",
        className,
      )}
      {...props}
    >
      <div ref={contentRef} className="aui-reasoning-text-content space-y-4">
        {children}
      </div>
    </div>
  );
}

export {
  ReasoningRoot,
  ReasoningTrigger,
  ReasoningContent,
  ReasoningText,
  ReasoningFade,
  reasoningVariants,
};
