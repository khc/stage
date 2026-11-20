import { expect, mock, test } from "bun:test";

import {
  ApiError,
  createApi,
  inputExample,
  jobDetails,
  jobEnvNames,
  lastOutput,
  buildPrompt,
  parseJsonObject,
  promptError,
  schemaFields,
  schemaRows,
  schemaSummary,
  streamMessages,
  takesNoInput,
  taskTitle,
  withEvent,
} from "./api";

// An API whose fetches go to `respond`; `calls` records what the service would have received.
type Call = { url: string; method?: string; body?: unknown };
const serviceReplying = (respond: (call: Call) => Response) => {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: String(input instanceof Request ? input.url : input),
      method: init?.method,
      body: init?.body,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { api: createApi("http://localhost", fetcher), calls };
};
const replying = (body: unknown, status = 200) =>
  serviceReplying(() => Response.json(body, { status }));
const replyingEmpty = (status = 204) => serviceReplying(() => new Response(null, { status }));

test("document upload posts multipart form data to the task's documents route", async () => {
  const { api, calls } = replying(
    { documentId: "d", filename: "a.txt", checksum: "d", contentType: "text/plain" },
    201,
  );
  await api.uploadDocument("task-1", new File(["hi"], "a.txt"));
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    url: "http://localhost/tasks/task-1/documents",
    method: "POST",
  });
  expect(calls[0]!.body).toBeInstanceOf(FormData);
  expect((calls[0]!.body as FormData).get("file")).toBeInstanceOf(File);
});

test("task creation sends only the saved contract input", async () => {
  const task = { taskId: "task-1", prompt: "hello", jobName: "worker" };
  const { api, calls } = replying(task, 201);
  expect(await api.create({ prompt: "hello", jobName: "worker" })).toEqual(task as never);
  expect(calls[0]).toMatchObject({ url: "http://localhost/tasks", method: "POST" });
  expect(JSON.parse(calls[0]!.body as string)).toEqual({ prompt: "hello", jobName: "worker" });
});

test("running a task submits once with no prompt or job override", async () => {
  const { api, calls } = replying({ operation: "op-1" }, 202);
  expect(await api.run("task-1")).toEqual({ operation: "op-1" });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ url: "http://localhost/tasks/task-1/run", method: "POST" });
  expect(calls[0]!.body).toBeUndefined();
});

test("session IDs are encoded and missing sessions reject rather than becoming empty content", async () => {
  const { api, calls } = replying({ error: "session_not_found" }, 404);
  await expect(api.session("task-1", "custom/id")).rejects.toMatchObject({
    status: 404,
    message: "This session could not be found for this task.",
  });
  expect(calls[0]!.url).toBe("http://localhost/tasks/task-1/sessions/custom%2Fid");
});

test("non-JSON server failures produce a readable error", async () => {
  const { api } = serviceReplying(() => new Response("unavailable", { status: 503 }));
  await expect(api.tasks()).rejects.toBeInstanceOf(ApiError);
  await expect(api.tasks()).rejects.toThrow("Request failed (503)");
});

test("private upstream error details are not displayed", async () => {
  const { api } = replying({ error: "job_error", detail: "private credential details" }, 502);
  await expect(api.run("task-1")).rejects.toThrow("Cloud Run could not complete the request");
});

test("resuming a session posts sessionId and message to the run route", async () => {
  const { api, calls } = replying({ operation: "op-2" }, 202);
  expect(await api.resume("task-1", "s1", "answer")).toEqual({ operation: "op-2" });
  expect(calls[0]!.url).toBe("http://localhost/tasks/task-1/run");
  expect(JSON.parse(calls[0]!.body as string)).toEqual({ sessionId: "s1", message: "answer" });
});

