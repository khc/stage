import { ThemeSwitch } from "./theme-switch";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowDownLeft,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BookOpen,
  Box,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Copy,
  Database,
  FileText,
  Layers3,
  LayoutDashboard,
  Loader2,
  Menu,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Sparkles,
  Terminal,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import {
  api,
  formatTime,
  shortJobName,
  buildPrompt,
  inputExample,
  jobDetails,
  jobEnvNames,
  lastOutput,
  parseJsonObject,
  promptError,
  schemaFields,
  schemaSummary,
  streamMessages,
  withEvent,
  type AgentInfo,
  type FormField,
  type FormValues,
  type Job,
  type JsonSchema,
  type Session,
  type SessionSummary,
  type SessionEvent,
  type Task,
} from "./api";
import { Button } from "./components/ui/button";

type View = "overview" | "tasks" | "jobs";
type Notice = {
  title: string;
  message?: string;
  error?: boolean;
  taskId?: string;
};
const captions = {
  overview: ["Control room", "A clear view of your agent workspace."],
  tasks: ["Tasks", "Save a prompt. Choose a job. Put your agents to work."],
  jobs: ["Jobs", "The workers behind your tasks."],
};

function Loading({ label = "Loading workspace…" }: { label?: string }) {
  return (
    <div className="loading">
      <Loader2 size={19} className="animate-spin" />
      <span>{label}</span>
    </div>
  );
}
function ErrorBox({
  error,
  retry,
}: {
  error: Error | null;
  retry?: () => void;
}) {
  return (
    <div className="error-box" role="alert">
      <CircleAlert size={18} />
      <div>
        <strong>Something went wrong</strong>
        <p>{error?.message ?? "The request could not be completed."}</p>
        {retry && (
          <button onClick={retry}>
            Try again <ArrowRight size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
function Empty({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!copied && !failed) return;
    const timer = setTimeout(() => {
      setCopied(false);
      setFailed(false);
    }, 2000);
    return () => clearTimeout(timer);
  }, [copied, failed]);
  return (
    <button
      className="copy-button"
      title={failed ? "Could not copy" : copied ? "Copied" : "Copy ID"}
      aria-label={failed ? "Could not copy" : copied ? "Copied" : "Copy ID"}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          setFailed(true);
        }
      }}
    >
      {failed ? (
        <CircleAlert size={13} />
      ) : copied ? (
        <Check size={13} />
      ) : (
        <Copy size={13} />
      )}
    </button>
  );
}

