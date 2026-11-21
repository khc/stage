import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";

import { MAX_BUDGET_MS, createServeHandler, type RunTask } from "./serve";
import { RunInProgressError } from "./session-service";

const taskId = "9eb6f136-55d6-4cfb-8b1e-71367d7fd6a8";
let error: ReturnType<typeof spyOn>;
beforeEach(() => {
  error = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => error.mockRestore());

const post = (body: unknown, path = "/run") =>
  new Request(`http://agent${path}`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const handler = (runTask: RunTask) => createServeHandler(runTask);

test("GET /health answers 200 and unknown routes 404", async () => {
  const h = handler(mock(async () => "x"));
  expect((await h(new Request("http://agent/health"))).status).toBe(200);
  expect((await h(new Request("http://agent/nope"))).status).toBe(404);
  expect((await h(new Request("http://agent/run"))).status).toBe(404);
});

test("POST /run runs the task and returns its reply", async () => {
  const runTask = mock<RunTask>(async () => "the reply");
  const res = await handler(runTask)(post({ taskId: taskId.toUpperCase(), sessionId: "s1" }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ reply: "the reply" });
  expect(runTask).toHaveBeenCalledWith({ taskId, sessionId: "s1" }, expect.any(AbortSignal));
});

for (const body of [
  "not json",
  {},
  { taskId: "nope" },
  { taskId, sessionId: "" },
  { taskId, budgetMs: 0 },
  { taskId, budgetMs: -5 },
  { taskId, budgetMs: 1.5 },
  { taskId, budgetMs: "60000" },
]) {
  test(`rejects the body ${JSON.stringify(body)} with 400 before running`, async () => {
    const runTask = mock<RunTask>(async () => "x");
    expect((await handler(runTask)(post(body))).status).toBe(400);
    expect(runTask).not.toHaveBeenCalled();
  });
}

test("a run already in progress answers 409", async () => {
  const res = await handler(async () => Promise.reject(new RunInProgressError()))(post({ taskId }));
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "run_in_progress" });
});

test("any other failure answers 500 run_failed and logs the cause", async () => {
  const failure = new Error("boom");
  const res = await handler(async () => Promise.reject(failure))(post({ taskId }));
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: "run_failed" });
  expect(error).toHaveBeenCalledWith(failure);
});

test("a run stopped by its budget answers 504 quick_timeout", async () => {
  const runTask: RunTask = (_input, signal) =>
    new Promise((_resolve, reject) =>
      signal?.addEventListener("abort", () => reject(new Error("aborted"))),
    );
  const res = await handler(runTask)(post({ taskId, budgetMs: 20 }));
  expect(res.status).toBe(504);
  expect(await res.json()).toEqual({ error: "quick_timeout" });
});

test("a run that fails before its budget is a 500, not a timeout", async () => {
  const res = await handler(async () => Promise.reject(new Error("boom")))(
    post({ taskId, budgetMs: 60_000 }),
  );
  expect(res.status).toBe(500);
});

test("the budget is passed as an abort signal and capped at the maximum", async () => {
  const timeout = spyOn(AbortSignal, "timeout");
  const runTask = mock<RunTask>(async () => "x");
  await handler(runTask)(post({ taskId, budgetMs: MAX_BUDGET_MS * 10 }));
  expect(timeout).toHaveBeenCalledWith(MAX_BUDGET_MS);
  expect(runTask.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);
  timeout.mockRestore();
});

test("a run without a budget still gets the maximum one", async () => {
  const timeout = spyOn(AbortSignal, "timeout");
  const runTask = mock<RunTask>(async () => "x");
  await handler(runTask)(post({ taskId }));
  expect(timeout).toHaveBeenCalledWith(MAX_BUDGET_MS);
  timeout.mockRestore();
});

test("a caller that disconnects stops the run", async () => {
  const controller = new AbortController();
  let stopped = false;
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  const runTask: RunTask = (_input, signal) =>
    new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        stopped = true;
        reject(new Error("aborted"));
      });
      started();
    });
  const req = new Request("http://agent/run", {
    method: "POST",
    body: JSON.stringify({ taskId }),
    signal: controller.signal,
  });
  const pending = handler(runTask)(req);
  await running;
  controller.abort();
  await pending;
  expect(stopped).toBe(true);
});
