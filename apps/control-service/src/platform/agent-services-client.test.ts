import { afterEach, expect, mock, spyOn, test } from "bun:test";

import { createServeHandler, type RunTask } from "@stage/agents/serve";
import { RunInProgressError } from "@stage/agents/session-service";

import { createAgentServices, QuickTimeoutError, RunFailedError } from "./agent-services-client";

let spy: ReturnType<typeof spyOn> | undefined;
afterEach(() => spy?.mockRestore());

const taskId = "9eb6f136-55d6-4cfb-8b1e-71367d7fd6a8";
const respond = (response: Response) => {
  const fetch = mock(async (_url: string, _init?: RequestInit) => response);
  spy = spyOn(globalThis, "fetch").mockImplementation(fetch as unknown as typeof globalThis.fetch);
  return fetch;
};
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e) => e,
  );

test("has() tells which jobs have a service", () => {
  const services = createAgentServices(
    { "generic-agents": "http://generic:8080" },
    { timeoutMs: 1000 },
  );
  expect(services.has("generic-agents")).toBe(true);
  expect(services.has("poet-agents")).toBe(false);
});

test("run posts the task, session and budget to <url>/run, with no credentials by default", async () => {
  const fetch = respond(Response.json({ reply: "hi" }));
  const services = createAgentServices({ job: "http://svc:8080/" }, { timeoutMs: 5000 });
  await services.run("job", taskId, "s1");
  const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("http://svc:8080/run");
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body as string)).toEqual({ taskId, sessionId: "s1", budgetMs: 5000 });
  expect(init.signal).toBeInstanceOf(AbortSignal);
  expect(init.headers).not.toHaveProperty("authorization");
});

test("sends an Authorization header made once per job for its URL when configured", async () => {
  const fetch = respond(Response.json({ reply: "hi" }));
  const header = mock(async () => "Bearer id-token");
  const authorization = mock((_audience: string) => header);
  const services = createAgentServices(
    { a: "https://a.run.app", b: "https://b.run.app" },
    { timeoutMs: 1000, authorization },
  );
  await services.run("a", taskId);
  await services.run("a", taskId);
  await services.run("b", taskId);
  expect(authorization.mock.calls.map(([audience]) => audience)).toEqual([
    "https://a.run.app",
    "https://b.run.app",
  ]);
  expect((fetch.mock.calls[0] as [string, RequestInit])[1].headers).toMatchObject({
    authorization: "Bearer id-token",
  });
});

test("a 409 is a lease conflict", async () => {
  respond(Response.json({ error: "run_in_progress" }, { status: 409 }));
  const err = await rejection(
    createAgentServices({ job: "http://svc" }, { timeoutMs: 1000 }).run("job", taskId),
  );
  expect(err).toBeInstanceOf(RunInProgressError);
});

test("a 504 from the service is a quick timeout", async () => {
  respond(Response.json({ error: "quick_timeout" }, { status: 504 }));
  const err = await rejection(
    createAgentServices({ job: "http://svc" }, { timeoutMs: 1000 }).run("job", taskId),
  );
  expect(err).toBeInstanceOf(QuickTimeoutError);
});

test("the client's own timeout is a quick timeout", async () => {
  spy = spyOn(globalThis, "fetch").mockImplementation(
    ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) =>
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason)),
      )) as unknown as typeof globalThis.fetch,
  );
  const err = await rejection(
    createAgentServices({ job: "http://svc" }, { timeoutMs: 20 }).run("job", taskId),
  );
  expect(err).toBeInstanceOf(QuickTimeoutError);
});

test("a caller abort aborts the upstream request without turning into QuickTimeoutError", async () => {
  const controller = new AbortController();
  spy = spyOn(globalThis, "fetch").mockImplementation(
    ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) =>
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason)),
      )) as unknown as typeof globalThis.fetch,
  );
  const promise = createAgentServices({ job: "http://svc" }, { timeoutMs: 5000 }).run(
    "job",
    taskId,
    "s1",
    controller.signal,
  );
  controller.abort(new DOMException("Client disconnected", "AbortError"));
  const err = await rejection(promise);
  expect(err).not.toBeInstanceOf(QuickTimeoutError);
  expect(err).toMatchObject({ name: "AbortError" });
});

test("a run that started and failed is a RunFailedError, not a service failure", async () => {
  respond(Response.json({ error: "run_failed" }, { status: 500 }));
  const err = await rejection(
    createAgentServices({ job: "http://svc" }, { timeoutMs: 1000 }).run("job", taskId),
  );
  expect(err).toBeInstanceOf(RunFailedError);
});

test("a redirect is refused, so the Authorization header goes only to the configured URL", async () => {
  const fetch = respond(Response.json({ reply: "hi" }));
  await createAgentServices({ job: "http://svc" }, { timeoutMs: 1000 }).run("job", taskId);
  expect((fetch.mock.calls[0] as [string, RequestInit])[1].redirect).toBe("error");
});

test("an ID token is sent only over https", () => {
  const authorization = () => async () => "Bearer id-token";
  expect(() =>
    createAgentServices({ job: "http://svc" }, { timeoutMs: 1000, authorization }),
  ).toThrow("https");
  expect(() =>
    createAgentServices({ job: "https://svc.run.app" }, { timeoutMs: 1000, authorization }),
  ).not.toThrow();
});

test("any other failure is an Error, not a timeout or a conflict", async () => {
  respond(Response.json({ error: "boom" }, { status: 500 }));
  const err = await rejection(
    createAgentServices({ job: "http://svc" }, { timeoutMs: 1000 }).run("job", taskId),
  );
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(QuickTimeoutError);
  expect(err).not.toBeInstanceOf(RunInProgressError);

  spy!.mockImplementation((async () =>
    Promise.reject(new TypeError("connection refused"))) as never);
  expect(
    await rejection(
      createAgentServices({ job: "http://svc" }, { timeoutMs: 1000 }).run("job", taskId),
    ),
  ).toBeInstanceOf(TypeError);
});

// The client against the real handler of the service, to cover the /run body contract.
const serve = (runTask: RunTask) => {
  const server = Bun.serve({ port: 0, fetch: createServeHandler(runTask) });
  return {
    server,
    services: createAgentServices({ job: `http://localhost:${server.port}` }, { timeoutMs: 200 }),
  };
};

test("against the real serve handler: runs, conflicts and budget timeouts map through", async () => {
  const seen: unknown[] = [];
  const ok = serve(async (input) => {
    seen.push(input);
    return "reply";
  });
  await ok.services.run("job", taskId.toUpperCase(), "s1");
  expect(seen).toEqual([{ taskId, sessionId: "s1" }]);
  await ok.server.stop(true);

  const conflict = serve(async () => Promise.reject(new RunInProgressError()));
  expect(await rejection(conflict.services.run("job", taskId))).toBeInstanceOf(RunInProgressError);
  await conflict.server.stop(true);

  const slow = serve(
    (_input, signal) =>
      new Promise((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      ),
  );
  expect(await rejection(slow.services.run("job", taskId))).toBeInstanceOf(QuickTimeoutError);
  await slow.server.stop(true);

  const failing = serve(async () => Promise.reject(new Error("model exploded")));
  const spyError = spyOn(console, "error").mockImplementation(() => {});
  expect(await rejection(failing.services.run("job", taskId))).toBeInstanceOf(RunFailedError);
  spyError.mockRestore();
  await failing.server.stop(true);
});