export function Dashboard() {
  const client = useQueryClient();
  const [view, setView] = useState<View>("overview");
  const [search, setSearch] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [selected, setSelected] = useState<string | null>(() =>
    new URLSearchParams(location.search).get("task"),
  );
  const [notice, setNotice] = useState<Notice | null>(null);
  const [newJob, setNewJob] = useState("");
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const createDialog = useRef<HTMLDialogElement>(null);
  const tasksQuery = useQuery({ queryKey: ["tasks"], queryFn: api.tasks });
  const jobsQuery = useQuery({ queryKey: ["jobs"], queryFn: api.jobs });
  const health = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    retry: false,
  });
  const tasks = tasksQuery.data?.tasks ?? [];
  const jobs = jobsQuery.data?.jobs ?? [];
  const runTask = useMutation({
    mutationFn: api.run,
    onSuccess: (result, taskId) => {
      setNotice({
        title: "Execution submitted",
        taskId,
        message: `Cloud Run accepted the request. New sessions will appear when the agent starts. Operation: ${result.operation || "accepted"}`,
      });
      setSelected(taskId);
      void client.invalidateQueries({ queryKey: ["sessions", taskId] });
    },
    onError: (error, taskId) =>
      setNotice({
        title: "Could not start task",
        taskId,
        message: error.message,
        error: true,
      }),
  });
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 12000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const url = new URL(location.href);
    if (selected) url.searchParams.set("task", selected);
    else url.searchParams.delete("task");
    history.replaceState(null, "", url);
  }, [selected]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.key !== "/" ||
        target?.matches("input, textarea, select, [contenteditable=true]") ||
        document.querySelector("dialog[open]")
      )
        return;
      const search = document.querySelector<HTMLInputElement>(
        ".search-field input",
      );
      if (search) {
        event.preventDefault();
        search.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const openCreate = (jobName = "") => {
    setNewJob(jobName);
    createDialog.current?.showModal();
  };
  const navigate = (next: View) => {
    setView(next);
    setSearch("");
    setMobileNav(false);
  };
  const filtered = tasks.filter((task) =>
    `${task.prompt} ${task.jobName} ${task.agentName ?? ""} ${task.taskId}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const filteredJobs = jobs.filter((job) =>
    `${job.name} ${job.description ?? ""}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const openJob = selectedJob
    ? jobs.find((job) => shortJobName(job) === selectedJob)
    : undefined;
  const refreshing = tasksQuery.isFetching || jobsQuery.isFetching;
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["tasks"] });
    void client.invalidateQueries({ queryKey: ["jobs"] });
    void client.invalidateQueries({ queryKey: ["health"] });
  };

  return (
    <div className="app-shell">
      {mobileNav && (
        <button
          className="nav-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileNav(false)}
        />
      )}
      <aside className={`sidebar ${mobileNav ? "is-open" : ""}`}>
        <a className="brand" href="/" aria-label="Agent Jobs home">
          <span className="brand-symbol">
            <Workflow size={22} />
          </span>
          <span>
            Agent Jobs<span className="brand-caption">WORKSPACE</span>
          </span>
        </a>
        <div className="workspace-select">
          <span className="workspace-avatar">A</span>
          <div>
            Agent workspace<span>Task orchestration</span>
          </div>
          <ChevronRight size={14} />
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav aria-label="Main navigation">
          {(
            [
              { id: "overview", label: "Overview", icon: LayoutDashboard },
              { id: "tasks", label: "Tasks", icon: Layers3 },
              { id: "jobs", label: "Jobs", icon: Server },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id ? "active" : ""}`}
              onClick={() => navigate(item.id)}
              aria-current={view === item.id ? "page" : undefined}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
              {item.id === "tasks" && tasksQuery.data && (
                <span className="nav-count">{tasks.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-guide">
          <span className="guide-icon">
            <Sparkles size={17} />
          </span>
          <h3>From prompt to progress.</h3>
          <p>Create a task, run your job, and follow the conversation.</p>
          <button onClick={() => openCreate()}>
            Create your next task <ArrowRight size={14} />
          </button>
        </div>
        <div className="sidebar-bottom">
          <a href="/docs" target="_blank" rel="noreferrer" className="nav-item">
            <BookOpen size={17} />
            <span>API reference</span>
            <ArrowDownLeft size={14} className="rotate-180" />
          </a>
          <div className="workspace-footer">
            <span
              className={`status-dot ${health.isError ? "offline" : health.isPending ? "pending" : ""}`}
            />
            <span>
              {health.isError
                ? "Service unavailable"
                : health.isPending
                  ? "Connecting…"
                  : "Service connected"}
            </span>
            <span className="version">v1.0</span>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <Button
              variant="ghost"
              size="icon"
              className="mobile-menu"
              onClick={() => setMobileNav(true)}
              aria-label="Open navigation"
            >
              <Menu size={18} />
            </Button>
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>
              {view === "overview"
                ? "Overview"
                : view === "tasks"
                  ? "Tasks"
                  : "Jobs"}
            </strong>
          </div>
          <div className="topbar-right">
            <ThemeSwitch />
            <span className="environment-badge">
              <span
                className={`status-dot ${health.isError ? "offline" : health.isPending ? "pending" : ""}`}
              />
              {health.isError
                ? "Disconnected"
                : health.isPending
                  ? "Connecting"
                  : "Connected"}
            </span>
            <a
              href="/docs"
              target="_blank"
              rel="noreferrer"
              aria-label="Open API reference"
            >
              <BookOpen size={17} />
            </a>
          </div>
        </header>
        <main className="main-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                <span className="tiny-line" />
                AGENT OPERATIONS
              </div>
              <h1>{captions[view][0]}</h1>
              <p>{captions[view][1]}</p>
            </div>
            <div className="heading-actions">
              <Button
                variant="outline"
                size="icon"
                onClick={refresh}
                disabled={refreshing}
                aria-label="Refresh workspace"
              >
                <RefreshCw
                  size={16}
                  className={refreshing ? "animate-spin" : ""}
                />
              </Button>
              <Button onClick={() => openCreate()}>
                <Plus size={16} />
                New task
              </Button>
            </div>
          </div>
          {view === "overview" && (
            <>
              <section className="stats-grid" aria-label="Workspace summary">
                <div className="stat-card">
                  <span className="stat-icon violet">
                    <Layers3 size={18} />
                  </span>
                  <span className="stat-label">Saved tasks</span>
                  <strong>{tasksQuery.data ? tasks.length : "—"}</strong>
                  <span className="stat-note">
                    Ready for your next execution
                  </span>
                </div>
                <div className="stat-card">
                  <span className="stat-icon blue">
                    <Server size={18} />
                  </span>
                  <span className="stat-label">Cloud Run jobs</span>
                  <strong>{jobsQuery.data ? jobs.length : "—"}</strong>
                  <span className="stat-note">
                    Configured workers in your workspace
                  </span>
                </div>
                <div className="stat-card">
                  <span
                    className={`stat-icon ${health.isError ? "amber" : "green"}`}
                  >
                    <Activity size={18} />
                  </span>
                  <span className="stat-label">API connection</span>
                  <strong className="status-value">
                    {health.isError
                      ? "Unavailable"
                      : health.isPending
                        ? "Connecting"
                        : "Healthy"}
                  </strong>
                  <span className="stat-note">
                    {health.dataUpdatedAt
                      ? `Checked ${new Date(health.dataUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                      : "Waiting for the service"}
                  </span>
                </div>
              </section>
              <section className="workflow-banner">
                <div className="workflow-banner-icon">
                  <Workflow size={25} />
                </div>
                <div>
                  <h2>One task. Every conversation in view.</h2>
                  <p>
                    Give an agent a prompt, then inspect its work through
                    execution sessions.
                  </p>
                </div>
                <div className="workflow-steps">
                  <span>
                    <FileText size={13} />
                    Save
                  </span>
                  <ChevronRight size={12} />
                  <span>
                    <Play size={12} />
                    Run
                  </span>
                  <ChevronRight size={12} />
                  <span>
                    <Terminal size={13} />
                    Inspect
                  </span>
                </div>
              </section>
            </>
          )}
          {view !== "jobs" ? (
            <section className="panel task-panel">
              <div className="panel-header">
                <div className="panel-title">
                  <Layers3 size={17} />
                  <h2>{view === "overview" ? "Saved tasks" : "All tasks"}</h2>
                  {tasksQuery.data && (
                    <span className="count-badge">{tasks.length}</span>
                  )}
                </div>
                <label className="search-field">
                  <Search size={15} />
                  <input
                    aria-label="Search tasks"
                    placeholder="Search tasks…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  <kbd>/</kbd>
                </label>
              </div>
              {tasksQuery.isPending ? (
                <Loading label="Loading tasks…" />
              ) : tasksQuery.isError ? (
                <ErrorBox
                  error={tasksQuery.error}
                  retry={() => void tasksQuery.refetch()}
                />
              ) : !tasks.length ? (
                <Empty
                  icon={<Layers3 size={27} />}
                  title="Your next idea starts here"
                  action={
                    <Button size="sm" onClick={() => openCreate()}>
                      <Plus size={14} />
                      Create a task
                    </Button>
                  }
                >
                  Save a prompt and choose a job to get started.
                </Empty>
              ) : !filtered.length ? (
                <Empty icon={<Search size={26} />} title="No matching tasks">
                  Try another prompt, job name, or task ID.
                </Empty>
              ) : (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Task / prompt</th>
                        <th>Job</th>
                        <th>Agent</th>
                        <th>Contract</th>
                        <th className="text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((task) => (
                        <tr key={task.taskId}>
                          <td>
                            <button
                              className="task-link"
                              onClick={() => setSelected(task.taskId)}
                            >
                              <span className="task-row-icon">
                                <FileText size={16} />
                              </span>
                              <span>
                                <strong>{task.prompt}</strong>
                                <small>
                                  {task.taskId.slice(0, 8)}
                                  <span className="id-ellipsis">
                                    …{task.taskId.slice(-6)}
                                  </span>
                                </small>
                              </span>
                            </button>
                          </td>
                          <td>
                            <span className="job-chip">
                              <Box size={12} />
                              {task.jobName ?? "Unassigned"}
                            </span>
                          </td>
                          <td>
                            <span
                              className={`job-chip ${task.agentName ? "" : "chip-muted"}`}
                            >
                              <Workflow size={12} />
                              {task.agentName ?? "Default"}
                            </span>
                          </td>
                          <td>
                            <span
                              className={`badge ${task.jobName ? "neutral" : "warning"}`}
                            >
                              <span className="mini-dot" />
                              {task.jobName ? "Saved" : "Needs job"}
                            </span>
                          </td>
                          <td>
                            <div className="row-actions">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setSelected(task.taskId)}
                              >
                                Details
                                <ChevronRight size={13} />
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={!task.jobName || runTask.isPending}
                                onClick={() => runTask.mutate(task.taskId)}
                                aria-label={`Run task ${task.taskId}`}
                              >
                                {runTask.isPending &&
                                runTask.variables === task.taskId ? (
                                  <Loader2 size={12} className="animate-spin" />
                                ) : (
                                  <Play size={12} />
                                )}
                                Run
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="panel-footer">
                <span>
                  {tasksQuery.data
                    ? `${filtered.length} task${filtered.length === 1 ? "" : "s"}`
                    : "Task workspace"}
                </span>
                <span>
                  <RefreshCw size={11} />
                  Refreshes every 15 seconds
                </span>
              </div>
            </section>
          ) : (
            <section className="panel">
              <div className="panel-header">
                <div className="panel-title">
                  <Server size={17} />
                  <h2>Cloud Run jobs</h2>
                  <span className="count-badge">{jobs.length}</span>
                </div>
                <label className="search-field">
                  <Search size={15} />
                  <input
                    aria-label="Search jobs"
                    placeholder="Search jobs…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
              </div>
              {jobsQuery.isPending ? (
                <Loading label="Loading jobs…" />
              ) : jobsQuery.isError ? (
                <ErrorBox
                  error={jobsQuery.error}
                  retry={() => void jobsQuery.refetch()}
                />
              ) : !jobs.length ? (
                <Empty icon={<Server size={27} />} title="No jobs configured">
                  Create a Cloud Run job in the configured project and region,
                  then refresh this workspace.
                </Empty>
              ) : !filteredJobs.length ? (
                <Empty icon={<Search size={26} />} title="No matching jobs">
                  Try another job name.
                </Empty>
              ) : (
                <div className="jobs-grid">
                  {filteredJobs.map((job, i) => (
                    <JobCard
                      key={job.name ?? i}
                      job={job}
                      onCreate={() => openCreate(shortJobName(job))}
                      onOpen={() => setSelectedJob(shortJobName(job))}
                    />
                  ))}
                </div>
              )}
            </section>
          )}
          {view === "overview" && (
            <div className="bottom-note">
              <Database size={13} />
              <span>
                Tasks define the work. Jobs execute it. Sessions tell the story.
              </span>
              <a href="/docs" target="_blank" rel="noreferrer">
                Explore the API <ArrowRight size={12} />
              </a>
            </div>
          )}
        </main>
        <footer className="page-footer">
          <span>
            AGENT JOBS<span className="footer-dot">·</span>YOUR AGENT WORKSPACE
          </span>
          <span>
            <span className="mini-dot" />
            Powered by your jobs
          </span>
        </footer>
      </div>
      <NewTask
        dialogRef={createDialog}
        jobs={jobs}
        initialJob={newJob}
        onCreated={(task) => {
          createDialog.current?.close();
          void client.invalidateQueries({ queryKey: ["tasks"] });
          setSelected(task.taskId);
          setNotice({
            title: "Task created",
            taskId: task.taskId,
            message: "Your prompt is saved. Run it when you’re ready.",
          });
        }}
      />
      {openJob && (
        <JobInspector
          key={selectedJob}
          job={openJob}
          tasks={tasks}
          onClose={() => setSelectedJob(null)}
          onCreate={() => {
            setSelectedJob(null);
            openCreate(shortJobName(openJob));
          }}
          onOpenTask={(taskId) => {
            setSelectedJob(null);
            setSelected(taskId);
          }}
        />
      )}
      {selected && !openJob && (
        <TaskInspector
          taskId={selected}
          onClose={() => setSelected(null)}
          onRun={() => runTask.mutate(selected)}
          running={runTask.isPending}
          notice={notice?.taskId === selected ? notice : null}
          onDismissNotice={() => setNotice(null)}
        />
      )}
      {notice && !selected && (
        <div
          className={`toast ${notice.error ? "toast-error" : ""}`}
          role={notice.error ? "alert" : "status"}
        >
          <span className="toast-icon">
            {notice.error ? <CircleAlert size={18} /> : <Check size={18} />}
          </span>
          <div>
            <strong>{notice.title}</strong>
            {notice.message && <p>{notice.message}</p>}
          </div>
          <button
            aria-label="Dismiss notification"
            onClick={() => setNotice(null)}
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

const REGISTRATION_POLL_MS = 30_000;

// Registration is asynchronous, so poll the registry for a while after submitting.
function useAgentRegistration(jobName: string, enabled = true) {
  const [pollUntil, setPollUntil] = useState(0);
  const query = useQuery({
    queryKey: ["agents", jobName],
    queryFn: () => api.agents(jobName),
    enabled,
    retry: false,
    refetchInterval: () => (Date.now() < pollUntil ? 3000 : false),
  });
  const register = useMutation({
    mutationFn: () => api.registerAgents(jobName),
    onSuccess: () => setPollUntil(Date.now() + REGISTRATION_POLL_MS),
  });
  return { agents: query.data?.agents ?? [], query, register };
}

function RegisterAgentsButton({
  register,
  disabled,
}: {
  register: ReturnType<typeof useAgentRegistration>["register"];
  disabled?: boolean;
}) {
  return (
    <>
      <Button
        variant="outline"
        className="w-full"
        disabled={disabled || register.isPending}
        onClick={() => register.mutate()}
      >
        {register.isPending ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <RefreshCw size={14} />
        )}
        Register agents
      </Button>
      {register.isError ? (
        <p className="job-register-note job-register-error" role="alert">
          {register.error.message}
        </p>
      ) : register.isSuccess ? (
        <p className="job-register-note" role="status">
          Registration submitted. Agents appear here when the job finishes.
        </p>
      ) : null}
    </>
  );
}

function AgentContract({
  agent,
  className = "",
}: {
  agent: AgentInfo;
  className?: string;
}) {
  const rows: [string, JsonSchema | undefined][] = [
    ["Input", agent.inputSchema],
    ["Output", agent.outputSchema],
  ];
  return (
    <dl className={`agent-contract ${className}`}>
      {rows.map(([label, schema]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>
            {schemaSummary(schema)}
            {schema?.description && ` — ${schema.description}`}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function JobCard({
  job,
  onCreate,
  onOpen,
}: {
  job: Job;
  onCreate: () => void;
  onOpen: () => void;
}) {
  const location = job.name?.split("/locations/")[1]?.split("/")[0];
  const name = shortJobName(job);
  const { agents: registered, register } = useAgentRegistration(
    name,
    !!job.name,
  );
  return (
    <article className="job-card">
      <div className="job-card-top">
        <span className="job-card-icon">
          <Server size={21} />
        </span>
        <Button variant="ghost" size="sm" onClick={onOpen}>
          Details
          <ChevronRight size={13} />
        </Button>
      </div>
      <h3>
        <button className="job-card-title" onClick={onOpen}>
          {name}
        </button>
      </h3>
      <p>
        {job.description || "An agent worker available for task execution."}
      </p>
      <div className="job-card-meta">
        <span>
          <Box size={12} />
          {location ?? "Cloud Run"}
        </span>
        {job.template?.taskCount != null && (
          <span>
            {job.template.taskCount} task
            {job.template.taskCount === 1 ? "" : "s"} per execution
          </span>
        )}
      </div>
      <div className="job-agents" aria-label="Registered agents">
        {registered.length ? (
          registered.map((agent) => (
            <span
              key={agent.name}
              className="job-chip"
              title={agent.description}
            >
              <Workflow size={12} />
              {agent.name}
            </span>
          ))
        ) : (
          <small>No agents registered yet</small>
        )}
      </div>
      <div className="job-resource">
        <code>{job.name ?? "Resource name unavailable"}</code>
        {job.name && <CopyButton value={job.name} />}
      </div>
      <RegisterAgentsButton register={register} disabled={!job.name} />
      <Button variant="outline" className="w-full" onClick={onCreate}>
        <Plus size={14} />
        Create task for this job
      </Button>
    </article>
  );
}

// Pane for one Cloud Run job: its configuration, registered agents and tasks.
function JobInspector({
  job,
  tasks,
  onClose,
  onCreate,
  onOpenTask,
}: {
  job: Job;
  tasks: Task[];
  onClose: () => void;
  onCreate: () => void;
  onOpenTask: (taskId: string) => void;
}) {
  const [tab, setTab] = useState<"overview" | "agents" | "tasks">("overview");
  const name = shortJobName(job);
  const location = job.name?.split("/locations/")[1]?.split("/")[0];
  const { agents, query, register } = useAgentRegistration(name, !!job.name);
  const jobTasks = tasks.filter((task) => task.jobName === name);
  const envNames = jobEnvNames(job);
  const status = jobDetails(job).find(([label]) => label === "Status")?.[1];
  return (
    <InspectorShell eyebrow="JOB DETAILS" label="job details" onClose={onClose}>
      <div className="inspector-heading">
        <span className="task-detail-icon">
          <Server size={24} />
        </span>
        <h2 id="inspector-title">{name}</h2>
        <div className="task-id">
          <code>{job.name ?? "Resource name unavailable"}</code>
          {job.name && <CopyButton value={job.name} />}
        </div>
        <div className="task-detail-meta">
          <span className="job-chip">
            <Box size={12} />
            {location ?? "Cloud Run"}
          </span>
          {status && (
            <span
              className={`badge ${status === "Ready" ? "neutral" : "warning"}`}
            >
              <span className="mini-dot" />
              {status}
            </span>
          )}
          <Button size="sm" onClick={onCreate}>
            <Plus size={13} />
            Create task
          </Button>
        </div>
      </div>
      <div
        className="inspector-tabs"
        role="tablist"
        aria-label="Job detail sections"
      >
        <button
          role="tab"
          aria-selected={tab === "overview"}
          onClick={() => setTab("overview")}
        >
          <Database size={15} />
          Overview
        </button>
        <button
          role="tab"
          aria-selected={tab === "agents"}
          onClick={() => setTab("agents")}
        >
          <Workflow size={15} />
          Agents<span>{agents.length}</span>
        </button>
        <button
          role="tab"
          aria-selected={tab === "tasks"}
          onClick={() => setTab("tasks")}
        >
          <FileText size={15} />
          Tasks<span>{jobTasks.length}</span>
        </button>
      </div>
      <div className="inspector-body" role="tabpanel">
        {tab === "overview" ? (
          <>
            {job.description && (
              <p className="job-description">{job.description}</p>
            )}
            <dl className="job-details">
              {jobDetails(job).map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <p className="section-overline">ENVIRONMENT VARIABLES</p>
            {envNames.length ? (
              <div className="job-env">
                {envNames.map((envName) => (
                  <code key={envName}>{envName}</code>
                ))}
              </div>
            ) : (
              <small className="job-env-note">None set.</small>
            )}
            <small className="job-env-note">Values are not shown.</small>
          </>
        ) : tab === "agents" ? (
          <>
            <div className="sessions-heading">
              <div>
                <p className="section-overline">REGISTERED AGENTS</p>
                <p>The agents inside this job&apos;s container.</p>
              </div>
            </div>
            {query.isError ? (
              <ErrorBox
                error={query.error}
                retry={() => void query.refetch()}
              />
            ) : query.isPending ? (
              <Loading label="Loading agents…" />
            ) : !agents.length ? (
              <Empty icon={<Workflow size={25} />} title="No agents registered">
                Register this job to record the agents in its container.
              </Empty>
            ) : (
              agents.map((agent) => (
                <article key={agent.name} className="agent-card">
                  <h3>
                    <Workflow size={14} />
                    {agent.name}
                  </h3>
                  {agent.description && <p>{agent.description}</p>}
                  <AgentContract agent={agent} className="flush" />
                </article>
              ))
            )}
            <RegisterAgentsButton register={register} disabled={!job.name} />
          </>
        ) : !jobTasks.length ? (
          <Empty icon={<FileText size={25} />} title="No tasks yet">
            Create a task for this job to see it here.
          </Empty>
        ) : (
          jobTasks.map((task) => (
            <button
              key={task.taskId}
              className="session-list-item"
              onClick={() => onOpenTask(task.taskId)}
            >
              <span className="session-icon">
                <FileText size={17} />
              </span>
              <span>
                <strong className="task-row-prompt">{task.prompt}</strong>
                <small>
                  {task.agentName ?? "Default agent"} · …{task.taskId.slice(-6)}
                </small>
              </span>
              <ChevronRight size={16} />
            </button>
          ))
        )}
      </div>
    </InspectorShell>
  );
}

// One control for a field of a structured agent input.
function SchemaField({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: string | boolean | undefined;
  onChange: (value: string | boolean) => void;
}) {
  const id = `field-${field.key}`;
  const text = typeof value === "string" ? value : "";
  const control =
    field.kind === "boolean" ? (
      <label className="schema-check" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        {field.label}
      </label>
    ) : field.kind === "enum" ? (
      <select
        id={id}
        className="form-input"
        value={text}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{field.required ? "Choose…" : "Not set"}</option>
        {field.options?.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    ) : field.kind === "json" ? (
      <textarea
        id={id}
        className="form-input"
        rows={3}
        placeholder="JSON value"
        value={text}
        onChange={(e) => onChange(e.target.value)}
      />
    ) : field.kind === "number" ? (
      <input
        id={id}
        className="form-input"
        type="number"
        inputMode="decimal"
        step={field.integer ? 1 : "any"}
        min={field.min}
        max={field.max}
        value={text}
        onChange={(e) => onChange(e.target.value)}
      />
    ) : (
      <input
        id={id}
        className="form-input"
        autoComplete="off"
        value={text}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  return (
    <div className="schema-field">
      {field.kind !== "boolean" && (
        <label className="form-label" htmlFor={id}>
          {field.label}
          <span>{field.required ? "Required" : "Optional"}</span>
        </label>
      )}
      {control}
      {field.description && <p className="field-note">{field.description}</p>}
    </div>
  );
}

function NewTask({
  dialogRef,
  jobs,
  initialJob,
  onCreated,
}: {
  dialogRef: React.RefObject<HTMLDialogElement | null>;
  jobs: Job[];
  initialJob: string;
  onCreated: (task: Task) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [jobName, setJobName] = useState("");
  const [agentName, setAgentName] = useState("");
  const [values, setValues] = useState<FormValues>({});
  const registered = useQuery({
    queryKey: ["agents", jobName],
    queryFn: () => api.agents(jobName),
    enabled: !!jobName,
    retry: false,
  });
  const jobAgents = registered.data?.agents ?? [];
  const selectedAgent = jobAgents.find((agent) => agent.name === agentName);
  // A structured agent gets a form; its values are sent as the JSON prompt.
  const fields = schemaFields(selectedAgent?.inputSchema);
  const built = fields ? buildPrompt(fields, values) : undefined;
  const effectivePrompt = built
    ? "prompt" in built
      ? built.prompt
      : ""
    : prompt;
  const touched = Object.values(values).some((v) => v !== "" && v !== false);
  const promptProblem = built
    ? "error" in built && touched
      ? built.error
      : undefined
    : promptError(selectedAgent?.inputSchema, prompt);
  const invalid = built ? "error" in built : !!promptProblem;
  const jobOptions = [
    ...new Set(
      [...jobs.filter((job) => job.name).map(shortJobName), jobName].filter(
        Boolean,
      ),
    ),
  ];
  const mutation = useMutation({
    mutationFn: api.create,
    onSuccess: (task) => {
      setPrompt("");
      setValues({});
      setJobName("");
      setAgentName("");
      onCreated(task);
    },
  });
  useEffect(() => {
    setJobName(initialJob);
    mutation.reset();
  }, [initialJob]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate({
      prompt: effectivePrompt.trim(),
      jobName,
      agentName: agentName.trim() || undefined,
    });
  };
  return (
    <dialog
      ref={dialogRef}
      className="create-dialog"
      aria-labelledby="new-task-title"
      onClose={() => mutation.reset()}
    >
      <form onSubmit={submit}>
        <div className="dialog-heading">
          <span className="stat-icon violet">
            <Layers3 size={20} />
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close new task"
            onClick={() => dialogRef.current?.close()}
          >
            <X size={18} />
          </Button>
        </div>
        <h2 id="new-task-title">Create a task</h2>
        <p className="dialog-description">
          A prompt, a worker, and room to do great work.
        </p>
        <label className="form-label" htmlFor="job-name">
          Cloud Run job<span>Required</span>
        </label>
        <select
          id="job-name"
          className="form-input"
          value={jobName}
          onChange={(e) => {
            setJobName(e.target.value);
            setAgentName("");
            setValues({});
          }}
          required
        >
          <option value="" disabled>
            {jobOptions.length ? "Choose a job" : "No jobs available"}
          </option>
          {jobOptions.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <p className="field-note">The Cloud Run job that executes this task.</p>
        <label className="form-label" htmlFor="agent-name">
          Agent<span>Optional</span>
        </label>
        <select
          id="agent-name"
          className="form-input"
          value={agentName}
          disabled={!jobName}
          onChange={(e) => {
            setAgentName(e.target.value);
            setValues({});
          }}
        >
          <option value="">Default agent</option>
          {jobAgents.map((agent) => (
            <option key={agent.name} value={agent.name}>
              {agent.name}
              {agent.description ? ` — ${agent.description}` : ""}
            </option>
          ))}
        </select>
        <p className="field-note">
          {!jobName
            ? "Choose a job first."
            : registered.isPending
              ? "Loading agents…"
              : jobAgents.length
                ? "Agents registered for this job."
                : "No agents registered for this job, so its default agent runs the task. Use Register agents on the Jobs page."}
        </p>
        {selectedAgent && <AgentContract agent={selectedAgent} />}
        {fields ? (
          <div className="schema-form">
            <p className="section-overline">INPUT</p>
            {fields.map((field) => (
              <SchemaField
                key={field.key}
                field={field}
                value={values[field.key]}
                onChange={(value) =>
                  setValues((current) => ({ ...current, [field.key]: value }))
                }
              />
            ))}
          </div>
        ) : (
          <>
            <label className="form-label prompt-label" htmlFor="task-prompt">
              Prompt<span>Required</span>
            </label>
            <textarea
              id="task-prompt"
              className="form-input prompt-input"
              placeholder={
                inputExample(selectedAgent?.inputSchema) ??
                "What would you like your agent to work on?"
              }
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              required
              maxLength={10_000}
              rows={7}
            />
            <div className="prompt-counter">
              {prompt.length.toLocaleString()} / 10,000
            </div>
          </>
        )}
        {promptProblem && (
          <p className="composer-hint composer-error" role="alert">
            {promptProblem}
          </p>
        )}
        {mutation.isError && <ErrorBox error={mutation.error} />}
        <div className="create-hint">
          <FileText size={15} />
          <p>Creating a task saves it. You choose when to run it.</p>
        </div>
        <div className="dialog-actions">
          <Button
            type="button"
            variant="outline"
            disabled={mutation.isPending}
            onClick={() => dialogRef.current?.close()}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={
              !effectivePrompt.trim() ||
              invalid ||
              !jobName ||
              mutation.isPending
            }
          >
            {mutation.isPending ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <Plus size={15} />
            )}
            Create task
          </Button>
        </div>
      </form>
    </dialog>
  );
}

function SessionStatsBar({
  taskId,
  sessionId,
  events,
}: {
  taskId: string;
  sessionId: string;
  events: number;
}) {
  // The event count in the key refetches the totals as live events arrive.
  const stats = useQuery({
    queryKey: ["session-stats", taskId, sessionId, events],
    queryFn: () => api.stats(taskId, sessionId),
    placeholderData: (previous) => previous,
  });
  if (!stats.data) return null;
  const { tokens, llmCalls } = stats.data;
  const items: [string, number][] = [
    ["Total", tokens.total],
    ["Prompt", tokens.prompt],
    ["Output", tokens.candidates],
    ["Thinking", tokens.thoughts],
    ["Model calls", llmCalls],
  ];
  return (
    <dl className="session-stats" aria-label="Token usage">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value.toLocaleString()}</dd>
        </div>
      ))}
    </dl>
  );
}

function DeleteSession({
  taskId,
  sessionId,
  onDeleted,
}: {
  taskId: string;
  sessionId: string;
  onDeleted: () => void;
}) {
  const client = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.deleteSession(taskId, sessionId),
    onSuccess: () => {
      onDeleted();
      client.removeQueries({ queryKey: ["session", taskId, sessionId] });
      void client.invalidateQueries({ queryKey: ["sessions", taskId] });
    },
  });
  if (!confirming)
    return (
      <Button
        variant="ghost"
        size="icon"
        aria-label="Delete session"
        title="Delete session"
        onClick={() => setConfirming(true)}
      >
        <Trash2 size={15} />
      </Button>
    );
  return (
    <div className="session-delete-confirm" role="group" aria-label="Confirm">
      <span role={remove.isError ? "alert" : undefined}>
        {remove.isError ? remove.error.message : "Delete this session?"}
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled={remove.isPending}
        onClick={() => {
          remove.reset();
          setConfirming(false);
        }}
      >
        Cancel
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="session-delete-button"
        disabled={remove.isPending}
        onClick={() => remove.mutate()}
      >
        {remove.isPending ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <Trash2 size={13} />
        )}
        Delete
      </Button>
    </div>
  );
}

function ContinueSession({
  taskId,
  sessionId,
}: {
  taskId: string;
  sessionId: string;
}) {
  const client = useQueryClient();
  const [message, setMessage] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const resume = useMutation({
    mutationFn: () => api.resume(taskId, sessionId, message.trim()),
    onSuccess: () => {
      setMessage("");
      void client.invalidateQueries({
        queryKey: ["session", taskId, sessionId],
      });
    },
  });
  const canSend = !!message.trim() && !resume.isPending;
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [message]);
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) resume.mutate();
      }}
    >
      <div className="composer-box">
        <textarea
          ref={input}
          className="composer-input"
          aria-label="Message to continue the session"
          rows={1}
          value={message}
          maxLength={10_000}
          placeholder="Message the agent…"
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing)
              return;
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }}
        />
        <Button
          type="submit"
          size="icon"
          className="composer-send"
          aria-label="Send message"
          disabled={!canSend}
        >
          {resume.isPending ? (
            <Loader2 size={15} className="animate-spin" />
          ) : (
            <ArrowUp size={16} />
          )}
        </Button>
      </div>
      {resume.isError ? (
        <p className="composer-hint composer-error" role="alert">
          {resume.error.message}
        </p>
      ) : resume.isSuccess ? (
        <p className="composer-hint" role="status">
          Sent. New events appear when the agent responds.
        </p>
      ) : (
        <p className="composer-hint">
          Enter to send · Shift+Enter for a new line
        </p>
      )}
    </form>
  );
}

