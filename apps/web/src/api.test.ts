import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { api, ApiError } from "./api";

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
