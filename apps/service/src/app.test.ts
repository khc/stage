import { describe, expect, spyOn, test } from "bun:test";

import { createApp, type AppDeps } from "./app";
import { DependencyError } from "./errors";
import type { AgentsService } from "./modules/agents/agents-service";
import type { EventsService } from "./modules/events/events-service";
import type { DocumentsService } from "./modules/tasks/documents/documents-service";
import type { SessionsService } from "./modules/tasks/sessions/sessions-service";
import type { TasksService } from "./modules/tasks/tasks-service";

const task = {
  taskId: "5f4c3d1e-9b0a-4d2e-8a37-1c6f2b9e7a10",
  prompt: "hi",
  jobName: "my-job",
  documents: [],
};
const tasksService = (overrides: Partial<TasksService> = {}): TasksService => ({
  create: async (input) => ({ status: "created", task: { ...task, ...input } }),
  list: async () => [task],
  get: async (id) => (id === task.taskId ? task : undefined),
  delete: async (id) => (id === task.taskId ? "deleted" : "not_found"),
  run: async (id) =>
    id === task.taskId ? { status: "started", operation: "op-1" } : { status: "task_not_found" },
  ...overrides,
});
const session = {
  id: "s1",
  appName: "app",
  userId: "user",
  lastUpdateTime: 1,
  taskId: task.taskId,
};
const sessionsService = (overrides: Partial<SessionsService> = {}): SessionsService => ({
  list: async (taskId) => (taskId === task.taskId ? [session] : []),
  get: async (taskId, id) =>
    taskId === task.taskId && id === "s1"
      ? ({ ...session, state: {}, events: [] } as never)
      : undefined,
  stats: async (taskId, id) =>
    taskId === task.taskId && id === "s1"
      ? {
          events: 0,
          llmCalls: 0,
          tokens: { prompt: 0, candidates: 0, thoughts: 0, toolUsePrompt: 0, cached: 0, total: 0 },
        }
      : undefined,
  delete: async (taskId, id) => taskId === task.taskId && id === "s1",
  messages: async (taskId, id) =>
    taskId === task.taskId && id === "s1"
      ? {
          status: "ok",
          entries: (async function* () {
            yield { id: "e1", data: '{"id":"e1"}' };
            yield "idle" as const;
          })(),
        }
      : { status: "session_not_found" },
  ...overrides,
});
const doc = {
  documentId: "a".repeat(64),
  filename: "a.txt",
  checksum: "a".repeat(64),
  contentType: "text/plain",
};
const documentsService = (overrides: Partial<DocumentsService> = {}): DocumentsService => ({
  list: async (taskId) => (taskId === task.taskId ? [doc] : []),
  get: async (taskId, id) =>
    taskId === task.taskId && id === doc.documentId ? { ...doc, content: "hi" } : undefined,
  create: async () => ({ status: "created", document: doc }),
  delete: async (taskId, id) => taskId === task.taskId && id === doc.documentId,
  ...overrides,
});
const agentsService = (overrides: Partial<AgentsService> = {}): AgentsService => ({
  listJobs: async () => [{ name: "projects/p/locations/l/jobs/poet-agents" }],
  listAgents: async (jobName) => (jobName === "poet-agents" ? [{ name: "haiku" }] : []),
  agentCard: async (jobName, agentName) =>
    jobName === "poet-agents" && agentName === "haiku"
      ? ({ name: "haiku", url: "x" } as never)
      : undefined,
  register: async () => "operations/op-1",
  ...overrides,
});
const appWith = (
  overrides: Partial<TasksService> = {},
  sessionOverrides: Partial<SessionsService> = {},
  documents: Partial<DocumentsService> | null = {},
  extras: { agents?: Partial<AgentsService>; events?: EventsService } = {},
) => {
  const deps: AppDeps = {
    healthService: { check: () => ({ status: "ok" }) },
    tasksService: tasksService(overrides),
    sessionsService: sessionsService(sessionOverrides),
    ...(documents && { documentsService: documentsService(documents) }),
    agentsService: agentsService(extras.agents),
    ...(extras.events && { eventsService: extras.events }),
  };
  return createApp(deps);
};
const call = async (app: ReturnType<typeof createApp>, path: string, init?: RequestInit) => {
  const res = await app.handle(new Request(`http://localhost${path}`, init));
  return { status: res.status, body: await res.json().catch(() => null) };
};
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("GET /health", () => {
  test("answers ok from the health service", async () => {
    expect(await call(appWith(), "/health")).toEqual({ status: 200, body: { status: "ok" } });
  });

  test("a response that breaks its schema is a service bug: 502 internal_error", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    const app = createApp({
      healthService: { check: () => ({ status: "down" }) as never },
      tasksService: tasksService(),
      sessionsService: sessionsService(),
      agentsService: agentsService(),
    });
    expect(await call(app, "/health")).toEqual({ status: 502, body: { error: "internal_error" } });
    spy.mockRestore();
  });
});

