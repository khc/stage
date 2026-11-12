import { afterEach, expect, mock, spyOn, test } from "bun:test";
import {
  api,
  ApiError,
  inputExample,
  lastOutput,
  parseJsonObject,
  promptError,
  schemaSummary,
  streamMessages,
  withEvent,
} from "./api";

let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => fetchSpy?.mockRestore());

test("task creation sends only the saved contract input", async () => {
  const task = { taskId: "task-1", prompt: "hello", jobName: "worker" };
  const fetch = mock(async () => Response.json(task, { status: 201 }));
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    fetch as unknown as typeof globalThis.fetch,
  );
  expect(await api.create({ prompt: "hello", jobName: "worker" })).toEqual(
    task,
  );
  expect(fetch).toHaveBeenCalledWith("/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "hello", jobName: "worker" }),
  });
});

test("running a task submits once with no prompt or job override", async () => {
  const fetch = mock(async () =>
    Response.json({ operation: "op-1" }, { status: 202 }),
  );
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    fetch as unknown as typeof globalThis.fetch,
  );
  expect(await api.run("task-1")).toEqual({ operation: "op-1" });
  expect(fetch).toHaveBeenCalledWith("/tasks/task-1/run", { method: "POST" });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("session IDs are encoded and missing sessions reject rather than becoming empty content", async () => {
  const fetch = mock(async () =>
    Response.json({ error: "session_not_found" }, { status: 404 }),
  );
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    fetch as unknown as typeof globalThis.fetch,
  );
  await expect(api.session("task-1", "custom/id")).rejects.toMatchObject({
    status: 404,
    message: "This session could not be found for this task.",
  });
  expect(fetch).toHaveBeenCalledWith(
    "/tasks/task-1/sessions/custom%2Fid",
    undefined,
  );
});

test("non-JSON server failures produce a readable error", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    (async () =>
      new Response("unavailable", {
        status: 503,
      })) as unknown as typeof globalThis.fetch,
  );
  await expect(api.tasks()).rejects.toBeInstanceOf(ApiError);
  await expect(api.tasks()).rejects.toThrow("Request failed (503)");
});

test("private upstream error details are not displayed", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
    Response.json(
      { error: "job_error", detail: "private credential details" },
      { status: 502 },
    )) as unknown as typeof globalThis.fetch);
  await expect(api.run("task-1")).rejects.toThrow(
    "Cloud Run could not complete the request",
  );
});

test("resuming a session posts sessionId and message to the run route", async () => {
  const fetch = mock(async () =>
    Response.json({ operation: "op-2" }, { status: 202 }),
  );
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    fetch as unknown as typeof globalThis.fetch,
  );
  expect(await api.resume("task-1", "s1", "answer")).toEqual({
    operation: "op-2",
  });
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("/tasks/task-1/run");
  expect(JSON.parse(init.body as string)).toEqual({
    sessionId: "s1",
    message: "answer",
  });
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
  const instances: {
    url: string;
    onmessage?: (m: { data: string }) => void;
    close: () => void;
  }[] = [];
  const original = globalThis.EventSource;
  globalThis.EventSource = class {
    onmessage?: (m: { data: string }) => void;
    close = mock(() => {});
    constructor(public url: string) {
      instances.push(this);
    }
  } as never;
  try {
    const seen: unknown[] = [];
    const stop = streamMessages("t 1", "s/1", (e) => seen.push(e));
    const source = instances[0]!;
    expect(source.url).toBe("/tasks/t%201/sessions/s%2F1/messages");
    source.onmessage?.({ data: '{"id":"e1"}' });
    source.onmessage?.({ data: "not json" });
    expect(seen).toEqual([{ id: "e1" }]);
    stop();
    expect(source.close).toHaveBeenCalled();
  } finally {
    globalThis.EventSource = original;
  }
});

test("deleting a session sends DELETE to the encoded path and accepts 204", async () => {
  const fetch = mock(async () => new Response(null, { status: 204 }));
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    fetch as unknown as typeof globalThis.fetch,
  );
  expect(await api.deleteSession("task-1", "s/1")).toBeUndefined();
  expect(fetch).toHaveBeenCalledWith("/tasks/task-1/sessions/s%2F1", {
    method: "DELETE",
  });
});

test("session stats are fetched from the encoded stats path", async () => {
  const stats = { events: 2, llmCalls: 1, tokens: { total: 9 } };
  const fetch = mock(async () => Response.json(stats));
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    fetch as unknown as typeof globalThis.fetch,
  );
  expect(await api.stats("task-1", "s/1")).toEqual(stats as never);
  expect(fetch).toHaveBeenCalledWith(
    "/tasks/task-1/sessions/s%2F1/stats",
    undefined,
  );
});

test("task creation sends agentName only when provided", async () => {
  const fetch = mock(async () =>
    Response.json({ taskId: "t", prompt: "p", jobName: "j" }, { status: 201 }),
  );
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    fetch as unknown as typeof globalThis.fetch,
  );
  await api.create({ prompt: "p", jobName: "j", agentName: "researcher" });
  await api.create({ prompt: "p", jobName: "j", agentName: undefined });
  const bodies = fetch.mock.calls.map((c) =>
    JSON.parse((c as unknown as [string, RequestInit])[1].body as string),
  );
  expect(bodies).toEqual([
    { prompt: "p", jobName: "j", agentName: "researcher" },
    { prompt: "p", jobName: "j" },
  ]);
});

test("job agents are fetched from the encoded job path", async () => {
  const body = { agents: [{ name: "assistant" }] };
  const fetch = mock(async () => Response.json(body));
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    fetch as unknown as typeof globalThis.fetch,
  );
  expect(await api.agents("my-job")).toEqual(body);
  expect(fetch).toHaveBeenCalledWith("/jobs/my-job/agents", undefined);
});

test("registering a job's agents posts to the encoded register path", async () => {
  const fetch = mock(async () =>
    Response.json({ operation: "op-3" }, { status: 202 }),
  );
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    fetch as unknown as typeof globalThis.fetch,
  );
  expect(await api.registerAgents("my-job")).toEqual({ operation: "op-3" });
  expect(fetch).toHaveBeenCalledWith("/jobs/my-job/register", {
    method: "POST",
  });
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
  expect(lastOutput(events)).toEqual({ text: "newest answer", timestamp: 7 });
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
