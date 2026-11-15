import { describe, expect, test } from "bun:test";

import { createApp, type AppDeps } from "./app";
import { DependencyError } from "./errors";
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
  delete: async (taskId, id) => taskId === task.taskId && id === "s1",
  ...overrides,
});
const appWith = (
  overrides: Partial<TasksService> = {},
  sessionOverrides: Partial<SessionsService> = {},
) => {
  const deps: AppDeps = {
    healthService: { check: () => ({ status: "ok" }) },
    tasksService: tasksService(overrides),
    sessionsService: sessionsService(sessionOverrides),
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

  test("rejects a response that breaks the schema", async () => {
    const app = createApp({
      healthService: { check: () => ({ status: "down" }) as never },
      tasksService: tasksService(),
      sessionsService: sessionsService(),
    });
    expect((await call(app, "/health")).status).not.toBe(200);
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
      { list: async () => Promise.reject(new DependencyError("session_error", new Error("x"))) },
    );
    expect(await call(app, base)).toEqual({ status: 502, body: { error: "session_error" } });
  });
});
