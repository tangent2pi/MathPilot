"use client";

import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { ThreadListSidebar } from "@/components/assistant-ui/elements/threadlist-sidebar.aui";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AccountMenu } from "./account-menu";
import { PiRuntimeProvider } from "./PiRuntimeProvider";

/**
 * P1：assistant-ui 首页形态——全屏 Thread，运行时为 Pi（/api/pi/*）。
 * 线程列表/题面开场白/后台链为后续阶段。
 */
export const Assistant = () => {
  return (
    <PiRuntimeProvider>
      <SidebarProvider>
        <ThreadListSidebar footer={<AccountMenu />} />
        <SidebarInset className="h-dvh overflow-hidden">
          <header className="absolute start-2 top-2 z-20 md:hidden">
            <SidebarTrigger aria-label="打开会话列表" />
          </header>
          <Thread />
        </SidebarInset>
      </SidebarProvider>
    </PiRuntimeProvider>
  );
};
