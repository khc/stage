import { describe, expect, mock, test } from "bun:test";
import type { TaskSessions } from "./sessions";
import type { CreateTask, TaskContract } from "./tasks";
import { createApp } from "./app";
import type { openApiDocument } from "./openapi";
import type { ListJobs, RunJob } from "./jobs";

const noJob: RunJob = async () => "";
const noJobs: ListJobs = async () => [];
const noCreate: CreateTask = async (input) => ({
  taskId: crypto.randomUUID(),
  ...input,
});
const noTasks = async () => [];
const noTask = async (_taskId: string) => undefined;
const noSessions: TaskSessions = {
  list: async () => [],
  get: async () => undefined,
  delete: async () => false,
};
const makeApp = () =>
  createApp(noJob, noJobs, noCreate, noTasks, noTask, noSessions);

const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("GET /health returns ok", async () => {
  const res = await makeApp().request("/health");

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "ok" });
});

test("GET /jobs returns all listed job resources", async () => {
  const jobs = [
    { name: "projects/p/locations/l/jobs/first", labels: { team: "agent" } },
    { name: "projects/p/locations/l/jobs/second" },
  ];
  const listJobs = mock(async () => jobs);
  const res = await createApp(
    noJob,
    listJobs,
    noCreate,
    noTasks,
    noTask,
    noSessions,
  ).request("/jobs");

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ jobs });
  expect(listJobs).toHaveBeenCalledTimes(1);
});

test("GET /jobs returns an empty jobs array", async () => {
  const res = await createApp(
    noJob,
    noJobs,
    noCreate,
    noTasks,
    noTask,
    noSessions,
  ).request("/jobs");

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ jobs: [] });
});

test("GET /jobs returns 502 job_error without upstream details", async () => {
  const listJobs = mock(async (): ReturnType<ListJobs> => {
    throw new Error("secret listing detail");
  });
  const res = await createApp(
    noJob,
    listJobs,
    noCreate,
    noTasks,
    noTask,
    noSessions,
  ).request("/jobs");

  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: "job_error" });
});

const savedTask = {
  taskId: "9eb6f136-55d6-4cfb-8b1e-71367d7fd6a8",
  prompt: "hello",
  jobName: "my-job",
};
const taskApp = () => {
  const job = mock(async (_jobName: string, _taskId: string) => "op-1");
  const create = mock(async (input: { prompt: string; jobName: string }) => ({
    ...savedTask,
    ...input,
  }));
  const list = mock(async () => [savedTask]);
  const get = mock(
    async (_id: string) => savedTask as TaskContract | undefined,
  );
  return {
    app: createApp(job, noJobs, create, list, get, noSessions),
    job,
    create,
    list,
    get,
  };
};

test("POST /tasks saves a trimmed prompt and returns 201 without executing", async () => {
  const { app, create, job } = taskApp();
  const response = await app.request(
    "/tasks",
    post({
      jobName: "my-job",
      prompt: "  hello  ",
      taskId: "client-id",
      extra: true,
    }),
  );
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual(savedTask);
  expect(create).toHaveBeenCalledWith({ prompt: "hello", jobName: "my-job" });
  expect(create).toHaveBeenCalledTimes(1);
  expect(job).not.toHaveBeenCalled();
});

test("POST /tasks accepts the maximum prompt length", async () => {
  const { app, create } = taskApp();
  expect(
    (
      await app.request(
        "/tasks",
        post({ jobName: "my-job", prompt: "x".repeat(10_000) }),
      )
    ).status,
  ).toBe(201);
  expect(create).toHaveBeenCalledWith({
    prompt: "x".repeat(10_000),
    jobName: "my-job",
  });
});

test("POST /tasks rejects invalid bodies without saving", async () => {
  const { app, create } = taskApp();
  for (const body of [
    {},
    { prompt: "" },
    { prompt: "   " },
    { prompt: 42 },
    { prompt: null },
    { prompt: "x".repeat(10_001) },
  ]) {
    expect(
      (await app.request("/tasks", post({ jobName: "my-job", ...body })))
        .status,
    ).toBe(400);
  }
  expect(
    (
      await app.request("/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{broken",
      })
    ).status,
  ).toBe(400);
  expect((await app.request("/tasks", { method: "POST" })).status).toBe(400);
  expect(create).not.toHaveBeenCalled();
});