test("starting a session with a message posts message to the run route", async () => {
  const { api, calls } = replying({ operation: "op-3", sessionId: "s-new" }, 202);
  expect(await api.startSession("task-1", "hello")).toEqual({
    operation: "op-3",
    sessionId: "s-new",
  });
  expect(calls[0]!.url).toBe("http://localhost/tasks/task-1/run");
  expect(JSON.parse(calls[0]!.body as string)).toEqual({ message: "hello" });
});

test("withEvent appends new events once and updates the session time", () => {
  const session = {
    id: "s1",
    taskId: "t1",
    appName: "a",
    userId: "u",
    lastUpdateTime: 1,
    state: {},
    events: [{ id: "e1", timestamp: 1 }],
  };
  const next = withEvent(session, { id: "e2", timestamp: 5 });
  expect(next.events.map((e) => e.id)).toEqual(["e1", "e2"]);
  expect(next.lastUpdateTime).toBe(5);
  expect(withEvent(next, { id: "e2", timestamp: 9 })).toBe(next);
});

test("streamMessages parses events, ignores bad data and closes the source", () => {
  type Handler = (m: { data: string }) => void;
  const instances: { url: string; handlers: Handler[]; close: () => void }[] = [];
  const original = globalThis.EventSource;
  globalThis.EventSource = class {
    url: string;
    handlers: Handler[] = [];
    close = mock(() => {});
    constructor(url: string) {
      this.url = url;
      instances.push(this);
    }
    addEventListener(type: string, handler: Handler) {
      if (type === "message") this.handlers.push(handler);
    }
  } as never;
  try {
    const seen: unknown[] = [];
    const stop = streamMessages("t 1", "s/1", (e) => seen.push(e));
    const source = instances[0]!;
    expect(source.url).toBe("/tasks/t%201/sessions/s%2F1/messages");
    for (const handler of source.handlers) {
      handler({ data: '{"id":"e1"}' });
      handler({ data: "not json" });
    }
    expect(seen).toEqual([{ id: "e1" }]);
    stop();
    expect(source.close).toHaveBeenCalled();
  } finally {
    globalThis.EventSource = original;
  }
});

test("deleting a session sends DELETE to the encoded path and accepts 204", async () => {
  const { api, calls } = replyingEmpty();
  expect(await api.deleteSession("task-1", "s/1")).toBeUndefined();
  expect(calls[0]).toMatchObject({
    url: "http://localhost/tasks/task-1/sessions/s%2F1",
    method: "DELETE",
  });
});

test("session stats are fetched from the encoded stats path", async () => {
  const stats = { events: 2, llmCalls: 1, tokens: { total: 9 } };
  const { api, calls } = replying(stats);
  expect(await api.stats("task-1", "s/1")).toEqual(stats as never);
  expect(calls[0]!.url).toBe("http://localhost/tasks/task-1/sessions/s%2F1/stats");
});

test("task creation sends agentName only when provided", async () => {
  const { api, calls } = replying({ taskId: "t", prompt: "p", jobName: "j" }, 201);
  await api.create({ prompt: "p", jobName: "j", agentName: "researcher" });
  await api.create({ prompt: "p", jobName: "j", agentName: undefined });
  expect(calls.map((c) => JSON.parse(c.body as string))).toEqual([
    { prompt: "p", jobName: "j", agentName: "researcher" },
    { prompt: "p", jobName: "j" },
  ]);
});

test("job agents are fetched from the encoded job path", async () => {
  const body = { agents: [{ name: "assistant" }] };
  const { api, calls } = replying(body);
  expect(await api.agents("my-job")).toEqual(body);
  expect(calls[0]!.url).toBe("http://localhost/jobs/my-job/agents");
});

test("registering a job's agents posts to the encoded register path", async () => {
  const { api, calls } = replying({ operation: "op-3" }, 202);
  expect(await api.registerAgents("my-job")).toEqual({ operation: "op-3" });
  expect(calls[0]).toMatchObject({ url: "http://localhost/jobs/my-job/register", method: "POST" });
});

