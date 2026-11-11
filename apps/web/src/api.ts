export type Task = { taskId: string; prompt: string; jobName?: string };
export type Job = {
  name?: string;
  description?: string;
  uid?: string;
  createTime?: string;
  template?: {
    taskCount?: number;
    template?: { containers?: { image?: string }[] };
  };
};
export type SessionSummary = {
  id: string;
  taskId: string;
  appName: string;
  userId: string;
  lastUpdateTime: number;
};
export type SessionEvent = {
  id?: string;
  author?: string;
  timestamp?: number;
  errorMessage?: string;
  content?: {
    role?: string;
    parts?: {
      text?: string;
      thought?: boolean;
      functionCall?: { name?: string; args?: unknown };
      functionResponse?: { name?: string; response?: unknown };
    }[];
  };
};
export type Session = SessionSummary & {
  state: Record<string, unknown>;
  events: SessionEvent[];
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
const messages: Record<string, string> = {
  task_not_found: "This task could not be found.",
  task_not_executable: "This task needs a valid job name before it can run.",
  session_not_found: "This session could not be found for this task.",
  job_error:
    "Cloud Run could not complete the request. Check the job configuration and try again.",
  task_error:
    "Tasks could not be loaded. Check the service connection and try again.",
  session_error: "Sessions could not be loaded. Try again in a moment.",
};
export async function request<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(path, options);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: unknown;
    } | null;
    const code = typeof body?.error === "string" ? body.error : "";
    throw new ApiError(
      response.status,
      messages[code] ??
        (response.status === 400
          ? "Check the entered values and try again."
          : `Request failed (${response.status}). Please try again.`),
    );
  }
  return response.json() as Promise<T>;
}
const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const taskPath = (id: string) => `/tasks/${encodeURIComponent(id)}`;
export const api = {
  health: () => request<{ status: string }>("/health"),
  tasks: () => request<{ tasks: Task[] }>("/tasks"),
  jobs: () => request<{ jobs: Job[] }>("/jobs"),
  task: (id: string) => request<Task>(taskPath(id)),
  create: (input: { prompt: string; jobName: string }) =>
    request<Task>("/tasks", json(input)),
  run: (id: string) =>
    request<{ operation: string }>(`${taskPath(id)}/run`, { method: "POST" }),
  sessions: (id: string) =>
    request<{ sessions: SessionSummary[] }>(`${taskPath(id)}/sessions`),
  session: (taskId: string, sessionId: string) =>
    request<Session>(
      `${taskPath(taskId)}/sessions/${encodeURIComponent(sessionId)}`,
    ),
};
export const shortJobName = (job: Job) =>
  job.name?.split("/").at(-1) ?? "Unnamed job";
// ADK records event/session timestamps in milliseconds in this repository.
export const formatTime = (timestamp: number) =>
  new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