test("GET /tasks returns a collection without executing or creating", async () => {
  const { app, list, get, create, job } = taskApp();
  const response = await app.request("/tasks");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ tasks: [savedTask] });
  expect(list).toHaveBeenCalledTimes(1);
  expect(get).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  expect(job).not.toHaveBeenCalled();
});

test("GET /tasks returns an empty collection", async () => {
  const response = await createApp(
    noJob,
    noJobs,
    noCreate,
    noTasks,
    noTask,
    noSessions,
  ).request("/tasks");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ tasks: [] });
});

test("GET /tasks/:taskId returns a contract and normalizes uppercase UUIDs", async () => {
  const { app, get, create, job, list } = taskApp();
  for (const id of [savedTask.taskId, savedTask.taskId.toUpperCase()]) {
    const response = await app.request(`/tasks/${id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(savedTask);
    expect(get).toHaveBeenLastCalledWith(savedTask.taskId);
  }
  expect(create).not.toHaveBeenCalled();
  expect(job).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
});

test("GET /tasks/:taskId returns 404 for an absent UUID", async () => {
  const { app, get } = taskApp();
  get.mockResolvedValue(undefined);
  const response = await app.request(`/tasks/${savedTask.taskId}`);
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "task_not_found" });
});

test("GET /tasks/:taskId rejects an invalid UUID before storage", async () => {
  const { app, get } = taskApp();
  expect((await app.request("/tasks/not-a-uuid")).status).toBe(400);
  expect(get).not.toHaveBeenCalled();
});

for (const operation of ["create", "list", "get"] as const) {
  test(`${operation} run failures return 502 without private storage details`, async () => {
    const fixtures = taskApp();
    fixtures[operation].mockRejectedValue(new Error("private storage detail"));
    const response = await fixtures.app.request(
      operation === "get" ? `/tasks/${savedTask.taskId}` : "/tasks",
      operation === "create"
        ? post({ jobName: "my-job", prompt: "hello" })
        : undefined,
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "task_error" });
  });
}

for (const jobName of [
  undefined,
  42,
  "",
  "My_Job",
  "-bad",
  "bad-",
  "a".repeat(64),
  "projects/p/locations/l/jobs/job",
  " my-job ",
]) {
  test(`creation rejects invalid jobName ${String(jobName)}`, async () => {
    const { app, create } = taskApp();
    expect(
      (await app.request("/tasks", post({ prompt: "hello", jobName }))).status,
    ).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
}

test("creation accepts a 63-character job name", async () => {
  const { app, create } = taskApp();
  const jobName = "a".repeat(63);
  expect(
    (await app.request("/tasks", post({ prompt: "hello", jobName }))).status,
  ).toBe(201);
  expect(create).toHaveBeenCalledWith({ prompt: "hello", jobName });
});

const runPath = `/tasks/${savedTask.taskId}/run`;
test("run reads the contract before submitting only stored jobName and normalized UUID", async () => {
  const { app, get, job, create } = taskApp();
  const deferred = Promise.withResolvers<TaskContract>();
  get.mockImplementation(() => deferred.promise);
  const pending = app.request(`/tasks/${savedTask.taskId.toUpperCase()}/run`, {
    method: "POST",
  });
  await Promise.resolve();
  expect(job).not.toHaveBeenCalled();
  deferred.resolve(savedTask);
  const response = await pending;
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ operation: "op-1" });
  expect(get).toHaveBeenCalledWith(savedTask.taskId);
  expect(job).toHaveBeenCalledWith("my-job", savedTask.taskId);
  expect(create).not.toHaveBeenCalled();
});

test("run ignores conflicting prompt/message/jobName supplied in its body", async () => {
  const { app, job } = taskApp();
  const response = await app.request(
    runPath,
    post({ jobName: "different-job", prompt: "override", message: "override" }),
  );
  expect(response.status).toBe(202);
  expect(job).toHaveBeenCalledWith("my-job", savedTask.taskId);
});

test("run rejects invalid UUIDs without reading or submitting", async () => {
  const { app, get, job } = taskApp();
  expect(
    (await app.request("/tasks/invalid/run", { method: "POST" })).status,
  ).toBe(400);
  expect(get).not.toHaveBeenCalled();
  expect(job).not.toHaveBeenCalled();
});

test("run returns 404 for an absent contract without submission", async () => {
  const { app, get, job } = taskApp();
  get.mockResolvedValue(undefined);
  const response = await app.request(runPath, { method: "POST" });
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "task_not_found" });
  expect(job).not.toHaveBeenCalled();
});

for (const jobName of [
  undefined,
  "",
  "Invalid_Name",
  "a".repeat(64),
  "../bad",
  42,
]) {
  test(`run rejects missing or invalid stored jobName ${String(jobName)}`, async () => {
    const { app, get, job } = taskApp();
    get.mockResolvedValue({ ...savedTask, jobName } as TaskContract);
    const response = await app.request(runPath, { method: "POST" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "task_not_executable" });
    expect(job).not.toHaveBeenCalled();
  });
}

test("run lookup failure returns task_error without submission", async () => {
  const { app, get, job } = taskApp();
  get.mockRejectedValue(new Error("private lookup failure"));
  const response = await app.request(runPath, { method: "POST" });
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "task_error" });
  expect(job).not.toHaveBeenCalled();
});

test("run submission failure returns job_error", async () => {
  const { app, job } = taskApp();
  job.mockRejectedValue(new Error("private submission failure"));
  const response = await app.request(runPath, { method: "POST" });
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "job_error" });
});

test("old execution URL is removed", async () => {
  const { app, job, get } = taskApp();
  expect(
    (await app.request("/jobs/my-job/run", { method: "POST" })).status,
  ).toBe(404);
  expect(job).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
});

test("former run-contract URLs are removed", async () => {
  const { app, get, list, job } = taskApp();
  expect((await app.request("/jobs/runs")).status).toBe(404);
  expect(
    (
      await app.request(
        "/jobs/runs",
        post({ prompt: "hello", jobName: "my-job" }),
      )
    ).status,
  ).toBe(404);
  expect((await app.request(`/jobs/runs/${savedTask.taskId}`)).status).toBe(
    404,
  );
  expect(
    (
      await app.request(`/jobs/runs/${savedTask.taskId}/exec`, {
        method: "POST",
      })
    ).status,
  ).toBe(404);
  expect(get).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
  expect(job).not.toHaveBeenCalled();
});

const sessionId = crypto.randomUUID();
const session = {
  id: sessionId,
  taskId: savedTask.taskId,
  appName: "agent-jobs",
  userId: "user",
  lastUpdateTime: 123,
  state: { count: 1 },
  events: [],
};
const sessionsApp = () => {
  const getTask = mock(
    async (_id: string): Promise<TaskContract | undefined> => savedTask,
  );
  const list = mock(async (_id: string) => [
    {
      id: session.id,
      taskId: session.taskId,
      appName: session.appName,
      userId: session.userId,
      lastUpdateTime: session.lastUpdateTime,
    },
  ]);
  const get = mock(
    async (
      _taskId: string,
      _sessionId: string,
    ): Promise<typeof session | undefined> => session,
  );
  return {
    app: createApp(noJob, noJobs, noCreate, noTasks, getTask, {
      list,
      get,
      delete: async () => false,
    }),
    getTask,
    list,
    get,
  };
};

test("GET task sessions returns summaries for the normalized task UUID", async () => {
  const { app, list } = sessionsApp();
  const response = await app.request(
    `/tasks/${savedTask.taskId.toUpperCase()}/sessions`,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    sessions: [
      {
        id: session.id,
        taskId: session.taskId,
        appName: session.appName,
        userId: session.userId,
        lastUpdateTime: session.lastUpdateTime,
      },
    ],
  });
  expect(list).toHaveBeenCalledWith(savedTask.taskId);
});

test("GET task sessions returns an empty list", async () => {
  const { app, list } = sessionsApp();
  list.mockResolvedValue([]);
  const response = await app.request(`/tasks/${savedTask.taskId}/sessions`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ sessions: [] });
});

test("GET task session returns full state and events", async () => {
  const { app, get } = sessionsApp();
  const response = await app.request(
    `/tasks/${savedTask.taskId}/sessions/${sessionId}`,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(session);
  expect(get).toHaveBeenCalledWith(savedTask.taskId, sessionId);
});

for (const detail of [false, true]) {
  const path = `/tasks/${savedTask.taskId}/sessions${detail ? `/${sessionId}` : ""}`;
  test(`session ${detail ? "detail" : "list"} rejects missing tasks before reading sessions`, async () => {
    const { app, getTask, list, get } = sessionsApp();
    getTask.mockResolvedValue(undefined);
    const response = await app.request(path);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "task_not_found" });
    expect(list).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
  test(`session ${detail ? "detail" : "list"} rejects invalid task UUIDs`, async () => {
    const { app, getTask, list, get } = sessionsApp();
    expect(
      (
        await app.request(
          `/tasks/invalid/sessions${detail ? `/${sessionId}` : ""}`,
        )
      ).status,
    ).toBe(400);
    expect(getTask).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
  test(`session ${detail ? "detail" : "list"} storage errors return 502 without private detail`, async () => {
    const { app, list, get } = sessionsApp();
    if (detail) get.mockRejectedValue(new Error("private session error"));
    else list.mockRejectedValue(new Error("private session error"));
    const response = await app.request(path);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "session_error" });
  });
}

test("GET task session returns 404 for absent or non-owned sessions", async () => {
  const { app, get } = sessionsApp();
  get.mockResolvedValue(undefined);
  const response = await app.request(
    `/tasks/${savedTask.taskId}/sessions/${sessionId}`,
  );
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "session_not_found" });
});

test("GET /docs serves Scalar configured for the local OpenAPI document", async () => {
  const response = await makeApp().request("/docs");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  const html = await response.text();
  expect(html).toContain("scalar");
  expect(html).toContain("/openapi.json");
});

test("GET /openapi.json describes every API operation and its task input", async () => {
  const app = makeApp();
  const response = await app.request("/openapi.json");
  expect(response.status).toBe(200);
  const document = (await response.json()) as typeof openApiDocument;
  expect(document.openapi).toBe("3.1.0");
  const actual = [
    ...new Set(
      app.routes
        .filter((r) => !["/docs", "/openapi.json"].includes(r.path))
        .map(
          (r) =>
            `${r.method.toLowerCase()} ${r.path.replace(/:([^/]+)/g, "{$1}")}`,
        ),
    ),
  ].sort();
  const described = Object.entries(document.paths)
    .flatMap(([path, operations]) =>
      Object.keys(operations as object)
        .filter((method) => ["get", "post", "delete"].includes(method))
        .map((method) => `${method} ${path}`),
    )
    .sort();
  expect(described).toEqual(actual);
  const input =
    document.paths["/tasks"].post.requestBody.content["application/json"]
      .schema;
  expect(input.required).toEqual(["prompt", "jobName"]);
  expect(input.properties?.prompt).toMatchObject({ maxLength: 10_000 });
  expect(input.properties?.jobName).toMatchObject({ maxLength: 63 });
  const resume =
    document.paths["/tasks/{taskId}/run"].post.requestBody.content[
      "application/json"
    ].schema;
  expect(resume.required).toEqual(["sessionId", "message"]);
  expect(
    document.paths["/tasks/{taskId}/sessions/{sessionId}"].get.responses["404"],
  ).toBeDefined();
});

const resumeApp = (found: boolean) => {
  const job = mock(
    async (_name: string, _taskId: string, _resume?: unknown) => "op-1",
  );
  const get = mock(async (_taskId: string, _sessionId: string) =>
    found ? ({ id: "s1" } as never) : undefined,
  );
  const app = createApp(
    job,
    noJobs,
    noCreate,
    noTasks,
    async () => savedTask as TaskContract,
    { list: async () => [], get, delete: async () => false },
  );
  return { app, job, get };
};

test("run with sessionId and message resumes an owned session", async () => {
  const { app, job, get } = resumeApp(true);
  const response = await app.request(
    runPath,
    post({ sessionId: "s1", message: "  answer  " }),
  );
  expect(response.status).toBe(202);
  expect(get).toHaveBeenCalledWith(savedTask.taskId, "s1");
  expect(job).toHaveBeenCalledWith("my-job", savedTask.taskId, {
    sessionId: "s1",
    message: "answer",
  });
});

test("run returns 404 session_not_found for a missing or foreign session", async () => {
  const { app, job } = resumeApp(false);
  const response = await app.request(
    runPath,
    post({ sessionId: "s1", message: "answer" }),
  );
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "session_not_found" });
  expect(job).not.toHaveBeenCalled();
});

test("run rejects sessionId without a valid message", async () => {
  const { app, get, job } = resumeApp(true);
  for (const body of [{ sessionId: "s1" }, { sessionId: "s1", message: " " }])
    expect((await app.request(runPath, post(body))).status).toBe(400);
  expect(get).not.toHaveBeenCalled();
  expect(job).not.toHaveBeenCalled();
});

describe("DELETE /tasks/:taskId/sessions/:sessionId", () => {
  const path = `/tasks/${savedTask.taskId}/sessions/s1`;
  const deleteApp = (remove: (t: string, s: string) => Promise<boolean>) => {
    const del = mock(remove);
    const app = createApp(
      noJob,
      noJobs,
      noCreate,
      noTasks,
      async (id: string) =>
        id === savedTask.taskId ? (savedTask as TaskContract) : undefined,
      { list: async () => [], get: async () => undefined, delete: del },
    );
    return { app, del };
  };

  test("deletes an owned session and returns 204", async () => {
    const { app, del } = deleteApp(async () => true);
    const res = await app.request(path, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(del).toHaveBeenCalledWith(savedTask.taskId, "s1");
  });

  test("returns 404 for a missing session or task without deleting", async () => {
    const missing = deleteApp(async () => false);
    const res = await missing.app.request(path, { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "session_not_found" });

    const noTask = deleteApp(async () => true);
    const other = await noTask.app.request(
      `/tasks/${crypto.randomUUID()}/sessions/s1`,
      { method: "DELETE" },
    );
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({ error: "task_not_found" });
    expect(noTask.del).not.toHaveBeenCalled();
  });

  test("rejects an invalid task id and hides storage failures", async () => {
    const { app, del } = deleteApp(async () => {
      throw new Error("private storage detail");
    });
    expect(
      (await app.request("/tasks/invalid/sessions/s1", { method: "DELETE" }))
        .status,
    ).toBe(400);
    const res = await app.request(path, { method: "DELETE" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "session_error" });
    expect(del).toHaveBeenCalledTimes(1);
  });
});

describe("GET /tasks/:taskId/sessions/:sessionId/stats", () => {
  const path = `/tasks/${savedTask.taskId}/sessions/s1/stats`;
  const statsApp = (found: boolean) =>
    createApp(
      noJob,
      noJobs,
      noCreate,
      noTasks,
      async (id: string) =>
        id === savedTask.taskId ? (savedTask as TaskContract) : undefined,
      {
        list: async () => [],
        get: async () =>
          found
            ? ({
                events: [
                  {
                    usageMetadata: { promptTokenCount: 7, totalTokenCount: 9 },
                  },
                  {},
                ],
              } as never)
            : undefined,
        delete: async () => false,
      },
    );

  test("returns event count and summed token usage", async () => {
    const res = await statsApp(true).request(path);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      events: 2,
      llmCalls: 1,
      tokens: {
        prompt: 7,
        candidates: 0,
        thoughts: 0,
        toolUsePrompt: 0,
        cached: 0,
        total: 9,
      },
    });
  });

  test("returns 404 for a missing session or task", async () => {
    const res = await statsApp(false).request(path);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "session_not_found" });
    const noTask = await statsApp(true).request(
      `/tasks/${crypto.randomUUID()}/sessions/s1/stats`,
    );
    expect(await noTask.json()).toEqual({ error: "task_not_found" });
  });
});

test("POST /tasks passes a valid agentName and rejects an invalid one", async () => {
  const { app, create } = taskApp();
  expect(
    (
      await app.request(
        "/tasks",
        post({ jobName: "my-job", prompt: "hi", agentName: "researcher_2" }),
      )
    ).status,
  ).toBe(201);
  expect(create).toHaveBeenCalledWith({
    prompt: "hi",
    jobName: "my-job",
    agentName: "researcher_2",
  });
  for (const agentName of ["", "has space", "1abc", "x".repeat(65), 7])
    expect(
      (
        await app.request(
          "/tasks",
          post({ jobName: "my-job", prompt: "hi", agentName }),
        )
      ).status,
    ).toBe(400);
  expect(create).toHaveBeenCalledTimes(1);
});

describe("agent registry routes", () => {
  const registered = [{ name: "assistant" }, { name: "researcher" }];
  const registryApp = (
    registry?: Parameters<typeof createApp>[7],
    create = mock(
      async (i: { prompt: string; jobName: string; agentName?: string }) => ({
        taskId: savedTask.taskId,
        ...i,
      }),
    ),
  ) => ({
    create,
    app: createApp(
      noJob,
      noJobs,
      create,
      noTasks,
      noTask,
      noSessions,
      undefined,
      registry,
    ),
  });

  test("GET /jobs/:jobName/agents lists the registered agents", async () => {
    const list = mock(async (_job: string) => registered);
    const { app } = registryApp({ register: async () => "", list });
    const res = await app.request("/jobs/my-job/agents");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agents: registered });
    expect(list).toHaveBeenCalledWith("my-job");
    expect(
      await (await registryApp().app.request("/jobs/my-job/agents")).json(),
    ).toEqual({ agents: [] });
    expect((await app.request("/jobs/Bad_Name/agents")).status).toBe(400);
  });

  test("POST /jobs/:jobName/register submits the register run", async () => {
    const register = mock(async (_job: string) => "op-7");
    const { app } = registryApp({ register, list: async () => [] });
    const res = await app.request("/jobs/my-job/register", { method: "POST" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ operation: "op-7" });
    expect(register).toHaveBeenCalledWith("my-job");

    register.mockRejectedValueOnce(new Error("private"));
    const failed = await app.request("/jobs/my-job/register", {
      method: "POST",
    });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "job_error" });

    const none = await registryApp().app.request("/jobs/my-job/register", {
      method: "POST",
    });
    expect(none.status).toBe(501);
  });

  test("POST /tasks rejects an agent the job has not registered", async () => {
    const { app, create } = registryApp({
      register: async () => "",
      list: async () => registered,
    });
    const bad = await app.request(
      "/tasks",
      post({ prompt: "p", jobName: "my-job", agentName: "ghost" }),
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "unknown_agent" });
    expect(create).not.toHaveBeenCalled();
    const ok = await app.request(
      "/tasks",
      post({ prompt: "p", jobName: "my-job", agentName: "researcher" }),
    );
    expect(ok.status).toBe(201);
  });

  test("POST /tasks accepts any valid agent for a job with no registration", async () => {
    const { app } = registryApp({
      register: async () => "",
      list: async () => [],
    });
    const res = await app.request(
      "/tasks",
      post({ prompt: "p", jobName: "my-job", agentName: "anything" }),
    );
    expect(res.status).toBe(201);
  });
});

test("GET /jobs/:jobName/agents passes each agent's schemas through", async () => {
  const agents = [
    {
      name: "haiku",
      description: "d",
      inputSchema: { type: "string" },
      outputSchema: { type: "string" },
    },
  ];
  const app = createApp(
    noJob,
    noJobs,
    noCreate,
    noTasks,
    noTask,
    noSessions,
    undefined,
    { register: async () => "", list: async () => agents },
  );
  expect(await (await app.request("/jobs/j/agents")).json()).toEqual({
    agents,
  });
});
