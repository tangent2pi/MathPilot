"use client";

// 回形针旁「自我测评」入口：图标按钮弹居中 Dialog（不挡聊天上下文）。
import { ClipboardCheckIcon } from "lucide-react";
import { useState, type FC } from "react";

import { SelfTestDialog } from "@/components/assistant-ui/self-test/SelfTestDialog";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { Dialog } from "@/components/ui/dialog";

export const SelfTestEntry: FC = () => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <TooltipIconButton
        tooltip="自我测评"
        side="bottom"
        variant="ghost"
        size="icon"
        type="button"
        className="aui-composer-self-test text-muted-foreground hover:text-foreground hover:bg-muted-foreground/15 dark:border-muted-foreground/15 dark:hover:bg-muted-foreground/30 size-7 rounded-full active:scale-[0.96] motion-reduce:transition-none"
        aria-label="自我测评"
        onClick={() => setOpen(true)}
      >
        <ClipboardCheckIcon className="aui-composer-self-test-icon size-4" />
      </TooltipIconButton>
      <Dialog open={open} onOpenChange={setOpen}>
        {open && <SelfTestDialog onClose={() => setOpen(false)} />}
      </Dialog>
    </>
  );
};
