import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { TaskContract } from "./task-contract";
import { main, registerMain } from "./cli";

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
    ),
  ).toBe(0);
  expect(get).toHaveBeenCalledWith(taskId);
  expect(run).toHaveBeenCalledWith(
    "  stored prompt  ",
    taskId,
    undefined,
    undefined,
  );
  expect(log).toHaveBeenCalledWith("reply");
});

for (const id of [undefined, "", "   ", "invalid-id"]) {
  test(`rejects TASK_ID ${JSON.stringify(id)} before reading or running`, async () => {
    const { run, get } = setup();
    expect(
      await main({ TASK_ID: id, AGENT_MESSAGE: "no fallback" }, run, get),
    ).toBe(1);
    expect(get).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });
}

test("fails before model execution for an absent contract", async () => {
  const { run, get } = setup();
  get.mockResolvedValue(undefined);
  expect(await main({ TASK_ID: taskId }, run, get)).toBe(1);
  expect(run).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalled();
});

for (const prompt of [undefined, null, 42, "", "   ", "x".repeat(10_001)]) {
  test(`rejects stored prompt ${typeof prompt}:${String(prompt).slice(0, 10)}`, async () => {
    const { run, get } = setup();
    get.mockResolvedValue({ taskId, prompt } as TaskContract);
    expect(await main({ TASK_ID: taskId }, run, get)).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });
}

test("logs read failures and never invokes the agent", async () => {
  const { run, get } = setup();
  const failure = new Error("read failed");
  get.mockRejectedValue(failure);
  expect(await main({ TASK_ID: taskId }, run, get)).toBe(1);
  expect(run).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith(failure);
});

test("logs agent failures and returns 1", async () => {
  const { run, get } = setup();
  const failure = new Error("agent failed");
  run.mockRejectedValue(failure);
  expect(await main({ TASK_ID: taskId }, run, get)).toBe(1);
  expect(error).toHaveBeenCalledWith(failure);
});

test("resumes SESSION_ID with MESSAGE instead of the stored prompt", async () => {
  const { run, get } = setup();
  expect(
    await main(
      { TASK_ID: taskId, SESSION_ID: "s1", MESSAGE: "answer" },
      run,
      get,
    ),
  ).toBe(0);
  expect(run).toHaveBeenCalledWith("answer", taskId, "s1", undefined);
});

test("fails when SESSION_ID is set without a valid MESSAGE", async () => {
  const { run, get } = setup();
  expect(await main({ TASK_ID: taskId, SESSION_ID: "s1" }, run, get)).toBe(1);
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
  expect(await main({ TASK_ID: taskId }, run, get)).toBe(0);
  expect(run).toHaveBeenLastCalledWith("p", taskId, undefined, "researcher");
  expect(
    await main({ TASK_ID: taskId, SESSION_ID: "s1", MESSAGE: "m" }, run, get),
  ).toBe(0);
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
