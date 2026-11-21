import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";

import type { BaseLlm } from "@google/adk";

import {
  createGetMessage,
  createGetMessageModel,
  main,
  registerMain,
  runTask,
  serveMain,
} from "./cli";
import { ModelUnavailableError } from "./provider-models";
import { createServeHandler } from "./serve";
import type { TaskContract } from "./task-contract";

const taskId = "9eb6f136-55d6-4cfb-8b1e-71367d7fd6a8";
let log: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;
beforeEach(() => {
  log = spyOn(console, "log").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  log.mockRestore();
  error.mockRestore();
});
const noMessage = async () => undefined;
const setup = () => ({
  run: mock(async (_prompt: string) => "reply"),
  get: mock(async (_id: string): Promise<TaskContract | undefined> => ({
    taskId,
    prompt: "  stored prompt  ",
    jobName: "my-job",
  })),
});

test("loads the contract by normalized TASK_ID and runs its exact prompt", async () => {
  const { run, get } = setup();
  expect(
    await main(
      { TASK_ID: taskId.toUpperCase(), AGENT_MESSAGE: "ignore this" },
      run,
      get,
      noMessage,
    ),
  ).toBe(0);
  expect(get).toHaveBeenCalledWith(taskId);
  expect(run).toHaveBeenCalledWith("  stored prompt  ", taskId, undefined, undefined);
  expect(log).toHaveBeenCalledWith("reply");
});

for (const id of [undefined, "", "   ", "invalid-id"]) {
  test(`rejects TASK_ID ${JSON.stringify(id)} before reading or running`, async () => {
    const { run, get } = setup();
    expect(await main({ TASK_ID: id, AGENT_MESSAGE: "no fallback" }, run, get, noMessage)).toBe(1);
    expect(get).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });
}

test("fails before model execution for an absent contract", async () => {
  const { run, get } = setup();
  get.mockResolvedValue(undefined);
  expect(await main({ TASK_ID: taskId }, run, get, noMessage)).toBe(1);
  expect(run).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalled();
});

for (const prompt of [undefined, null, 42, "", "   ", "x".repeat(10_001)]) {
  test(`rejects stored prompt ${typeof prompt}:${String(prompt).slice(0, 10)}`, async () => {
    const { run, get } = setup();
    get.mockResolvedValue({ taskId, prompt } as TaskContract);
    expect(await main({ TASK_ID: taskId }, run, get, noMessage)).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });
}

test("logs read failures and never invokes the agent", async () => {
  const { run, get } = setup();
  const failure = new Error("read failed");
  get.mockRejectedValue(failure);
  expect(await main({ TASK_ID: taskId }, run, get, noMessage)).toBe(1);
  expect(run).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith(failure);
});

test("logs agent failures and returns 1", async () => {
  const { run, get } = setup();
  const failure = new Error("agent failed");
  run.mockRejectedValue(failure);
  expect(await main({ TASK_ID: taskId }, run, get, noMessage)).toBe(1);
  expect(error).toHaveBeenCalledWith(failure);
});

test("resumes SESSION_ID with its queued message instead of the stored prompt", async () => {
  const { run, get } = setup();
  const message = mock(async (_taskId: string, _sessionId: string) => "answer");
  expect(await main({ TASK_ID: taskId, SESSION_ID: "s1" }, run, get, message)).toBe(0);
  expect(message).toHaveBeenCalledWith(taskId, "s1");
  expect(run).toHaveBeenCalledWith("answer", taskId, "s1", undefined);
});

test("fails when SESSION_ID is set without a queued message", async () => {
  const { run, get } = setup();
  expect(await main({ TASK_ID: taskId, SESSION_ID: "s1" }, run, get, noMessage)).toBe(1);
  expect(run).not.toHaveBeenCalled();
});

test("runs the agent named by the task contract, also when resuming", async () => {
  const run = mock(async (..._args: unknown[]) => "reply");
  const get = mock(async (_id: string): Promise<TaskContract | undefined> => ({
    taskId,
    prompt: "p",
    jobName: "my-job",
    agentName: "researcher",
  }));
  expect(await main({ TASK_ID: taskId }, run, get, noMessage)).toBe(0);
  expect(run).toHaveBeenLastCalledWith("p", taskId, undefined, "researcher");
  expect(await main({ TASK_ID: taskId, SESSION_ID: "s1" }, run, get, async () => "m")).toBe(0);
  expect(run).toHaveBeenLastCalledWith("m", taskId, "s1", "researcher");
});

