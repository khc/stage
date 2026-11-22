import { treaty } from "@elysiajs/eden";
import type { App } from "@stage/control-service/app";

import { parseSse } from "./sse";
import type { EvalEvent, RunSummary } from "./trace";

export type RunMode = "quick" | "workflow";
export type TaskSummary = { taskId: string; name?: string; parentTaskId?: string };
export type ModelRef = { providerId: string; model: string };
export type ProviderSummary = { providerId: string; name: string };
// A 202 carries `sessionId` only when the run created the session; a resume's has none.
export type RunResult = { status: 202; sessionId?: string } | { status: 409; error: string };
export type SessionView = { run?: RunSummary; events: EvalEvent[] };

export type EvalApi = {
  health: () => Promise<void>;
  createTask: (input: {
    name: string;
    prompt: string;
    jobName: string;
    agentName: string;
    defaultModel?: ModelRef;
  }) => Promise<{ taskId: string }>;
  listTasks: () => Promise<TaskSummary[]>;
  listProviders: () => Promise<ProviderSummary[]>;
  run: (
    taskId: string,
    input: { message: string; sessionId?: string; mode?: RunMode },
  ) => Promise<RunResult>;
  getSession: (taskId: string, sessionId: string) => Promise<SessionView>;
  streamEvents: (
    taskId: string,
    sessionId: string,
    signal: AbortSignal,
  ) => AsyncIterable<EvalEvent>;
  deleteTask: (taskId: string) => Promise<void>;
};

const RUN_STATUSES = new Set(["running", "succeeded", "failed"]);

// The session route's response schema is open, so the body is checked here instead of trusted.
export const toSessionView = (body: unknown): SessionView => {
  const { events, run } = (body ?? {}) as { events?: unknown; run?: Partial<RunSummary> };
  if (!Array.isArray(events)) throw new Error("session body has no events array");
  if (run === undefined) return { events: events as EvalEvent[] };
  if (!run.status || !RUN_STATUSES.has(run.status) || typeof run.startedAt !== "number")
    throw new Error(`session body has an unknown run: ${JSON.stringify(run)}`);
  return { events: events as EvalEvent[], run: run as RunSummary };
};

type Reply = { data: unknown; error: { status: unknown; value: unknown } | null; status: number };

const errorCode = (reply: Reply) => {
  const body = reply.error?.value as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `status ${reply.status}`;
};

const ok = <R extends Reply>(what: string, reply: R): NonNullable<R["data"]> => {
  if (reply.error) throw new Error(`${what} failed: ${errorCode(reply)}`);
  return reply.data as NonNullable<R["data"]>;
};

// Eden does not encode path parameters, and a session id may hold any character.
const enc = encodeURIComponent;

export const createApiClient = (baseUrl: string): EvalApi => {
  const client = treaty<App>(baseUrl);
  const task = (taskId: string) => client.tasks({ taskId: enc(taskId) });
  const session = (taskId: string, sessionId: string) =>
    task(taskId).sessions({ sessionId: enc(sessionId) });

  return {
    health: async () => {
      ok("health", await client.health.get());
    },
    createTask: async (input) => {
      const created = ok("createTask", await client.tasks.post(input));
      return { taskId: created.taskId };
    },
    listTasks: async () => ok("listTasks", await client.tasks.get()).tasks,
    // Only the id and the name: the provider documents hold more than the evals need.
    listProviders: async () =>
      ok("listProviders", await client.providers.get()).providers.map(({ providerId, name }) => ({
        providerId,
        name,
      })),
    run: async (taskId, input) => {
      const reply = await task(taskId).run.post(input);
      if (reply.status === 202) {
        const body = reply.data as { sessionId?: string } | null;
        return { status: 202, ...(body?.sessionId && { sessionId: body.sessionId }) };
      }
      if (reply.status === 409) return { status: 409, error: errorCode(reply) };
      throw new Error(`run failed: ${errorCode(reply)}`);
    },
    getSession: async (taskId, sessionId) =>
      toSessionView(ok("getSession", await session(taskId, sessionId).get())),
    async *streamEvents(taskId, sessionId, signal) {
      const url = `${baseUrl}/tasks/${enc(taskId)}/sessions/${enc(sessionId)}/messages`;
      const response = await fetch(url, { signal, headers: { accept: "text/event-stream" } });
      if (!response.ok || !response.body)
        throw new Error(`streamEvents failed: status ${response.status}`);
      for await (const message of parseSse(response.body)) {
        if (message.event === "keepalive" || !message.data) continue;
        yield JSON.parse(message.data) as EvalEvent;
      }
    },
    deleteTask: async (taskId) => {
      ok("deleteTask", await task(taskId).delete());
    },
  };
};