test("lastOutput returns the newest visible agent text, skipping tools, thoughts and the user", () => {
  const text = (t: string, extra = {}) => ({
    author: "assistant",
    content: { role: "model", parts: [{ text: t, ...extra }] },
  });
  const events = [
    { author: "user", content: { role: "user", parts: [{ text: "hi" }] } },
    text("first answer", { timestamp: 1 }),
    { ...text("newest answer"), timestamp: 7 },
    {
      author: "assistant",
      content: { role: "model", parts: [{ functionCall: { name: "t" } }] },
    },
    {
      author: "assistant",
      content: { role: "user", parts: [{ functionResponse: { name: "t" } }] },
    },
    text("hidden thought", { thought: true }),
  ];
  expect(lastOutput(events)).toEqual({ text: "newest answer", timestamp: 7, author: "assistant" });
  expect(lastOutput([])).toBeUndefined();
  expect(lastOutput([events[0]!])).toBeUndefined();
});

test("schemaSummary describes primitives, objects, arrays and enums", () => {
  expect(schemaSummary(undefined)).toBe("Not described");
  expect(schemaSummary({ type: "string" })).toBe("string");
  expect(
    schemaSummary({
      type: "object",
      properties: {
        city: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        unit: { enum: ["c", "f"] },
      },
    }),
  ).toBe('{ city: string, tags: string[], unit: "c" | "f" }');
  expect(schemaSummary({})).toBe("any");
});

test("structured input helpers build an example and validate the prompt", () => {
  const schema = {
    type: "object",
    required: ["topic"],
    properties: { topic: { type: "string" } },
  };
  expect(inputExample(schema)).toBe('{"topic":""}');
  expect(inputExample({ type: "string" })).toBeUndefined();
  expect(promptError(schema, '{"topic":"rain"}')).toBeUndefined();
  expect(promptError(schema, "rain")).toContain("JSON object");
  expect(promptError(schema, "[1]")).toContain("JSON object");
  expect(promptError(schema, "{}")).toBe("Missing required field: topic.");
  expect(promptError({ type: "string" }, "anything")).toBeUndefined();
  expect(promptError(schema, "  ")).toBeUndefined();
  expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
  expect(parseJsonObject("nope")).toBeUndefined();
});

test("jobDetails summarises a Cloud Run job and jobEnvNames lists names only", () => {
  const job = {
    name: "projects/p/locations/l/jobs/my-job",
    createTime: { seconds: "1794425567", nanos: 922767631 },
    executionCount: 36,
    terminalCondition: { state: "CONDITION_SUCCEEDED" as const },
    latestCreatedExecution: { name: "my-job-abcde" },
    template: {
      taskCount: 1,
      parallelism: 0,
      template: {
        maxRetries: 3,
        timeout: { seconds: "600", nanos: 0 },
        serviceAccount: "",
        executionEnvironment: "EXECUTION_ENVIRONMENT_GEN2" as const,
        containers: [
          {
            image: "agent:latest",
            resources: { limits: { cpu: "1000m", memory: "512Mi" } },
            env: [{ name: "A" }, { name: "B" }, {}],
          },
        ],
      },
    },
  };
  const rows = Object.fromEntries(jobDetails(job));
  expect(rows).toMatchObject({
    Status: "Ready",
    Image: "agent:latest",
    "Tasks per execution": "1",
    Parallelism: "Default",
    "Max retries": "3",
    Timeout: "10m",
    CPU: "1000m",
    Memory: "512Mi",
    "Service account": "Default",
    Environment: "GEN2",
    Executions: "36",
    "Latest execution": "my-job-abcde",
  });
  expect(rows.Created).toBeString();
  expect(rows).not.toHaveProperty("Updated");
  expect(jobEnvNames(job)).toEqual(["A", "B"]);
  expect(jobDetails({})).toEqual([
    ["Parallelism", "Default"],
    ["Service account", "Default"],
  ]);
});