describe("tasks", () => {
  test("POST /tasks creates a task and trims the prompt", async () => {
    const res = await call(appWith(), "/tasks", json({ prompt: "  hello  ", jobName: "my-job" }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ prompt: "hello", jobName: "my-job" });
  });

  test("POST /tasks answers 400 unknown_agent", async () => {
    const app = appWith({ create: async () => ({ status: "unknown_agent" }) });
    expect(await call(app, "/tasks", json({ prompt: "p", jobName: "j", agentName: "x" }))).toEqual({
      status: 400,
      body: { error: "unknown_agent" },
    });
  });

  test("a body that claims to be JSON but is not answers 400 invalid_request, not a server error", async () => {
    const res = await call(appWith(), "/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json {",
    });
    expect(res).toEqual({ status: 400, body: { error: "invalid_request" } });
  });

  test("a validation failure lists where and why, without the schema or the offending value", async () => {
    const res = await call(
      appWith(),
      "/tasks",
      json({ prompt: "x".repeat(10_001), jobName: "my-job" }),
    );
    expect(res.status).toBe(400);
    const body = res.body as { error: string; details: Record<string, unknown>[] };
    expect(body.error).toBe("invalid_request");
    expect(body.details).toEqual([{ path: "/prompt", message: expect.any(String) }]);
    expect(JSON.stringify(body)).not.toContain("xxxxxxxxxx");
  });

  test.each([
    ["a blank prompt", { prompt: "   ", jobName: "my-job" }],
    ["a missing jobName", { prompt: "p" }],
    ["an invalid jobName", { prompt: "p", jobName: "Bad_Name" }],
    ["an invalid agentName", { prompt: "p", jobName: "j", agentName: "1bad" }],
  ])("POST /tasks rejects %s with 400", async (_name, body) => {
    const res = await call(appWith(), "/tasks", json(body));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_request" });
  });

  test("GET /tasks lists tasks", async () => {
    expect(await call(appWith(), "/tasks")).toEqual({ status: 200, body: { tasks: [task] } });
  });

  test("GET /tasks/:taskId returns the task, and matches the id case-insensitively", async () => {
    expect((await call(appWith(), `/tasks/${task.taskId}`)).body).toEqual(task);
    expect((await call(appWith(), `/tasks/${task.taskId.toUpperCase()}`)).status).toBe(200);
  });

  test("GET /tasks/:taskId answers 404 task_not_found", async () => {
    expect(await call(appWith(), "/tasks/00000000-0000-4000-8000-000000000000")).toEqual({
      status: 404,
      body: { error: "task_not_found" },
    });
  });

  test("GET /tasks/:taskId rejects a malformed id with 400", async () => {
    expect((await call(appWith(), "/tasks/not-a-uuid")).status).toBe(400);
  });

  test("a failing dependency answers 502 with the short code only", async () => {
    const app = appWith({
      list: async () =>
        Promise.reject(new DependencyError("task_error", new Error("secret detail"))),
    });
    expect(await call(app, "/tasks")).toEqual({
      status: 502,
      body: { error: "task_error" },
    });
    expect(await call(app, "/tasks")).toEqual({ status: 502, body: { error: "task_error" } });
  });

  test("an unknown route answers 404", async () => {
    expect((await call(appWith(), "/nope")).status).toBe(404);
  });
});

