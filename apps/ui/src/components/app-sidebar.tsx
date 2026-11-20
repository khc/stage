import { Link, useRouterState } from "@tanstack/react-router";
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

const workspace = [
  { to: "/", label: "Overview" },
  { to: "/tasks", label: "Tasks" },
  { to: "/jobs", label: "Jobs" },
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
      className={cn(
        "size-2 rounded-full",
        health.isError ? "bg-destructive" : health.isPending ? "bg-amber-500" : "bg-emerald-500",
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
              <div className="flex flex-col gap-1 leading-none">
                <span className="font-display text-5xl leading-none">Stage</span>
                <span className="text-xs text-muted-foreground">v1.0</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu className="gap-2">
            <SidebarMenuItem>
              <span className="block px-2 py-1.5 text-sm font-medium">Workspace</span>
              <SidebarMenuSub className="ml-0 border-l-0 px-1.5">
                {workspace.map((item) => (
                  <SidebarMenuSubItem key={item.to}>
                    <SidebarMenuSubButton
                      isActive={item.to === "/" ? pathname === "/" : pathname.startsWith(item.to)}
                      render={<Link to={item.to} />}
                    >
                      {item.label}
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
                    render={<a href="/docs" target="_blank" rel="noreferrer" />}
                  >
                    API reference
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
