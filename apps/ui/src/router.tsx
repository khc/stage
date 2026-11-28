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
import { cn } from "cn";
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
} from "lucide-react";
import { lazy, Suspense, useEffect, useState, type ComponentType } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { AssistantPage } from "@/features/assistant/assistant-page";
import { shortJobName } from "@/lib/api";
import { assistantLayoutId, requestNewChat, useIsAssistant, useNav } from "@/lib/nav";
import { startPlatformEvents } from "@/lib/platform-events";
import { useHealth, useJobs, useTasks } from "@/lib/queries";

// Pages and sheets load on demand. The Assistant is the landing page, so it stays in the main bundle: a lazy chunk would add a request hop before the first paint.
// oxlint-disable-next-line typescript/no-explicit-any -- the same bound React.lazy uses
const lazyNamed = <K extends string, C extends ComponentType<any>>(
  load: () => Promise<Record<K, C>>,
  name: K,
) => lazy(() => load().then((module) => ({ default: module[name] })));

const JobSheet = lazyNamed(() => import("@/features/jobs/job-sheet"), "JobSheet");
const JobsTable = lazyNamed(() => import("@/features/jobs/jobs-table"), "JobsTable");
const AssistantSettingsPage = lazyNamed(
  () => import("@/features/settings/assistant-settings-page"),
  "AssistantSettingsPage",
);
const ProvidersPage = lazyNamed(
  () => import("@/features/settings/providers-page"),
  "ProvidersPage",
);
const NewTaskDialog = lazyNamed(() => import("@/features/tasks/new-task-dialog"), "NewTaskDialog");
const TaskSheet = lazyNamed(() => import("@/features/tasks/task-sheet"), "TaskSheet");
const TasksPanel = lazyNamed(() => import("@/features/tasks/tasks-panel"), "TasksPanel");

// Stays true once a value has been true, so a sheet's chunk loads on first open and its close animation still plays.
function useOnceTrue(value: boolean) {
  const [seen, setSeen] = useState(value);
  if (value && !seen) setSeen(true);
  return seen;
}

const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);

type Caption = { crumb: string; eyebrow: string; title: string; subtitle: string };

const captions: Record<string, Caption> = {
  "/": {
    crumb: "Assistant",
    eyebrow: "Assistant",
    title: "Assistant",
    subtitle: "Chat with the orchestrator.",
  },
  "/overview": {
    crumb: "Overview",
    eyebrow: "Agent operations",
    title: "Control room",
    subtitle: "A clear view of your agent workspace.",
  },
  "/tasks": {
    crumb: "Tasks",
    eyebrow: "Saved prompts",
    title: "Tasks",
    subtitle: "Save a prompt. Choose a job. Put your agents to work.",
  },
  "/jobs": {
    crumb: "Jobs",
    eyebrow: "Cloud Run workers",
    title: "Jobs",
    subtitle: "The workers behind your tasks.",
  },
  "/settings/providers": {
    crumb: "Providers",
    eyebrow: "Model access",
    title: "Providers",
    subtitle: "Configure model providers and API credentials.",
  },
  "/settings/assistant": {
    crumb: "Assistant",
    eyebrow: "Preferences",
    title: "Assistant settings",
    subtitle: "Choose how new conversations start.",
  },
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
  const isAssistant = useIsAssistant();
  const isSettings = section === "/settings";
  const tasksQuery = useTasks();
  const jobsQuery = useJobs();
  const { crumb, eyebrow, title, subtitle } =
    captions[isAssistant ? "/" : isSettings ? pathname : section] ?? captions["/overview"]!;
  const jobs = jobsQuery.data?.jobs ?? [];
  const openJob = search.job ? jobs.find((job) => shortJobName(job) === search.job) : undefined;
  const refreshing = tasksQuery.isFetching || jobsQuery.isFetching;
  const showNewTask = useOnceTrue(!!search.new);
  const showJob = useOnceTrue(!!openJob);
  const showTask = useOnceTrue(section === "/tasks" && !!taskId);

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
    <SidebarProvider className="aurora">
      <AppSidebar />
      <SidebarInset className={cn("bg-transparent", isAssistant && "h-svh overflow-hidden")}>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <nav
            aria-label="Breadcrumb"
            className="flex items-center gap-1 text-sm text-muted-foreground"
          >
            {isSettings ? "Settings" : "Workspace"}
            <ChevronRight className="size-3.5" />
            <strong className="font-medium text-foreground">{crumb}</strong>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {isAssistant && (
              <Button
                size="sm"
                nativeButton={false}
                render={<Link to="/" />}
                onClick={requestNewChat}
              >
                <Plus />
                New chat
              </Button>
            )}
          </div>
        </header>
        {isAssistant ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <Suspense fallback={null}>
              <Outlet />
            </Suspense>
          </div>
        ) : (
          <>
            <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="mb-1 flex items-center gap-2 text-xs font-medium text-primary">
                    <span className="h-0.5 w-6 rounded-full bg-linear-to-r from-brand-1 via-brand-2 to-brand-3" />
                    {eyebrow}
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
              <Suspense fallback={null}>
                <Outlet />
              </Suspense>
            </div>
          </>
        )}
      </SidebarInset>
      <Suspense fallback={null}>
        {showNewTask && <NewTaskDialog open={!!search.new} initialJob={search.for ?? ""} />}
        {showJob && <JobSheet job={openJob} tasks={tasksQuery.data?.tasks ?? []} />}
        {showTask && <TaskSheet taskId={section === "/tasks" ? taskId : undefined} />}
      </Suspense>
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