describe("sessions of a task", () => {
  const base = `/tasks/${task.taskId}/sessions`;

  test("lists the sessions of an existing task", async () => {
    expect(await call(appWith(), base)).toEqual({ status: 200, body: { sessions: [session] } });
  });

  test("answers 404 task_not_found before touching sessions, and for any session route", async () => {
    let touched = false;
    const app = appWith(
      {},
      { list: async () => ((touched = true), []), get: async () => ((touched = true), undefined) },
    );
    const missing = "/tasks/00000000-0000-4000-8000-000000000000/sessions";
    for (const path of [missing, `${missing}/s1`])
      expect(await call(app, path)).toEqual({ status: 404, body: { error: "task_not_found" } });
    expect(touched).toBe(false);
  });

  test("matches the task id case-insensitively and gives the service the canonical id", async () => {
    const res = await call(appWith(), `/tasks/${task.taskId.toUpperCase()}/sessions`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessions: [session] });
  });

  test("returns a session of the task", async () => {
    const res = await call(appWith(), `${base}/s1`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "s1", taskId: task.taskId });
  });

  test("answers 404 session_not_found", async () => {
    expect(await call(appWith(), `${base}/nope`)).toEqual({
      status: 404,
      body: { error: "session_not_found" },
    });
  });

  test("DELETE answers 204 without a body, then 404 for a missing session", async () => {
    const ok = await appWith().handle(
      new Request(`http://localhost${base}/s1`, { method: "DELETE" }),
    );
    expect(ok.status).toBe(204);
    expect(await ok.text()).toBe("");
    const missing = await call(appWith(), `${base}/nope`, { method: "DELETE" });
    expect(missing).toEqual({ status: 404, body: { error: "session_not_found" } });
  });

  test.each(["/tasks/not-a-uuid/sessions", `/tasks/not-a-uuid/sessions/s1`])(
    "rejects a malformed task id on %s with 400",
    async (path) => {
      expect((await call(appWith(), path)).status).toBe(400);
    },
  );

  test("the guard does not leak to the task routes", async () => {
    expect((await call(appWith(), "/tasks")).status).toBe(200);
  });

  test("a failing sessions dependency answers 502 with the short code", async () => {
    const app = appWith(
      {},
      {
        list: async () => Promise.reject(new DependencyError("session_error", new Error("x"))),
      },
    );
    expect(await call(app, base)).toEqual({ status: 502, body: { error: "session_error" } });
  });
});

describe("DELETE /tasks/:taskId", () => {
  test("answers 204 without a body, then 404 task_not_found", async () => {
    const ok = await appWith().handle(
      new Request(`http://localhost/tasks/${task.taskId}`, { method: "DELETE" }),
    );
    expect(ok.status).toBe(204);
    expect(await ok.text()).toBe("");
    const missing = await call(appWith(), "/tasks/00000000-0000-4000-8000-000000000000", {
      method: "DELETE",
    });
    expect(missing).toEqual({ status: 404, body: { error: "task_not_found" } });
  });

  test("rejects a malformed id with 400", async () => {
    expect((await call(appWith(), "/tasks/nope", { method: "DELETE" })).status).toBe(400);
  });
});

