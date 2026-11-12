export type Task = {
  taskId: string;
  prompt: string;
  jobName?: string;
  agentName?: string;
};
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
export type JsonSchema = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: unknown[];
};
export type AgentInfo = {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
};
export type SessionStats = {
  events: number;
  llmCalls: number;
  tokens: {
    prompt: number;
    candidates: number;
    thoughts: number;
    toolUsePrompt: number;
    cached: number;
    total: number;
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
  if (response.status === 204) return undefined as T;
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
  create: (input: { prompt: string; jobName: string; agentName?: string }) =>
    request<Task>("/tasks", json(input)),
  run: (id: string) =>
    request<{ operation: string }>(`${taskPath(id)}/run`, { method: "POST" }),
  resume: (taskId: string, sessionId: string, message: string) =>
    request<{ operation: string }>(
      `${taskPath(taskId)}/run`,
      json({ sessionId, message }),
    ),
  registerAgents: (jobName: string) =>
    request<{ operation: string }>(
      `/jobs/${encodeURIComponent(jobName)}/register`,
      { method: "POST" },
    ),
  agents: (jobName: string) =>
    request<{ agents: AgentInfo[] }>(
      `/jobs/${encodeURIComponent(jobName)}/agents`,
    ),
  stats: (taskId: string, sessionId: string) =>
    request<SessionStats>(
      `${taskPath(taskId)}/sessions/${encodeURIComponent(sessionId)}/stats`,
    ),
  deleteSession: (taskId: string, sessionId: string) =>
    request<void>(
      `${taskPath(taskId)}/sessions/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
    ),
  sessions: (id: string) =>
    request<{ sessions: SessionSummary[] }>(`${taskPath(id)}/sessions`),
  session: (taskId: string, sessionId: string) =>
    request<Session>(
      `${taskPath(taskId)}/sessions/${encodeURIComponent(sessionId)}`,
    ),
};
// Opens the session message stream (SSE); the server replays stored events
// first, so callers must tolerate duplicates. Returns a function that closes it.
export const streamMessages = (
  taskId: string,
  sessionId: string,
  onEvent: (event: SessionEvent) => void,
) => {
  const source = new EventSource(
    `${taskPath(taskId)}/sessions/${encodeURIComponent(sessionId)}/messages`,
  );
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as SessionEvent);
    } catch {
      // Ignore a malformed message; the periodic refetch still has the event.
    }
  };
  return () => source.close();
};
export const withEvent = (session: Session, event: SessionEvent): Session =>
  event.id && session.events.some((e) => e.id === event.id)
    ? session
    : {
        ...session,
        events: [...session.events, event],
        lastUpdateTime: event.timestamp ?? session.lastUpdateTime,
      };
// The last text the agent produced: the newest non-user event with visible
// text and no tool call or tool result.
export const lastOutput = (events: SessionEvent[]) => {
  for (const event of [...events].reverse()) {
    if (event.author === "user" || event.content?.role === "user") continue;
    const parts = event.content?.parts ?? [];
    if (parts.some((p) => p.functionCall || p.functionResponse)) continue;
    const text = parts
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join("")
      .trim();
    if (text) return { text, timestamp: event.timestamp };
  }
};
// A short human description of a JSON Schema: its own description for plain
// values, otherwise its shape, e.g. "{ city: string, days: number }".
export const schemaSummary = (schema?: JsonSchema): string => {
  if (!schema) return "Not described";
  const type = [schema.type].flat().join(" | ");
  if (schema.properties)
    return `{ ${Object.entries(schema.properties)
      .map(([key, value]) => `${key}: ${schemaSummary(value)}`)
      .join(", ")} }`;
  if (schema.items) return `${schemaSummary(schema.items)}[]`;
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  return type || "any";
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