const INSPECTOR_MIN = 420;
const INSPECTOR_KEY = "inspector-width";
const clampWidth = (width: number) =>
  Math.round(
    Math.min(
      Math.max(width, INSPECTOR_MIN),
      Math.max(INSPECTOR_MIN, window.innerWidth * 0.9),
    ),
  );
const savedWidth = () => {
  try {
    const value = Number(localStorage.getItem(INSPECTOR_KEY));
    return value ? clampWidth(value) : undefined;
  } catch {
    return undefined;
  }
};

function useResizableWidth() {
  const [width, setWidth] = useState<number | undefined>(savedWidth);
  const [dragging, setDragging] = useState(false);
  const save = (value: number) => {
    try {
      localStorage.setItem(INSPECTOR_KEY, String(value));
    } catch {
      // Storage can be unavailable; the width then lasts for this session only.
    }
  };
  const handle = {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(true);
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      if (dragging) setWidth(clampWidth(window.innerWidth - e.clientX));
    },
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
      setDragging(false);
      const next = clampWidth(window.innerWidth - e.clientX);
      setWidth(next);
      save(next);
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step =
        e.key === "ArrowLeft" ? 24 : e.key === "ArrowRight" ? -24 : 0;
      if (!step) return;
      e.preventDefault();
      const next = clampWidth(
        (width ?? e.currentTarget.closest("dialog")!.offsetWidth) + step,
      );
      setWidth(next);
      save(next);
    },
  };
  return { width, dragging, handle };
}