describe("documents of a task", () => {
  const base = `/tasks/${task.taskId}/documents`;
  const upload = (file?: File, headers?: Record<string, string>): RequestInit => {
    const form = new FormData();
    if (file) form.set("file", file);
    return { method: "POST", body: form, headers };
  };
  const txt = new File(["hi"], "a.txt", { type: "text/plain" });

  test("lists, gets and deletes a document of the task", async () => {
    expect(await call(appWith(), base)).toEqual({
      status: 200,
      body: { documents: [doc] },
    });
    expect((await call(appWith(), `${base}/${doc.documentId}`)).body).toMatchObject({
      content: "hi",
    });
    const gone = await appWith().handle(
      new Request(`http://localhost${base}/${doc.documentId}`, { method: "DELETE" }),
    );
    expect(gone.status).toBe(204);
  });

  test("answers 404 document_not_found and 400 for a malformed document id", async () => {
    const missing = `${base}/${"b".repeat(64)}`;
    expect(await call(appWith(), missing)).toEqual({
      status: 404,
      body: { error: "document_not_found" },
    });
    expect((await call(appWith(), `${base}/not-a-hash`)).status).toBe(400);
  });

  test("answers 404 task_not_found for an unknown task", async () => {
    expect(await call(appWith(), "/tasks/00000000-0000-4000-8000-000000000000/documents")).toEqual({
      status: 404,
      body: { error: "task_not_found" },
    });
  });

  test("answers 501 not_supported on every route when the extract service is not configured, even for an unknown task", async () => {
    const app = appWith({}, {}, null);
    const unknown = "/tasks/00000000-0000-4000-8000-000000000000/documents";
    for (const path of [base, unknown, `${base}/${doc.documentId}`])
      expect(await call(app, path)).toEqual({ status: 501, body: { error: "not_supported" } });
    expect((await call(app, base, upload(txt))).status).toBe(501);
  });

  test("POST creates a document from the multipart file", async () => {
    const res = await call(appWith(), base, upload(txt));
    expect(res).toEqual({ status: 201, body: doc });
  });

  test("POST without a file answers 400 file_required", async () => {
    expect(await call(appWith(), base, upload())).toEqual({
      status: 400,
      body: { error: "file_required" },
    });
  });

  test.each([
    ["document_too_large", 413],
    ["extraction_failed", 422],
  ] as const)("POST maps %s to %i", async (status, code) => {
    const app = appWith({}, {}, { create: async () => ({ status }) });
    expect(await call(app, base, upload(txt))).toEqual({ status: code, body: { error: status } });
  });

  test("POST refuses an upload that declares more than 25 MiB with 413 file_too_large", async () => {
    const res = await call(
      appWith(),
      base,
      upload(txt, { "content-length": String(26 * 1024 * 1024) }),
    );
    expect(res).toEqual({ status: 413, body: { error: "file_too_large" } });
  });

  test("a failing documents dependency answers 502 with the short code", async () => {
    const app = appWith(
      {},
      {},
      {
        list: async () => Promise.reject(new DependencyError("document_error", new Error("x"))),
      },
    );
    expect(await call(app, base)).toEqual({ status: 502, body: { error: "document_error" } });
  });
});

