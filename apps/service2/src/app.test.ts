import { describe, expect, test } from "bun:test";

import { createApp, type AppDeps } from "./app";
import { DependencyError } from "./errors";
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
const appWith = (
  overrides: Partial<TasksService> = {},
  sessionOverrides: Partial<SessionsService> = {},
  documents: Partial<DocumentsService> | null = {},
) => {
  const deps: AppDeps = {
    healthService: { check: () => ({ status: "ok" }) },
    tasksService: tasksService(overrides),
    sessionsService: sessionsService(sessionOverrides),
    ...(documents && { documentsService: documentsService(documents) }),
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
    expect(await call(appWith(), base)).toEqual({ status: 200, body: { documents: [doc] } });
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
      { list: async () => Promise.reject(new DependencyError("document_error", new Error("x"))) },
    );
    expect(await call(app, base)).toEqual({ status: 502, body: { error: "document_error" } });
  });
});
