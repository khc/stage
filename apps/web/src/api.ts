export type Task = {
  taskId: string;
  prompt: string;
  jobName?: string;
  agentName?: string;
  documents?: { documentId: string }[];
};
export type DocumentSummary = {
  documentId: string;
  filename: string;
  checksum: string;
  contentType: string;
};
// Cloud Run timestamps and durations arrive as { seconds, nanos }.
export type Timestamp = {
  seconds?: string | number | null;
  nanos?: number | null;
} | null;
export type Job = {
  name?: string;
  description?: string;
  uid?: string;
  createTime?: Timestamp;
  updateTime?: Timestamp;
  executionCount?: number;
  terminalCondition?: { state?: string; message?: string } | null;
  latestCreatedExecution?: { name?: string; createTime?: Timestamp } | null;
  template?: {
    taskCount?: number;
    parallelism?: number;
    template?: {
      // Variable values are deliberately not typed: the UI shows names only.
      containers?: {
        image?: string;
        env?: { name?: string }[];
        resources?: { limits?: Record<string, string> } | null;
      }[];
      maxRetries?: number;
      timeout?: Timestamp;
      serviceAccount?: string;
      executionEnvironment?: string;
    };
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
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  title?: string;
  minimum?: number;
  maximum?: number;
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
  job_error: "Cloud Run could not complete the request. Check the job configuration and try again.",
  task_error: "Tasks could not be loaded. Check the service connection and try again.",
  session_error: "Sessions could not be loaded. Try again in a moment.",
  document_error: "Documents could not be loaded or saved. Try again in a moment.",
  document_not_found: "This document could not be found for this task.",
  file_required: "Choose a file to upload.",
  file_too_large: "This file is too large to upload (25 MB maximum).",
  document_too_large: "The text extracted from this file is too large to store.",
  extraction_failed: "The content of this file could not be extracted.",
  not_supported: "Document upload is not configured on the server.",
};
export async function request<T>(path: string, options?: RequestInit): Promise<T> {
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
  run: (id: string) => request<{ operation: string }>(`${taskPath(id)}/run`, { method: "POST" }),
  resume: (taskId: string, sessionId: string, message: string) =>
    request<{ operation: string }>(`${taskPath(taskId)}/run`, json({ sessionId, message })),
  registerAgents: (jobName: string) =>
    request<{ operation: string }>(`/jobs/${encodeURIComponent(jobName)}/register`, {
      method: "POST",
    }),
  agents: (jobName: string) =>
    request<{ agents: AgentInfo[] }>(`/jobs/${encodeURIComponent(jobName)}/agents`),
  stats: (taskId: string, sessionId: string) =>
    request<SessionStats>(`${taskPath(taskId)}/sessions/${encodeURIComponent(sessionId)}/stats`),
  deleteTask: (id: string) => request<void>(taskPath(id), { method: "DELETE" }),
  deleteSession: (taskId: string, sessionId: string) =>
    request<void>(`${taskPath(taskId)}/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    }),
  documents: (id: string) => request<{ documents: DocumentSummary[] }>(`${taskPath(id)}/documents`),
  uploadDocument: (id: string, file: File) => {
    const body = new FormData();
    body.set("file", file);
    return request<DocumentSummary>(`${taskPath(id)}/documents`, { method: "POST", body });
  },
  deleteDocument: (id: string, documentId: string) =>
    request<void>(`${taskPath(id)}/documents/${encodeURIComponent(documentId)}`, {
      method: "DELETE",
    }),
  sessions: (id: string) => request<{ sessions: SessionSummary[] }>(`${taskPath(id)}/sessions`),
  session: (taskId: string, sessionId: string) =>
    request<Session>(`${taskPath(taskId)}/sessions/${encodeURIComponent(sessionId)}`),
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
  source.addEventListener("message", (message) => {
    try {
      onEvent(JSON.parse(message.data) as SessionEvent);
    } catch {
      // Ignore a malformed message; the periodic refetch still has the event.
    }
  });
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
  for (const event of events.toReversed()) {
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
// One row per top-level property of an object schema, for showing each
// field's type, whether it is required and its description.
export const schemaRows = (schema?: JsonSchema) =>
  Object.entries(schema?.properties ?? {}).map(([name, value]) => ({
    name,
    type: schemaSummary(value),
    required: !!schema?.required?.includes(name),
    description: value.description,
  }));
export const parseJsonObject = (text: string) => {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};
const isStructured = (schema?: JsonSchema) => schema?.type === "object";
// An example message for a structured input schema, e.g. {"topic": ""}.
export const inputExample = (schema?: JsonSchema) =>
  isStructured(schema)
    ? JSON.stringify(
        Object.fromEntries(Object.keys(schema?.properties ?? {}).map((key) => [key, ""])),
      )
    : undefined;
// A structured agent with no properties takes no input: its message is {}.
export const takesNoInput = (schema?: JsonSchema) =>
  isStructured(schema) && !Object.keys(schema?.properties ?? {}).length;
// Structured agents take a JSON message; text agents take anything.
export const promptError = (schema: JsonSchema | undefined, prompt: string) => {
  if (!isStructured(schema) || !prompt.trim()) return undefined;
  const value = parseJsonObject(prompt);
  if (!value) return "This agent expects a JSON object as its prompt.";
  const missing = (schema?.required ?? []).filter((key) => !(key in value));
  return missing.length
    ? `Missing required field${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`
    : undefined;
};
const timestampMs = (t?: Timestamp) =>
  t?.seconds == null ? undefined : Number(t.seconds) * 1000 + Math.floor((t.nanos ?? 0) / 1e6);
const formatDuration = (t?: Timestamp) => {
  const seconds = t?.seconds == null ? undefined : Number(t.seconds);
  if (seconds == null) return undefined;
  if (seconds % 3600 === 0 && seconds) return `${seconds / 3600}h`;
  if (seconds % 60 === 0 && seconds) return `${seconds / 60}m`;
  return `${seconds}s`;
};
const when = (t?: Timestamp) => {
  const ms = timestampMs(t);
  return ms === undefined ? undefined : formatTime(ms);
};
const conditionLabel = (state?: string) =>
  state === "CONDITION_SUCCEEDED" ? "Ready" : state?.replace("CONDITION_", "").toLowerCase();
export const jobEnvNames = (job: Job) =>
  (job.template?.template?.containers?.[0]?.env ?? []).flatMap((e) => (e.name ? [e.name] : []));
// Label/value rows for a job's detail pane; unknown fields are left out.
export const jobDetails = (job: Job): [string, string][] => {
  const task = job.template?.template;
  const container = task?.containers?.[0];
  const limits = container?.resources?.limits;
  const rows: [string, string | undefined][] = [
    ["Status", conditionLabel(job.terminalCondition?.state)],
    ["Image", container?.image],
    ["Tasks per execution", job.template?.taskCount?.toString()],
    ["Parallelism", job.template?.parallelism ? String(job.template.parallelism) : "Default"],
    ["Max retries", task?.maxRetries?.toString()],
    ["Timeout", formatDuration(task?.timeout)],
    ["CPU", limits?.cpu],
    ["Memory", limits?.memory],
    ["Service account", task?.serviceAccount || "Default"],
    ["Environment", task?.executionEnvironment?.replace("EXECUTION_ENVIRONMENT_", "")],
    ["Created", when(job.createTime)],
    ["Updated", when(job.updateTime)],
    ["Executions", job.executionCount?.toString()],
    ["Latest execution", job.latestCreatedExecution?.name || undefined],
  ];
  return rows.filter((row): row is [string, string] => !!row[1]);
};
export type FormField = {
  key: string;
  label: string;
  description?: string;
  required: boolean;
  kind: "string" | "number" | "boolean" | "enum" | "json";
  options?: string[];
  integer?: boolean;
  min?: number;
  max?: number;
};
export type FormValues = Record<string, string | boolean>;

// Fields for a structured input schema: one per top-level property. Plain
// strings, numbers, booleans and enums get their own control; anything
// nested falls back to a JSON field. Undefined when the schema is not an
// object with properties (those agents take a free-text prompt).
const toField = (key: string, value: JsonSchema, schema: JsonSchema): FormField => {
  const type = [value.type].flat()[0];
  const base = {
    key,
    label: value.title ?? key,
    description: value.description,
    required: !!schema.required?.includes(key),
  };
  if (value.enum && value.enum.every((o) => typeof o === "string"))
    return { ...base, kind: "enum", options: value.enum as string[] };
  if (type === "string") return { ...base, kind: "string" };
  if (type === "number" || type === "integer")
    return {
      ...base,
      kind: "number",
      integer: type === "integer",
      min: value.minimum,
      max: value.maximum,
    };
  if (type === "boolean") return { ...base, kind: "boolean" };
  return { ...base, kind: "json" };
};
export const schemaFields = (schema?: JsonSchema): FormField[] | undefined => {
  if (!isStructured(schema) || !schema?.properties) return undefined;
  const fields = Object.entries(schema.properties).map(([key, value]) =>
    toField(key, value, schema),
  );
  return fields.length ? fields : undefined;
};
// The JSON message for the field values, or the first problem with them.
export const buildPrompt = (
  fields: FormField[],
  values: FormValues,
): { prompt: string } | { error: string } => {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = values[field.key];
    if (field.kind === "boolean") {
      result[field.key] = raw === true;
      continue;
    }
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) {
      if (field.required) return { error: `${field.label} is required.` };
      continue;
    }
    if (field.kind === "number") {
      const number = Number(text);
      if (!Number.isFinite(number) || (field.integer && !Number.isInteger(number)))
        return {
          error: `${field.label} must be ${field.integer ? "a whole number" : "a number"}.`,
        };
      if (field.min !== undefined && number < field.min)
        return { error: `${field.label} must be at least ${field.min}.` };
      if (field.max !== undefined && number > field.max)
        return { error: `${field.label} must be at most ${field.max}.` };
      result[field.key] = number;
    } else if (field.kind === "json") {
      try {
        result[field.key] = JSON.parse(text);
      } catch {
        return { error: `${field.label} must be valid JSON.` };
      }
    } else {
      result[field.key] = field.kind === "string" ? raw : text;
    }
  }
  return { prompt: JSON.stringify(result) };
};
export const shortJobName = (job: Job) => job.name?.split("/").at(-1) ?? "Unnamed job";
// ADK records event/session timestamps in milliseconds in this repository.
export const formatTime = (timestamp: number) =>
  new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