describe("POST /tasks/:taskId/run", () => {
  const run = (taskId: string, body?: BodyInit, contentType = "application/json") =>
    call(appWith(), `/tasks/${taskId}/run`, {
      method: "POST",
      headers: body === undefined ? {} : { "content-type": contentType },
      body,
    });

  test("starts a run without a body and answers 202 with the operation", async () => {
    expect(await run(task.taskId)).toEqual({ status: 202, body: { operation: "op-1" } });
  });

  test("a body that is not JSON is 400 invalid_request and starts nothing", async () => {
    expect(await run(task.taskId, "not json {")).toEqual({
      status: 400,
      body: { error: "invalid_request" },
    });
  });

  test("an empty body is a plain run", async () => {
    expect((await run(task.taskId, "")).status).toBe(202);
  });

  test("a resume passes the session id and the trimmed message to the service", async () => {
    let seen: unknown;
    const app = appWith({
      run: async (_id, resume) => ((seen = resume), { status: "started", operation: "op-2" }),
    });
    const res = await call(
      app,
      `/tasks/${task.taskId.toUpperCase()}/run`,
      json({ sessionId: "s1", message: "  answer  " }),
    );
    expect(res).toEqual({ status: 202, body: { operation: "op-2" } });
    expect(seen).toEqual({ sessionId: "s1", message: "answer" });
  });

  test.each([
    ["a blank message", { sessionId: "s1", message: "  " }],
    ["a missing message", { sessionId: "s1" }],
    ["an empty session id", { sessionId: "", message: "m" }],
  ])("a resume with %s is 400 invalid_resume and starts nothing", async (_name, body) => {
    let started = false;
    const app = appWith({
      run: async () => ((started = true), { status: "started", operation: "x" }),
    });
    const res = await call(app, `/tasks/${task.taskId}/run`, json(body));
    expect(res).toEqual({
      status: 400,
      body: { success: false, error: "invalid_resume" },
    });
    expect(started).toBe(false);
  });

  test.each([
    ["task_not_found", 404],
    ["session_not_found", 404],
    ["task_not_executable", 409],
    ["run_in_progress", 409],
    ["message_pending", 409],
  ] as const)("maps the status %s to %i", async (status, code) => {
    const app = appWith({ run: async () => ({ status }) });
    expect(await call(app, `/tasks/${task.taskId}/run`, { method: "POST" })).toEqual({
      status: code,
      body: { error: status },
    });
  });

  test("rejects a malformed task id with 400", async () => {
    expect((await run("not-a-uuid")).status).toBe(400);
  });
});