test("register mode records the agents for JOB_NAME and reports success", async () => {
  const register = mock(async (_job: string, _agents: unknown[]) => {});
  const agents = [{ name: "assistant" }, { name: "researcher" }];
  expect(await registerMain({ JOB_NAME: "my-job" }, register, agents)).toBe(0);
  expect(register).toHaveBeenCalledWith("my-job", agents);
  expect(log).toHaveBeenCalledWith("Registered assistant, researcher");
});

test("register mode needs JOB_NAME and fails when storing fails", async () => {
  const register = mock(async (_job: string, _agents: unknown[]) => {});
  expect(await registerMain({}, register, [])).toBe(1);
  expect(register).not.toHaveBeenCalled();
  register.mockRejectedValueOnce(new Error("store down"));
  expect(await registerMain({ JOB_NAME: "j" }, register, [])).toBe(1);
});

test("createGetMessage reads the queued message of the session in the stage app", async () => {
  const pendingMessage = mock(async (_key: unknown) => "queued");
  const findOwner = async () => undefined;
  expect(await createGetMessage({ findOwner, pendingMessage })(taskId, "s1")).toBe("queued");
  expect(pendingMessage).toHaveBeenCalledWith({
    appName: "stage",
    userId: "user",
    sessionId: "s1",
  });
});

test("createGetMessage reads a session created under another app name", async () => {
  const pendingMessage = mock(async (_key: unknown) => "queued");
  const findOwner = async () => ({ appName: "agent-jobs", userId: "user" });
  await createGetMessage({ findOwner, pendingMessage })(taskId, "s1");
  expect(pendingMessage).toHaveBeenCalledWith({
    appName: "agent-jobs",
    userId: "user",
    sessionId: "s1",
  });
});

const ref = { providerId: "5f4c3d1e-9b0a-4d2e-8a37-1c6f2b9e7a10", model: "gemini-2.5-flash" };
const defaultRef = { ...ref, model: "gemini-2.5-pro" };
const llm = (model: string) => ({ model }) as BaseLlm;
const withDefault = (defaultModel?: typeof ref) =>
  mock(async (_id: string): Promise<TaskContract | undefined> => ({
    taskId,
    prompt: "p",
    jobName: "my-job",
    ...(defaultModel && { defaultModel }),
  }));
const resolverFor = () => mock(async (r: typeof ref) => llm(r.model));
// The model the run asks for: the fifth argument is how the agent resolves it.
const resolved = async (run: ReturnType<typeof mock<(...a: unknown[]) => Promise<string>>>) =>
  (run.mock.calls.at(-1)?.[4] as (() => Promise<BaseLlm | undefined>) | undefined)?.();

test("a resumed message runs on the model queued with it, before the task default", async () => {
  const run = mock(async (..._args: unknown[]) => "reply");
  const resolve = resolverFor();
  const getMessageModel = mock(async (_sessionId: string) => ref);
  expect(
    await main(
      { TASK_ID: taskId, SESSION_ID: "s1" },
      run,
      withDefault(defaultRef),
      async () => "m",
      getMessageModel,
      resolve,
    ),
  ).toBe(0);
  expect(getMessageModel).toHaveBeenCalledWith("s1");
  expect((await resolved(run))?.model).toBe(ref.model);
  expect(resolve).toHaveBeenCalledWith(ref);
});

test("without a message model the task default model is used", async () => {
  const run = mock(async (..._args: unknown[]) => "reply");
  const resolve = resolverFor();
  await main(
    { TASK_ID: taskId, SESSION_ID: "s1" },
    run,
    withDefault(defaultRef),
    async () => "m",
    async () => undefined,
    resolve,
  );
  expect((await resolved(run))?.model).toBe(defaultRef.model);
  const first = mock(async (..._args: unknown[]) => "reply");
  await main(
    { TASK_ID: taskId },
    first,
    withDefault(defaultRef),
    noMessage,
    async () => undefined,
    resolve,
  );
  expect((await resolved(first))?.model).toBe(defaultRef.model);
});

test("with neither, the run asks for no model and uses the job default", async () => {
  const run = mock(async (..._args: unknown[]) => "reply");
  await main(
    { TASK_ID: taskId, SESSION_ID: "s1" },
    run,
    withDefault(),
    async () => "m",
    async () => undefined,
    resolverFor(),
  );
  expect(run).toHaveBeenLastCalledWith("m", taskId, "s1", undefined);
});