const story = [
  { icon: Layers3, word: "Tasks", rest: "define the work.", underline: "decoration-brand-1" },
  { icon: Server, word: "Jobs", rest: "execute it.", underline: "decoration-brand-2" },
  { icon: Terminal, word: "Sessions", rest: "tell the story.", underline: "decoration-brand-3" },
] as const;

// The idea of the product in one line, set in the wordmark's typeface over a wash of the palette.
function StoryBanner() {
  return (
    <section
      aria-label="How Stage works"
      className="relative overflow-hidden rounded-2xl border bg-card"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-linear-to-br from-brand-1/15 via-brand-2/10 to-brand-3/15"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute -top-20 -right-12 size-60 rounded-full bg-brand-3/25 blur-3xl"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute -right-24 -bottom-24 size-60 rounded-full bg-brand-4/20 blur-3xl"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute -bottom-24 left-1/3 size-56 rounded-full bg-brand-1/20 blur-3xl"
      />
      <div className="relative flex flex-wrap items-center justify-between gap-6 px-6 py-8 md:px-10">
        <p className="font-display text-2xl leading-snug md:text-3xl">
          {story.map(({ word, rest, underline }) => (
            <span key={word} className="block">
              <span className={cn("underline decoration-2 underline-offset-4", underline)}>
                {word}
              </span>{" "}
              {rest}
            </span>
          ))}
        </p>
        <ol aria-hidden className="flex items-center gap-3 text-primary">
          {story.map(({ icon: Icon, word }, i) => (
            <li key={word} className="flex items-center gap-3">
              <span className="grid size-12 place-items-center rounded-2xl bg-card/80 shadow-sm ring-1 ring-border backdrop-blur [&_svg]:size-6">
                <Icon />
              </span>
              {i < story.length - 1 && <ChevronRight className="size-4 text-muted-foreground" />}
            </li>
          ))}
        </ol>
      </div>
    </section>
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
          tone="bg-linear-to-br from-brand-1/20 to-brand-3/20 text-primary"
          to="/tasks"
          label="Saved tasks"
          value={tasks.data ? tasks.data.tasks.length : "—"}
          note="Ready for your next execution"
        />
        <Stat
          icon={<Server />}
          tone="bg-linear-to-br from-brand-1/20 to-brand-3/20 text-primary"
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
      <StoryBanner />
      {tasks.data?.tasks.length === 0 && (
        <Card className="border-primary/20 bg-linear-to-br from-brand-1/15 via-brand-3/10 to-card">
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
      <p className="flex justify-end text-xs text-muted-foreground">
        <a
          href="/docs"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 text-primary"
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
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/assistant",
    component: AssistantSettingsPage,
  }),
]);

export const router = createRouter({ routeTree });