describe("session stats and messages", () => {
  const base = `/tasks/${task.taskId}/sessions`;

  test("GET stats answers with the totals, or 404 session_not_found", async () => {
    expect((await call(appWith(), `${base}/s1/stats`)).body).toMatchObject({
      events: 0,
      llmCalls: 0,
    });
    expect(await call(appWith(), `${base}/nope/stats`)).toEqual({
      status: 404,
      body: { error: "session_not_found" },
    });
  });

  test("GET messages streams the events as Server-Sent Events, with a keepalive event first and when idle", async () => {
    const res = await appWith().handle(new Request(`http://localhost${base}/s1/messages`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe(
      'event: keepalive\ndata: \n\nid: e1\ndata: {"id":"e1"}\n\nevent: keepalive\ndata: \n\n',
    );
  });

  test("GET messages answers 404 session_not_found, and 404 task_not_found for an unknown task", async () => {
    expect(await call(appWith(), `${base}/nope/messages`)).toEqual({
      status: 404,
      body: { error: "session_not_found" },
    });
    expect(
      await call(appWith(), "/tasks/00000000-0000-4000-8000-000000000000/sessions/s1/messages"),
    ).toEqual({ status: 404, body: { error: "task_not_found" } });
  });

  test("a client that disconnects aborts the feed", async () => {
    let aborted = false;
    const app = appWith(
      {},
      {
        messages: async (_t, _s, { signal }) => {
          signal.addEventListener("abort", () => (aborted = true), { once: true });
          return {
            status: "ok",
            entries: (async function* () {
              yield { id: "e1", data: "x" };
              await new Promise(() => {});
            })(),
          };
        },
      },
    );
    const client = new AbortController();
    const res = await app.handle(
      new Request(`http://localhost${base}/s1/messages`, { signal: client.signal }),
    );
    await res.body!.getReader().read();
    client.abort();
    expect(aborted).toBe(true);
  });
});

describe("jobs and agents", () => {
  test("GET /jobs lists the jobs", async () => {
    expect(await call(appWith(), "/jobs")).toEqual({
      status: 200,
      body: {
        jobs: [{ name: "projects/p/locations/l/jobs/poet-agents" }],
      },
    });
  });

  test("GET /jobs/:jobName/agents lists the registered agents", async () => {
    expect(await call(appWith(), "/jobs/poet-agents/agents")).toEqual({
      status: 200,
      body: { agents: [{ name: "haiku" }] },
    });
  });

  test("GET an agent card, or 404 agent_not_found", async () => {
    expect((await call(appWith(), "/jobs/poet-agents/agents/haiku/card")).body).toMatchObject({
      name: "haiku",
    });
    expect(await call(appWith(), "/jobs/poet-agents/agents/ghost/card")).toEqual({
      status: 404,
      body: { error: "agent_not_found" },
    });
  });

  test("POST register answers 202 with the operation", async () => {
    expect(await call(appWith(), "/jobs/poet-agents/register", { method: "POST" })).toEqual({
      status: 202,
      body: { operation: "operations/op-1" },
    });
  });

  test("a cross-site POST is refused before the handler runs", async () => {
    const res = await appWith().handle(
      new Request("http://localhost/jobs/poet-agents/register", {
        method: "POST",
        headers: { "sec-fetch-site": "cross-site" },
      }),
    );
    expect(res.status).toBe(403);
  });

  test("POST register answers 400 unknown_job for a job that is not allowed", async () => {
    const app = appWith({}, {}, {}, { agents: { register: async () => undefined } });
    expect(await call(app, "/jobs/other-job/register", { method: "POST" })).toEqual({
      status: 400,
      body: { error: "unknown_job" },
    });
  });

  test.each([["/jobs/Bad_Name/agents"], ["/jobs/poet-agents/agents/1bad/card"]])(
    "rejects an invalid name in %s with 400",
    async (path) => {
      expect((await call(appWith(), path)).status).toBe(400);
    },
  );

  test("a failing job or registry call answers 502 with the short code", async () => {
    const jobs = appWith(
      {},
      {},
      {},
      {
        agents: {
          listJobs: async () => Promise.reject(new DependencyError("job_error", new Error("x"))),
        },
      },
    );
    expect(await call(jobs, "/jobs")).toEqual({ status: 502, body: { error: "job_error" } });
    const agents = appWith(
      {},
      {},
      {},
      {
        agents: {
          listAgents: async () =>
            Promise.reject(new DependencyError("agents_error", new Error("x"))),
        },
      },
    );
    expect(await call(agents, "/jobs/poet-agents/agents")).toEqual({
      status: 502,
      body: { error: "agents_error" },
    });
  });
});

describe("GET /events", () => {
  const eventsService = (): EventsService => ({
    stream: async () =>
      (async function* () {
        yield { id: "e1", data: '{"type":"task.created"}' };
        yield "idle" as const;
      })(),
  });

  test("answers 501 not_supported without a platform event stream", async () => {
    expect(await call(appWith(), "/events")).toEqual({
      status: 501,
      body: { error: "not_supported" },
    });
  });

  test("streams the platform events as Server-Sent Events", async () => {
    const res = await appWith({}, {}, {}, { events: eventsService() }).handle(
      new Request("http://localhost/events"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe(
      'event: keepalive\ndata: \n\nid: e1\ndata: {"type":"task.created"}\n\nevent: keepalive\ndata: \n\n',
    );
  });

  test("a client that disconnects aborts the feed", async () => {
    let aborted = false;
    const events: EventsService = {
      stream: async ({ signal }) => {
        signal.addEventListener("abort", () => (aborted = true), { once: true });
        return (async function* () {
          yield { id: "e1", data: "x" };
          await new Promise(() => {});
        })();
      },
    };
    const client = new AbortController();
    const res = await appWith({}, {}, {}, { events }).handle(
      new Request("http://localhost/events", { signal: client.signal }),
    );
    await res.body!.getReader().read();
    client.abort();
    expect(aborted).toBe(true);
  });
});
