"use client";

import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { useMatch } from "react-router-dom";
import { LearningSidebar } from "./learning/components/LearningSidebar";
import { LearningContextPanel } from "./learning/components/LearningContextPanel";
import { LearningRuntimeProvider } from "./learning/runtime/LearningRuntimeProvider";

/**
 * App owns routing, thread lists and canonical data. assistant-ui is the
 * message/composer presentation runtime only.
 */
export const Assistant = () => {
  const threadMatch = useMatch("/c/:threadId");
  const threadId = threadMatch?.params.threadId;
  return (
    <LearningRuntimeProvider threadId={threadId}>
      <SidebarProvider>
        <LearningSidebar />
        <SidebarInset className="h-dvh overflow-hidden">
          <header className="absolute start-2 top-2 z-20 md:hidden">
            <SidebarTrigger aria-label="打开会话列表" />
          </header>
          <div className="flex h-full min-w-0">
            <div className="min-w-0 flex-1"><Thread /></div>
            <LearningContextPanel threadId={threadId} />
          </div>
        </SidebarInset>
      </SidebarProvider>
    </LearningRuntimeProvider>
  );
};
