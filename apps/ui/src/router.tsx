import { useQueryClient } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  redirect,
  useRouterState,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import {
  Activity,
  FileText,
  Layers3,
  Play,
  Plus,
  RefreshCw,
  Server,
  Terminal,
  Workflow,
  ChevronRight,
  ArrowRight,
  Database,
} from "lucide-react";
import { useEffect } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { FontPicker } from "@/components/font-picker";
import { ThemePicker } from "@/components/theme-picker";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { AssistantPage } from "@/features/assistant/assistant-page";
import { JobSheet } from "@/features/jobs/job-sheet";
import { JobsTable } from "@/features/jobs/jobs-table";
import { ProvidersPage } from "@/features/settings/providers-page";
import { NewTaskDialog } from "@/features/tasks/new-task-dialog";
import { TaskSheet } from "@/features/tasks/task-sheet";
import { TasksPanel } from "@/features/tasks/tasks-panel";
import { shortJobName } from "@/lib/api";
import { assistantLayoutId, useIsAssistant, useNav } from "@/lib/nav";
import { startPlatformEvents } from "@/lib/platform-events";
import { useHealth, useJobs, useTasks } from "@/lib/queries";

const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);

const captions: Record<string, [string, string, string]> = {
  "/": ["Assistant", "Assistant", "Chat with the orchestrator."],
  "/overview": ["Overview", "Control room", "A clear view of your agent workspace."],
  "/tasks": ["Tasks", "Tasks", "Save a prompt. Choose a job. Put your agents to work."],
  "/jobs": ["Jobs", "Jobs", "The workers behind your tasks."],
  "/settings": ["Providers", "Providers", "Configure model providers and API credentials."],
};

function Shell() {
  const client = useQueryClient();
  const { openCreate } = useNav();
  const search = useSearch({ strict: false }) as {
    job?: string;
    new?: boolean;
    for?: string;
  };
  useEffect(() => startPlatformEvents(client), [client]);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { taskId, chatId } = useParams({ strict: false }) as { taskId?: string; chatId?: string };
  const section = `/${pathname.split("/")[1]}`;
  const isAssistant = useIsAssistant();
  const isSettings = section === "/settings";
  const tasksQuery = useTasks();
  const jobsQuery = useJobs();
  const [crumb, title, subtitle] = captions[isAssistant ? "/" : section] ?? captions["/overview"]!;
  const jobs = jobsQuery.data?.jobs ?? [];
  const openJob = search.job ? jobs.find((job) => shortJobName(job) === search.job) : undefined;
  const refreshing = tasksQuery.isFetching || jobsQuery.isFetching;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== "/" || target?.matches("input, textarea, select, [contenteditable=true]"))
        return;
      const input = document.querySelector<HTMLInputElement>("input[data-search]");
      if (input) {
        event.preventDefault();
        input.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className={isAssistant ? "h-svh overflow-hidden" : undefined}>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-4" />
          <nav
            aria-label="Breadcrumb"
            className="flex items-center gap-1 text-sm text-muted-foreground"
          >
            {isSettings ? "Settings" : "Workspace"}
            <ChevronRight className="size-3.5" />
            <strong className="font-medium text-foreground">{crumb}</strong>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {isAssistant && chatId && (
              <Button variant="outline" size="sm" render={<Link to="/" />}>
                <Plus />
                New chat
              </Button>
            )}
            <FontPicker />
            <ThemePicker />
            <ThemeToggle />
          </div>
        </header>
        {isAssistant ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <Outlet />
          </div>
        ) : (
          <>
            <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="mb-1 flex items-center gap-2 text-xs font-medium text-primary">
                    <span className="h-px w-4 bg-primary" />
                    Agent operations
                  </p>
                  <h1 className="text-2xl font-medium">{title}</h1>
                  <p className="text-sm text-muted-foreground">{subtitle}</p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="icon"
                    disabled={refreshing}
                    aria-label="Refresh workspace"
                    onClick={() => void client.invalidateQueries()}
                  >
                    <RefreshCw className={refreshing ? "animate-spin" : ""} />
                  </Button>
                  {section === "/jobs" && (
                    <Button onClick={() => void openCreate()}>
                      <Plus />
                      New task
                    </Button>
                  )}
                </div>
              </div>
              <Outlet />
            </div>
          </>
        )}
      </SidebarInset>
      <NewTaskDialog open={!!search.new} initialJob={search.for ?? ""} />
      <JobSheet job={openJob} tasks={tasksQuery.data?.tasks ?? []} />
      <TaskSheet taskId={section === "/tasks" ? taskId : undefined} />
      <Toaster />
    </SidebarProvider>
  );
}

