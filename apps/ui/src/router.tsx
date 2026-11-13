import { useQueryClient } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
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
  Search,
  Server,
  Terminal,
  Workflow,
  ChevronRight,
  ArrowRight,
  Database,
} from "lucide-react";
import { useEffect, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { Empty, ErrorBox, Loading } from "@/components/states";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { JobCard } from "@/features/jobs/job-card";
import { JobSheet } from "@/features/jobs/job-sheet";
import { NewTaskDialog } from "@/features/tasks/new-task-dialog";
import { TaskSheet } from "@/features/tasks/task-sheet";
import { TasksPanel } from "@/features/tasks/tasks-panel";
import { shortJobName } from "@/lib/api";
import { useNav } from "@/lib/nav";
import { startPlatformEvents } from "@/lib/platform-events";
import { useHealth, useJobs, useTasks } from "@/lib/queries";

const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);

const captions: Record<string, [string, string, string]> = {
  "/": ["Overview", "Control room", "A clear view of your agent workspace."],
  "/tasks": ["Tasks", "Tasks", "Save a prompt. Choose a job. Put your agents to work."],
  "/jobs": ["Jobs", "Jobs", "The workers behind your tasks."],
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
  const { taskId } = useParams({ strict: false }) as { taskId?: string };
  const section = `/${pathname.split("/")[1]}`;
  const tasksQuery = useTasks();
  const jobsQuery = useJobs();
  const [crumb, title, subtitle] = captions[section] ?? captions["/"]!;
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
      <SidebarInset>
        <header className="flex h-14 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-4" />
          <nav
            aria-label="Breadcrumb"
            className="text-muted-foreground flex items-center gap-1 text-sm"
          >
            Workspace
            <ChevronRight className="size-3.5" />
            <strong className="text-foreground font-medium">{crumb}</strong>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <ThemeToggle />
          </div>
        </header>
        <main className="flex flex-1 flex-col gap-6 p-4 md:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-primary mb-1 flex items-center gap-2 text-xs font-semibold tracking-widest">
                <span className="bg-primary h-px w-4" />
                AGENT OPERATIONS
              </p>
              <h1 className="text-2xl font-semibold">{title}</h1>
              <p className="text-muted-foreground text-sm">{subtitle}</p>
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
              <Button onClick={() => void openCreate()}>
                <Plus />
                New task
              </Button>
            </div>
          </div>
          <Outlet />
        </main>
        <footer className="text-muted-foreground flex items-center justify-between border-t px-6 py-3 text-xs">
          <span>STAGE · YOUR AGENT WORKSPACE</span>
          <span>Powered by your jobs</span>
        </footer>
      </SidebarInset>
      <NewTaskDialog open={!!search.new} initialJob={search.for ?? ""} />
      <JobSheet job={openJob} tasks={tasksQuery.data?.tasks ?? []} />
      <TaskSheet taskId={taskId} />
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
}: {
  icon: React.ReactNode;
  tone: string;
  label: string;
  value: React.ReactNode;
  note: string;
}) {
  return (
    <Card className="relative">
      <CardHeader>
        <span
          className={`absolute top-4 right-4 grid size-9 place-items-center rounded-lg [&_svg]:size-4 ${tone}`}
        >
          {icon}
        </span>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl">{value}</CardTitle>
      </CardHeader>
      <CardContent className="text-muted-foreground text-xs">{note}</CardContent>
    </Card>
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
          tone="bg-violet-500/10 text-violet-600 dark:text-violet-400"
          label="Saved tasks"
          value={tasks.data ? tasks.data.tasks.length : "—"}
          note="Ready for your next execution"
        />
        <Stat
          icon={<Server />}
          tone="bg-sky-500/10 text-sky-600 dark:text-sky-400"
          label="Cloud Run jobs"
          value={jobs.data ? jobs.data.jobs.length : "—"}
          note="Configured workers in your workspace"
        />
        <Stat
          icon={<Activity />}
          tone={
            health.isError
              ? "bg-amber-500/10 text-amber-600"
              : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          }
          label="API connection"
          value={health.isError ? "Unavailable" : health.isPending ? "Connecting" : "Healthy"}
          note={
            health.dataUpdatedAt
              ? `Checked ${new Date(health.dataUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
              : "Waiting for the service"
          }
        />
      </section>
      <Card className="border-primary/20 from-primary/15 via-primary/5 to-card bg-gradient-to-br">
        <CardContent className="flex flex-wrap items-center gap-4">
          <span className="bg-primary/15 text-primary grid size-11 place-items-center rounded-xl">
            <Workflow className="size-6" />
          </span>
          <div className="flex-1">
            <h2 className="font-medium">One task. Every conversation in view.</h2>
            <p className="text-muted-foreground text-sm">
              Give an agent a prompt, then inspect its work through execution sessions.
            </p>
          </div>
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <FileText className="size-4" /> Save <Play className="size-4" /> Run{" "}
            <Terminal className="size-4" /> Inspect
          </div>
        </CardContent>
      </Card>
      <TasksPanel title="Saved tasks" />
      <p className="text-muted-foreground flex items-center gap-2 text-xs">
        <Database className="size-3.5" />
        Tasks define the work. Jobs execute it. Sessions tell the story.
        <a
          href="/docs"
          target="_blank"
          rel="noreferrer"
          className="text-primary ml-auto flex items-center gap-1"
        >
          Explore the API <ArrowRight className="size-3" />
        </a>
      </p>
    </>
  );
}

function Jobs() {
  const jobsQuery = useJobs();
  const [search, setSearch] = useState("");
  const jobs = jobsQuery.data?.jobs ?? [];
  const filtered = jobs.filter((job) =>
    `${job.name} ${job.description ?? ""}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <Card className="has-data-[slot=card-footer]:pb-(--card-spacing)">
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <Server className="size-4" />
          Cloud Run jobs
          <Badge variant="secondary">{jobs.length}</Badge>
        </CardTitle>
        <div className="relative w-64 max-w-full">
          <Search className="text-muted-foreground absolute top-2 left-2.5 size-4" />
          <Input
            data-search
            aria-label="Search jobs"
            placeholder="Search jobs…"
            className="pl-8"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </CardHeader>
      <CardContent>
        {jobsQuery.isPending ? (
          <Loading label="Loading jobs…" />
        ) : jobsQuery.isError ? (
          <ErrorBox error={jobsQuery.error} retry={() => void jobsQuery.refetch()} />
        ) : !jobs.length ? (
          <Empty icon={<Server />} title="No jobs configured">
            Create a Cloud Run job in the configured project and region, then refresh this
            workspace.
          </Empty>
        ) : !filtered.length ? (
          <Empty icon={<Search />} title="No matching jobs">
            Try another job name.
          </Empty>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((job, i) => (
              <JobCard key={job.name ?? i} job={job} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
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

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: Overview }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/tasks",
    component: () => <TasksPanel title="All tasks" />,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/tasks/$taskId",
    component: () => <TasksPanel title="All tasks" />,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/jobs", component: Jobs }),
]);

export const router = createRouter({ routeTree });
