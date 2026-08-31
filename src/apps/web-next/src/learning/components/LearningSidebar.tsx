"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArchiveIcon,
  BookOpenCheckIcon,
  BrainCircuitIcon,
  Clock3Icon,
  HistoryIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  UsersIcon,
} from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { AccountMenu } from "@/account-menu";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { useAuth } from "@/auth";
import type { ThreadSummary } from "../contracts";
import { learningApi, learningKeys } from "../data/client";

const learningLinks: ReadonlyArray<{
  to: string;
  label: string;
  icon: typeof BookOpenCheckIcon;
  end?: boolean;
}> = [
  { to: "/learning", label: "学习概览", icon: BookOpenCheckIcon, end: true },
  { to: "/learning/history", label: "学习历史", icon: HistoryIcon },
  { to: "/learning/state", label: "科学状态", icon: BrainCircuitIcon },
  { to: "/learning/memory", label: "学习记忆", icon: Clock3Icon },
  { to: "/learning/review", label: "复习队列", icon: BookOpenCheckIcon },
] as const;

export function LearningSidebar() {
  const { principal } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [renaming, setRenaming] = useState<string>();
  const [title, setTitle] = useState("");
  const query = useQuery({
    queryKey: learningKeys.threads,
    queryFn: learningApi.listThreads,
    enabled: Boolean(principal?.roles.includes("student")),
    retry: 1,
  });
  const threads = query.data?.data.threads ?? [];
  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    return term ? threads.filter((thread) => thread.title.toLocaleLowerCase().includes(term)) : threads;
  }, [search, threads]);

  const rename = useMutation({
    mutationFn: ({ thread, nextTitle }: { thread: ThreadSummary; nextTitle: string }) => learningApi.renameThread(thread, nextTitle),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: learningKeys.threads }); },
  });
  const archive = useMutation({
    mutationFn: (thread: ThreadSummary) => learningApi.archiveThread(thread),
    onSuccess: async (_result, thread) => {
      await queryClient.invalidateQueries({ queryKey: learningKeys.threads });
      if (location.pathname === `/c/${encodeURIComponent(thread.thread_id)}`) navigate("/");
    },
  });

  const submitRename = (event: FormEvent, thread: ThreadSummary) => {
    event.preventDefault();
    const nextTitle = title.trim();
    if (!nextTitle || nextTitle === thread.title) {
      setRenaming(undefined);
      return;
    }
    rename.mutate({ thread, nextTitle }, { onSuccess: () => setRenaming(undefined) });
  };

  return (
    <Sidebar>
      <SidebarHeader className="border-b px-3 py-3">
        <button
          type="button"
          className="flex min-w-0 items-center gap-2 text-start"
          onClick={() => navigate("/")}
        >
          <img className="size-8 rounded-lg" src="/mathpilot-icon.png" width="32" height="32" alt="" />
          <span className="min-w-0 leading-none">
            <span className="block font-semibold">数学智元</span>
            <span className="text-sidebar-foreground/60 mt-1 block text-xs">MathPilot</span>
          </span>
        </button>
      </SidebarHeader>
      <SidebarContent className="soft-scrollbar gap-4 px-2 py-2">
        <section className="space-y-1" aria-label="对话">
          <Button
            variant="ghost"
            className="h-9 w-full justify-start gap-2 px-2.5 font-normal"
            onClick={() => navigate("/")}
          >
            <PlusIcon className="size-4" />新对话
          </Button>
          {threads.length > 0 && (
            <label className="relative block py-1">
              <SearchIcon className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2" />
              <Input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索对话"
                aria-label="搜索对话"
                className="h-8 ps-8 text-sm"
              />
            </label>
          )}
          {query.isPending && principal?.roles.includes("student") && (
            <div className="text-muted-foreground flex h-16 items-center justify-center" role="status">
              <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" />
              <span className="sr-only">正在读取对话</span>
            </div>
          )}
          <div className="space-y-0.5">
            {filtered.map((thread) => {
              const active = location.pathname === `/c/${encodeURIComponent(thread.thread_id)}`;
              if (renaming === thread.thread_id) {
                return (
                  <form key={thread.thread_id} onSubmit={(event) => submitRename(event, thread)} className="px-1 py-0.5">
                    <Input
                      autoFocus
                      maxLength={120}
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      onBlur={() => { if (!rename.isPending) setRenaming(undefined); }}
                      aria-label="新的对话标题"
                      className="h-8"
                    />
                  </form>
                );
              }
              return (
                <div
                  key={thread.thread_id}
                  className={cn(
                    "group/thread flex items-center rounded-md",
                    active && "bg-sidebar-accent text-sidebar-accent-foreground",
                    thread.status === "archived" && "opacity-55",
                  )}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate px-2.5 py-2 text-start text-sm"
                    onClick={() => navigate(`/c/${encodeURIComponent(thread.thread_id)}`)}
                  >
                    {thread.title || "新对话"}
                  </button>
                  {thread.status === "active" && (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={<Button variant="ghost" size="icon" className="me-1 size-7 opacity-0 group-hover/thread:opacity-100 data-[state=open]:opacity-100 focus-visible:opacity-100" />}
                      >
                        <MoreHorizontalIcon className="size-4" />
                        <span className="sr-only">对话操作</span>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent side="right" align="start">
                        <DropdownMenuItem onClick={() => { setTitle(thread.title); setRenaming(thread.thread_id); }}>
                          <PencilIcon />重命名
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => archive.mutate(thread)}>
                          <ArchiveIcon />归档
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {principal && (
          <nav className="border-t pt-3" aria-label="学习记录">
            <div className="text-muted-foreground px-2.5 pb-1 text-xs font-medium">学习记录</div>
            {learningLinks.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) => cn(
                  "flex h-9 items-center gap-2 rounded-md px-2.5 text-sm",
                  isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/65",
                )}
              >
                <Icon className="size-4" />{label}
              </NavLink>
            ))}
            {principal.roles.includes("teacher") && (
              <NavLink
                to="/teacher/students"
                className={({ isActive }) => cn(
                  "flex h-9 items-center gap-2 rounded-md px-2.5 text-sm",
                  isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/65",
                )}
              >
                <UsersIcon className="size-4" />学生
              </NavLink>
            )}
          </nav>
        )}
      </SidebarContent>
      <SidebarRail />
      <SidebarFooter className="border-t"><AccountMenu /></SidebarFooter>
    </Sidebar>
  );
}
