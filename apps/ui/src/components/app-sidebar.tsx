import { Link, useRouterState } from "@tanstack/react-router";
import { BookOpen, ChevronRight, LayoutDashboard, Layers3, Server } from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useHealth, useTasks } from "@/lib/queries";
import { cn } from "@/lib/utils";

const items = [
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
      className={cn(
        "size-2 rounded-full",
        health.isError ? "bg-destructive" : health.isPending ? "bg-amber-500" : "bg-emerald-500",
        className,
      )}
    />
  );
}

export function AppSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const tasks = useTasks();
  const { label } = useHealthLabel();
  return (
    <Sidebar>
      <SidebarHeader>
        <Link
          to="/"
          className="flex items-center gap-2 px-2 py-1 font-semibold"
          aria-label="Stage home"
        >
          <img src="/stage.svg" alt="" className="size-8" />
          Stage
        </Link>
        <div className="flex items-center gap-2 rounded-lg border p-2 text-sm">
          <span className="bg-primary/10 text-primary grid size-7 place-items-center rounded-md text-xs font-semibold">
            A
          </span>
          <div className="flex flex-1 flex-col leading-tight">
            Agent workspace
            <span className="text-muted-foreground text-xs">Task orchestration</span>
          </div>
          <ChevronRight className="text-muted-foreground size-3.5" />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    isActive={item.to === "/" ? pathname === "/" : pathname.startsWith(item.to)}
                    render={<Link to={item.to} />}
                  >
                    <item.icon />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                  {item.to === "/tasks" && tasks.data && (
                    <SidebarMenuBadge>{tasks.data.tasks.length}</SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton render={<a href="/docs" target="_blank" rel="noreferrer" />}>
              <BookOpen />
              <span>API reference</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="text-muted-foreground flex items-center gap-2 px-2 text-xs">
          <StatusDot />
          {label}
          <span className="ml-auto">v1.0</span>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
