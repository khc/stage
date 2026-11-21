import { Link, useRouterState } from "@tanstack/react-router";
import { BookOpen, Layers3, LayoutDashboard, Server } from "lucide-react";
import type * as React from "react";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { useHealth, useTasks } from "@/lib/queries";
import { cn } from "@/lib/utils";

// Larger hit area on touch screens.
const navItem = "max-md:min-h-11";

const workspace = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/tasks", label: "Tasks", icon: Layers3 },
  { to: "/jobs", label: "Jobs", icon: Server },
] as const;

export function useHealthLabel() {
  const health = useHealth();
  return {
    health,
    label: health.isError
      ? "Service unavailable"
      : health.isPending
        ? "Connecting…"
        : "Service connected",
  };
}

export function StatusDot({ className }: { className?: string }) {
  const { health } = useHealthLabel();
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 rounded-full",
        health.isError ? "bg-destructive" : health.isPending ? "bg-warning" : "bg-success",
        className,
      )}
    />
  );
}

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const tasks = useTasks();
  const { label } = useHealthLabel();
  return (
    <Sidebar variant="floating" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              className="h-auto py-1.5"
              render={<Link to="/" aria-label="Stage home" />}
            >
              <span className="font-display text-5xl leading-tight">Stage</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="pb-0">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuSub className="ml-0 border-l-0 px-1.5">
                <SidebarMenuSubItem>
                  <SidebarMenuSubButton
                    className={navItem}
                    isActive={pathname === "/assistant" || pathname.startsWith("/assistant/")}
                    render={<Link to="/assistant" />}
                  >
                    <img src="/stage.png" alt="" className="size-4 shrink-0 rounded-[4px]" />
                    <span>Assistant</span>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              </SidebarMenuSub>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarMenu className="gap-2">
            <SidebarMenuItem>
              <span className="block px-2 py-1.5 text-sm font-medium">Workspace</span>
              <SidebarMenuSub className="ml-0 border-l-0 px-1.5">
                {workspace.map((item) => (
                  <SidebarMenuSubItem key={item.to}>
                    <SidebarMenuSubButton
                      className={navItem}
                      isActive={
                        item.to === "/" ? pathname === "/" : pathname.startsWith(item.to)
                      }
                      render={<Link to={item.to} />}
                    >
                      <item.icon />
                      <span>{item.label}</span>
                      {item.to === "/tasks" && tasks.data && (
                        <span className="ml-auto text-xs text-muted-foreground">
                          {tasks.data.tasks.length}
                        </span>
                      )}
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                ))}
              </SidebarMenuSub>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <span className="block px-2 py-1.5 text-sm font-medium">Reference</span>
              <SidebarMenuSub className="ml-0 border-l-0 px-1.5">
                <SidebarMenuSubItem>
                  <SidebarMenuSubButton
                    className={navItem}
                    render={<a href="/docs" target="_blank" rel="noreferrer" />}
                  >
                    <BookOpen />
                    <span>API reference</span>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              </SidebarMenuSub>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
          <StatusDot />
          {label}
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
