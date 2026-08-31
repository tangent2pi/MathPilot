"use client";

import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ChevronUp, CircleHelp, LogOut, Moon, Settings, Sun } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { useAuth } from "./auth";
import { AccountPanelDialog, type AccountPanel } from "./account-panels";

const roleName = (roles: string[]): string => {
  if (roles.includes("teacher")) return "教师";
  return "学生";
};

export function AccountMenu() {
  const { principal, requireAuth, refreshAccount, signOut } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const panelValue = searchParams.get("panel");
  const panel: AccountPanel | null = panelValue === "settings" || panelValue === "help" ? panelValue : null;
  const [avatarUrl, setAvatarUrl] = useState(`/api/account/avatar?v=${Date.now()}`);

  const setPanel = (nextPanel: AccountPanel | null) => {
    const next = new URLSearchParams(searchParams);
    if (nextPanel) next.set("panel", nextPanel);
    else next.delete("panel");
    setSearchParams(next, { replace: nextPanel === null });
  };

  if (!principal) {
    return (
      <div className="grid grid-cols-2 gap-2 p-1">
        <Button variant="outline" onClick={() => requireAuth(undefined, "login")}>登录</Button>
        <Button onClick={() => requireAuth(undefined, "register")}>注册</Button>
      </div>
    );
  }

  const initials = principal.name.trim().slice(0, 2).toUpperCase() || "MP";
  const toggleTheme = () => {
    const dark = document.documentElement.classList.toggle("dark");
    localStorage.setItem("mathpilot:theme", dark ? "dark" : "light");
  };

  return (
    <>
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger render={<SidebarMenuButton size="lg" />}>
            <Avatar className="size-8 rounded-lg">
              <AvatarImage src={avatarUrl} alt={principal.name} />
              <AvatarFallback className="rounded-lg">{initials}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1 text-start leading-tight">
              <div className="truncate text-sm font-medium">{principal.name}</div>
              <div className="text-sidebar-foreground/60 truncate text-xs">{roleName(principal.roles)}</div>
            </div>
            <ChevronUp className="ms-auto size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-64">
            <DropdownMenuGroup>
              <DropdownMenuLabel>
                <span className="block truncate normal-case">{principal.email}</span>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={toggleTheme}><Moon className="dark:hidden" /><Sun className="hidden dark:block" />外观</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setPanel("settings")}><Settings />设置</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setPanel("help")}><CircleHelp />帮助</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => void signOut()}><LogOut />退出登录</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
    <AccountPanelDialog
      panel={panel}
      principal={principal}
      avatarUrl={avatarUrl}
      onOpenChange={(open) => { if (!open) setPanel(null); }}
      onAvatarChange={setAvatarUrl}
      onAccountChange={refreshAccount}
    />
    </>
  );
}