test("schemaFields maps a structured schema to form fields", () => {
  const fields = schemaFields({
    type: "object",
    required: ["topic"],
    properties: {
      topic: { type: "string", description: "The subject." },
      lines: { type: "integer", minimum: 1, maximum: 5 },
      loud: { type: "boolean" },
      tone: { type: "string", enum: ["calm", "wild"] },
      extra: { type: "array", items: { type: "string" } },
    },
  });
  expect(fields?.map((f) => [f.key, f.kind, f.required])).toEqual([
    ["topic", "string", true],
    ["lines", "number", false],
    ["loud", "boolean", false],
    ["tone", "enum", false],
    ["extra", "json", false],
  ]);
  expect(fields?.[0]?.description).toBe("The subject.");
  expect(schemaFields({ type: "string" })).toBeUndefined();
  expect(schemaFields({ type: "object", properties: {} })).toBeUndefined();
  expect(schemaFields(undefined)).toBeUndefined();
});

test("buildPrompt turns values into JSON and reports the first problem", () => {
  const fields = schemaFields({
    type: "object",
    required: ["topic"],
    properties: {
      topic: { type: "string" },
      lines: { type: "integer", minimum: 1, maximum: 5 },
      loud: { type: "boolean" },
      extra: { type: "array" },
    },
  })!;
  expect(
    buildPrompt(fields, {
      topic: "rain",
      lines: "3",
      loud: true,
      extra: "[1,2]",
    }),
  ).toEqual({
    prompt: '{"topic":"rain","lines":3,"loud":true,"extra":[1,2]}',
  });
  expect(buildPrompt(fields, { topic: "rain" })).toEqual({
    prompt: '{"topic":"rain","loud":false}',
  });
  expect(buildPrompt(fields, { topic: " " })).toEqual({
    error: "topic is required.",
  });
  expect(buildPrompt(fields, { topic: "a", lines: "2.5" })).toEqual({
    error: "lines must be a whole number.",
  });
  expect(buildPrompt(fields, { topic: "a", lines: "9" })).toEqual({
    error: "lines must be at most 5.",
  });
  expect(buildPrompt(fields, { topic: "a", extra: "{" })).toEqual({
    error: "extra must be valid JSON.",
  });
});

test("deleting a task sends DELETE to its path and accepts 204", async () => {
  const { api, calls } = replyingEmpty();
  expect(await api.deleteTask("task-1")).toBeUndefined();
  expect(calls[0]).toMatchObject({ url: "http://localhost/tasks/task-1", method: "DELETE" });
});

test("takesNoInput is true only for an object schema without properties", () => {
  expect(takesNoInput({ type: "object", properties: {} })).toBe(true);
  expect(takesNoInput({ type: "object", properties: { topic: { type: "string" } } })).toBe(false);
  expect(takesNoInput({ type: "string" })).toBe(false);
  expect(takesNoInput(undefined)).toBe(false);
});

test("schemaRows lists each property with type, required flag and description", () => {
  expect(
    schemaRows({
      type: "object",
      required: ["summary"],
      properties: {
        summary: { type: "string", description: "A summary." },
        bulletpoints: { type: "array", items: { type: "string" } },
      },
    }),
  ).toEqual([
    { name: "summary", type: "string", required: true, description: "A summary." },
    { name: "bulletpoints", type: "string[]", required: false, description: undefined },
  ]);
  expect(schemaRows({ type: "string" })).toEqual([]);
});

test("taskTitle shows the agent name for a no-input task and the prompt otherwise", () => {
  expect(taskTitle({ taskId: "t", prompt: "Write a haiku", agentName: "haiku" })).toBe(
    "Write a haiku",
  );
  expect(taskTitle({ taskId: "t", prompt: "{}", agentName: "document_analyser" })).toBe(
    "Document analyser",
  );
  expect(taskTitle({ taskId: "t", prompt: "{}" })).toBe("Untitled task");
});