test("a task default that cannot be used is skipped with a warning, the run goes on", async () => {
  const run = mock(async (..._args: unknown[]) => "reply");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const resolve = mock(async (_r: typeof ref): Promise<BaseLlm> => {
    throw new ModelUnavailableError("Provider is disabled");
  });
  expect(
    await main(
      { TASK_ID: taskId },
      run,
      withDefault(defaultRef),
      noMessage,
      async () => undefined,
      resolve,
    ),
  ).toBe(0);
  expect(await resolved(run)).toBeUndefined();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("Provider is disabled"));
  warn.mockRestore();
});

test("a message model that cannot be used fails the run", async () => {
  const run = mock(async (..._args: unknown[]) => "reply");
  const resolve = mock(async (_r: typeof ref): Promise<BaseLlm> => {
    throw new ModelUnavailableError("Model is switched off");
  });
  await main(
    { TASK_ID: taskId, SESSION_ID: "s1" },
    run,
    withDefault(defaultRef),
    async () => "m",
    async () => ref,
    resolve,
  );
  await expect(resolved(run)).rejects.toThrow("switched off");
});

test("createGetMessageModel reads the model queued for the session, under its owner", async () => {
  const pendingModel = mock(async (_key: unknown) => ref);
  const findOwner = async () => ({ appName: "agent-jobs", userId: "user" });
  expect(await createGetMessageModel({ findOwner, pendingModel })("s1")).toEqual(ref);
  expect(pendingModel).toHaveBeenCalledWith({
    appName: "agent-jobs",
    userId: "user",
    sessionId: "s1",
  });
});

test("runTask runs a task for the given ids and returns the reply", async () => {
  const { run, get } = setup();
  expect(await runTask({ taskId }, run, get, noMessage)).toBe("reply");
  expect(run).toHaveBeenCalledWith("  stored prompt  ", taskId, undefined, undefined);
  expect(await runTask({ taskId, sessionId: "s1" }, run, get, async () => "m")).toBe("reply");
  expect(run).toHaveBeenLastCalledWith("m", taskId, "s1", undefined);
});

test("runTask throws instead of returning a code, and forwards the abort signal", async () => {
  const { run, get } = setup();
  get.mockResolvedValue(undefined);
  await expect(runTask({ taskId }, run, get, noMessage)).rejects.toThrow("contract not found");
  expect(run).not.toHaveBeenCalled();

  const signal = new AbortController().signal;
  const ok = setup();
  await runTask({ taskId }, ok.run, ok.get, noMessage, async () => undefined, undefined, signal);
  expect(ok.run).toHaveBeenCalledWith(
    "  stored prompt  ",
    taskId,
    undefined,
    undefined,
    undefined,
    signal,
  );
});

test("register mode drops quick unless AGENT_QUICK is true", async () => {
  const register = mock(async (_job: string, _agents: unknown[]) => {});
  const agents = [
    { name: "both", modes: ["quick", "workflow"] as ("quick" | "workflow")[] },
    { name: "only-quick", modes: ["quick"] as ("quick" | "workflow")[] },
    { name: "plain" },
  ];
  await registerMain({ JOB_NAME: "j" }, register, agents);
  expect(register).toHaveBeenLastCalledWith("j", [
    { name: "both", modes: ["workflow"] },
    { name: "only-quick" },
    { name: "plain" },
  ]);
  await registerMain({ JOB_NAME: "j", AGENT_QUICK: "true" }, register, agents);
  expect(register).toHaveBeenLastCalledWith("j", agents);
});

test("serve mode answers GET /health on PORT", async () => {
  const server = serveMain(
    { PORT: "0" },
    createServeHandler(async () => "x"),
  );
  try {
    const res = await fetch(`http://localhost:${server.port}/health`);
    expect(res.status).toBe(200);
  } finally {
    await server.stop(true);
  }
});

test("serve mode refuses a request body far larger than a run request", async () => {
  const server = serveMain(
    { PORT: "0" },
    createServeHandler(async () => "x"),
  );
  try {
    const res = await fetch(`http://localhost:${server.port}/run`, {
      method: "POST",
      body: JSON.stringify({
        taskId: "9eb6f136-55d6-4cfb-8b1e-71367d7fd6a8",
        pad: "x".repeat(100_000),
      }),
    }).catch(() => undefined);
    expect(res === undefined || res.status === 413).toBe(true);
  } finally {
    await server.stop(true);
  }
});

test("serve mode raises Bun's idle timeout above the longest quick run", async () => {
  const serve = spyOn(Bun, "serve");
  const server = serveMain(
    { PORT: "0" },
    createServeHandler(async () => "x"),
  );
  try {
    expect(serve).toHaveBeenCalledWith(expect.objectContaining({ idleTimeout: 255 }));
  } finally {
    await server.stop(true);
    serve.mockRestore();
  }
});