function Stat({
  icon,
  tone,
  label,
  value,
  note,
  to,
}: {
  to?: "/tasks" | "/jobs";
  icon: React.ReactNode;
  tone: string;
  label: string;
  value: React.ReactNode;
  note: string;
}) {
  const card = (
    <Card
      className={`relative ${to ? "transition-colors hover:border-primary/40 hover:bg-accent/30" : ""}`}
    >
      <CardHeader>
        <span
          className={`absolute top-4 right-4 grid size-9 place-items-center rounded-lg [&_svg]:size-4 ${tone}`}
        >
          {icon}
        </span>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl">{value}</CardTitle>
      </CardHeader>
      <CardContent className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="max-md:hidden">{note}</span>
        {to && <ChevronRight className="ml-auto size-4" aria-hidden />}
      </CardContent>
    </Card>
  );
  return to ? (
    <Link to={to} aria-label={`${label}: view all`}>
      {card}
    </Link>
  ) : (
    card
  );
}

function Overview() {
  const tasks = useTasks();
  const jobs = useJobs();
  const health = useHealth();
  return (
    <>
      <section className="grid gap-4 md:grid-cols-3" aria-label="Workspace summary">
        <Stat
          icon={<Layers3 />}
          tone="bg-primary/10 text-primary"
          to="/tasks"
          label="Saved tasks"
          value={tasks.data ? tasks.data.tasks.length : "—"}
          note="Ready for your next execution"
        />
        <Stat
          icon={<Server />}
          tone="bg-primary/10 text-primary"
          to="/jobs"
          label="Cloud Run jobs"
          value={jobs.data ? jobs.data.jobs.length : "—"}
          note="Configured workers in your workspace"
        />
        <Stat
          icon={<Activity />}
          tone={health.isError ? "bg-warning/10 text-warning" : "bg-success/10 text-success"}
          label="API connection"
          value={health.isError ? "Unavailable" : health.isPending ? "Connecting" : "Healthy"}
          note={
            health.dataUpdatedAt
              ? `Checked ${new Date(health.dataUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
              : "Waiting for the service"
          }
        />
      </section>
      {tasks.data?.tasks.length === 0 && (
        <Card className="border-primary/20 bg-linear-to-br from-primary/15 via-primary/5 to-card">
          <CardContent className="flex flex-wrap items-center gap-4">
            <span className="grid size-11 place-items-center rounded-xl bg-primary/15 text-primary">
              <Workflow className="size-6" />
            </span>
            <div className="flex-1">
              <h2 className="font-medium">One task. Every conversation in view.</h2>
              <p className="text-sm text-muted-foreground">
                Give an agent a prompt, then inspect its work through execution sessions.
              </p>
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <FileText className="size-4" /> Save <Play className="size-4" /> Run{" "}
              <Terminal className="size-4" /> Inspect
            </div>
          </CardContent>
        </Card>
      )}
      <TasksPanel title="Tasks" limit={8} />
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Database className="size-3.5" />
        Tasks define the work. Jobs execute it. Sessions tell the story.
        <a
          href="/docs"
          target="_blank"
          rel="noreferrer"
          className="ml-auto flex items-center gap-1 text-primary"
        >
          Explore the API <ArrowRight className="size-3" />
        </a>
      </p>
    </>
  );
}

const rootRoute = createRootRoute({
  component: Shell,
  validateSearch: (search: Record<string, unknown>) => ({
    job: str(search.job),
    new: search.new === true || search.new === "true" ? true : undefined,
    for: str(search.for),
  }),
});

function AssistantLayoutRoute() {
  const { chatId } = useParams({ strict: false }) as { chatId?: string };
  return <AssistantPage chatId={chatId} />;
}

// Keep the Assistant mounted when a new conversation gains a URL.
const assistantRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: assistantLayoutId,
  component: AssistantLayoutRoute,
});

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/overview", component: Overview }),
  assistantRoute.addChildren([
    createRoute({ getParentRoute: () => assistantRoute, path: "/", component: () => null }),
    createRoute({
      getParentRoute: () => assistantRoute,
      path: "/assistant/$chatId",
      component: () => null,
    }),
  ]),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/assistant",
    beforeLoad: ({ search, location }) => {
      throw redirect({ to: "/", search, hash: location.hash, replace: true });
    },
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/tasks",
    component: () => <TasksPanel title="Tasks" />,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/tasks/$taskId",
    component: () => <TasksPanel title="Tasks" />,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/jobs", component: JobsTable }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/providers",
    component: ProvidersPage,
  }),
]);

export const router = createRouter({ routeTree });
