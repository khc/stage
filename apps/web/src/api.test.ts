import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { api, ApiError, streamMessages, withEvent } from "./api";

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