// Keeps the cached session in step with the live message stream.
function useSessionStream(taskId: string, sessionId: string | null) {
  const client = useQueryClient();
  useEffect(() => {
    if (!sessionId) return;
    return streamMessages(taskId, sessionId, (event) =>
      client.setQueryData<Session>(
        ["session", taskId, sessionId],
        (old) => old && withEvent(old, event),
      ),
    );
  }, [client, taskId, sessionId]);
}

function OutputText({ text }: { text: string }) {
  const fields = parseJsonObject(text);
  if (!fields) return <div className="prompt-preview">{text}</div>;
  return (
    <dl className="output-fields">
      {Object.entries(fields).map(([key, value]) => (
        <div key={key}>
          <dt className="section-overline">{key.toUpperCase()}</dt>
          <dd className="prompt-preview">
            {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function LastOutput({
  taskId,
  latest,
  loading,
  onOpen,
}: {
  taskId: string;
  latest?: SessionSummary;
  loading: boolean;
  onOpen: (sessionId: string) => void;
}) {
  const sessionId = latest?.id ?? null;
  const session = useQuery({
    queryKey: ["session", taskId, sessionId],
    queryFn: () => api.session(taskId, sessionId!),
    enabled: !!sessionId,
  });
  useSessionStream(taskId, sessionId);
  if (loading || (sessionId && session.isPending))
    return <Loading label="Loading output…" />;
  if (!latest)
    return (
      <Empty icon={<Terminal size={25} />} title="No output yet">
        Run this task to create a session. Its last answer appears here.
      </Empty>
    );
  if (session.isError)
    return (
      <ErrorBox error={session.error} retry={() => void session.refetch()} />
    );
  const output = lastOutput(session.data!.events);
  return (
    <>
      <div className="session-detail-title">
        <h3>Last output</h3>
        <button className="back-link" onClick={() => onOpen(latest.id)}>
          View session
          <ArrowRight size={14} />
        </button>
      </div>
      {output ? (
        <>
          <OutputText text={output.text} />
          <p className="session-time">
            <Clock3 size={12} />
            {formatTime(output.timestamp ?? latest.lastUpdateTime)}
          </p>
        </>
      ) : (
        <Empty icon={<Terminal size={25} />} title="No answer yet">
          The latest session has not produced a text answer. It may still be
          running.
        </Empty>
      )}
    </>
  );
}

function InspectorShell({
  eyebrow,
  label,
  onClose,
  children,
}: {
  eyebrow: string;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const { width, dragging, handle } = useResizableWidth();
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="inspector"
      aria-labelledby="inspector-title"
      onClose={onClose}
      style={
        width ? ({ "--inspector-w": `${width}px` } as React.CSSProperties) : {}
      }
    >
      <div className="inspector-resize">
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${label}`}
          tabIndex={0}
          data-dragging={dragging}
          {...handle}
        />
      </div>
      <div className="inspector-top">
        <span className="eyebrow">{eyebrow}</span>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Close ${label}`}
          onClick={() => ref.current?.close()}
        >
          <X size={19} />
        </Button>
      </div>
      {children}
    </dialog>
  );
}

function TaskInspector({
  taskId,
  onClose,
  onRun,
  running,
  notice,
  onDismissNotice,
}: {
  taskId: string;
  onClose: () => void;
  onRun: () => void;
  running: boolean;
  notice: Notice | null;
  onDismissNotice: () => void;
}) {
  const [tab, setTab] = useState<"sessions" | "output" | "prompt">("sessions");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const task = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => api.task(taskId),
  });
  const sessions = useQuery({
    queryKey: ["sessions", taskId],
    queryFn: () => api.sessions(taskId),
    enabled: !!task.data,
    refetchInterval: tab === "output" ? 5000 : false,
  });
  const detail = useQuery({
    queryKey: ["session", taskId, sessionId],
    queryFn: () => api.session(taskId, sessionId!),
    enabled: !!sessionId,
  });
  useSessionStream(taskId, tab === "sessions" ? sessionId : null);
  useEffect(() => {
    setSessionId(null);
    setTab("sessions");
  }, [taskId]);
  const list = [...(sessions.data?.sessions ?? [])].sort(
    (a, b) => b.lastUpdateTime - a.lastUpdateTime,
  );
  return (
    <InspectorShell
      eyebrow="TASK DETAILS"
      label="task details"
      onClose={onClose}
    >
      {task.isPending ? (
        <Loading label="Loading task…" />
      ) : task.isError ? (
        <ErrorBox error={task.error} retry={() => void task.refetch()} />
      ) : (
        <>
          <div className="inspector-heading">
            <span className="task-detail-icon">
              <FileText size={24} />
            </span>
            <h2 id="inspector-title">{task.data.prompt}</h2>
            <div className="task-id">
              <code>{taskId}</code>
              <CopyButton value={taskId} />
            </div>
            <div className="task-detail-meta">
              <span className="job-chip">
                <Box size={12} />
                {task.data.jobName ?? "Unassigned job"}
              </span>
              <span
                className={`job-chip ${task.data.agentName ? "" : "chip-muted"}`}
                title="Agent that runs this task"
              >
                <Workflow size={12} />
                {task.data.agentName ?? "Default agent"}
              </span>
              <Button
                size="sm"
                onClick={onRun}
                disabled={!task.data.jobName || running}
              >
                {running ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Play size={13} />
                )}
                Run task
              </Button>
            </div>
          </div>
          <div
            className="inspector-tabs"
            role="tablist"
            aria-label="Task detail sections"
          >
            <button
              role="tab"
              aria-selected={tab === "sessions"}
              onClick={() => setTab("sessions")}
            >
              <Terminal size={15} />
              Sessions<span>{list.length}</span>
            </button>
            <button
              role="tab"
              aria-selected={tab === "output"}
              onClick={() => setTab("output")}
            >
              <Sparkles size={15} />
              Output
            </button>
            <button
              role="tab"
              aria-selected={tab === "prompt"}
              onClick={() => setTab("prompt")}
            >
              <FileText size={15} />
              Prompt
            </button>
          </div>
          <div className="inspector-body" role="tabpanel">
            {notice && (
              <div
                className={`inspector-notice ${notice.error ? "notice-error" : ""}`}
                role={notice.error ? "alert" : "status"}
              >
                {notice.error ? <CircleAlert size={17} /> : <Check size={17} />}
                <div>
                  <strong>{notice.title}</strong>
                  <p>{notice.message}</p>
                </div>
                <button
                  aria-label="Dismiss notification"
                  onClick={onDismissNotice}
                >
                  <X size={14} />
                </button>
              </div>
            )}
            {tab === "output" ? (
              <LastOutput
                taskId={taskId}
                latest={list[0]}
                loading={sessions.isPending}
                onOpen={(id) => {
                  setSessionId(id);
                  setTab("sessions");
                }}
              />
            ) : tab === "prompt" ? (
              <>
                <p className="section-overline">SAVED PROMPT</p>
                <div className="prompt-preview">{task.data.prompt}</div>
              </>
            ) : sessionId ? (
              <>
                <button
                  className="back-link"
                  onClick={() => setSessionId(null)}
                >
                  <ArrowLeft size={14} />
                  All sessions
                </button>
                {detail.isPending ? (
                  <Loading label="Loading session…" />
                ) : detail.isError ? (
                  <ErrorBox
                    error={detail.error}
                    retry={() => void detail.refetch()}
                  />
                ) : (
                  <>
                    <div className="session-detail-title">
                      <h3>Session activity</h3>
                      <span>{detail.data.events.length} events</span>
                      <DeleteSession
                        taskId={taskId}
                        sessionId={detail.data.id}
                        onDeleted={() => setSessionId(null)}
                      />
                    </div>
                    <div className="task-id session-id">
                      <code>{detail.data.id}</code>
                      <CopyButton value={detail.data.id} />
                    </div>
                    <SessionStatsBar
                      taskId={taskId}
                      sessionId={detail.data.id}
                      events={detail.data.events.length}
                    />
                    <p className="session-time">
                      <Clock3 size={12} />
                      Updated {formatTime(detail.data.lastUpdateTime)}
                    </p>
                    <details className="state-box">
                      <summary>
                        <Database size={14} />
                        Session state
                        <span>
                          {Object.keys(detail.data.state).length} keys
                        </span>
                      </summary>
                      <pre>{JSON.stringify(detail.data.state, null, 2)}</pre>
                    </details>
                    {detail.data.events.length ? (
                      <div className="event-timeline">
                        {detail.data.events.map((event, i) => (
                          <EventCard
                            key={event.id ?? i}
                            event={event}
                            index={i}
                          />
                        ))}
                      </div>
                    ) : (
                      <Empty
                        icon={<Terminal size={25} />}
                        title="No events yet"
                      >
                        Events will appear here as the agent works.
                      </Empty>
                    )}
                    <ContinueSession
                      taskId={taskId}
                      sessionId={detail.data.id}
                    />
                  </>
                )}
              </>
            ) : (
              <>
                <div className="sessions-heading">
                  <div>
                    <p className="section-overline">EXECUTION SESSIONS</p>
                    <p>Each attempt has its own conversation.</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => void sessions.refetch()}
                    aria-label="Refresh sessions"
                    disabled={sessions.isFetching}
                  >
                    <RefreshCw
                      size={15}
                      className={sessions.isFetching ? "animate-spin" : ""}
                    />
                  </Button>
                </div>
                {sessions.isPending ? (
                  <Loading label="Loading sessions…" />
                ) : sessions.isError ? (
                  <ErrorBox
                    error={sessions.error}
                    retry={() => void sessions.refetch()}
                  />
                ) : !list.length ? (
                  <Empty
                    icon={<Terminal size={27} />}
                    title="The conversation starts with a run"
                  >
                    Run this task to create a session. New sessions appear
                    automatically when the agent starts.
                  </Empty>
                ) : (
                  <div className="sessions-list">
                    {list.map((session, i) => (
                      <button
                        key={session.id}
                        className="session-list-item"
                        onClick={() => setSessionId(session.id)}
                      >
                        <span className="session-icon">
                          <Terminal size={17} />
                        </span>
                        <span>
                          <strong>Session {session.id.slice(0, 8)}</strong>
                          <small>{formatTime(session.lastUpdateTime)}</small>
                        </span>
                        {i === 0 && (
                          <span className="badge violet-badge">Latest</span>
                        )}
                        <ChevronRight size={16} />
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </InspectorShell>
  );
}

function EventCard({ event, index }: { event: SessionEvent; index: number }) {
  const parts = event.content?.parts ?? [];
  return (
    <article
      className={`event-card ${event.errorMessage ? "event-error" : ""}`}
    >
      <div className="event-marker">
        <span>
          {event.author === "user" ? (
            <ArrowRight size={12} />
          ) : (
            <Sparkles size={12} />
          )}
        </span>
      </div>
      <div className="event-header">
        <strong>{event.author ?? event.content?.role ?? "Event"}</strong>
        <span>
          {event.timestamp ? formatTime(event.timestamp) : `Event ${index + 1}`}
        </span>
      </div>
      {event.errorMessage && (
        <p className="event-error-message">{event.errorMessage}</p>
      )}
      {parts.map((part, i) => (
        <div key={i}>
          {part.text != null && (
            <div
              className={`event-text ${part.thought ? "event-thought" : ""}`}
            >
              {part.thought && <span className="thought-label">Reasoning</span>}
              {part.text}
            </div>
          )}
          {part.functionCall && (
            <details className="tool-event" open>
              <summary>
                <Workflow size={13} />
                {part.functionCall.name ?? "Tool call"}
              </summary>
              <pre>{JSON.stringify(part.functionCall.args ?? {}, null, 2)}</pre>
            </details>
          )}
          {part.functionResponse && (
            <details className="tool-event">
              <summary>
                <Check size={13} />
                {part.functionResponse.name ?? "Tool response"}
              </summary>
              <pre>
                {JSON.stringify(part.functionResponse.response ?? {}, null, 2)}
              </pre>
            </details>
          )}
        </div>
      ))}
      <details className="raw-event">
        <summary>Raw event</summary>
        <pre>{JSON.stringify(event, null, 2)}</pre>
      </details>
    </article>
  );
}
