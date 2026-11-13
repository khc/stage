import { expect, mock, spyOn, test } from "bun:test";

import { MessageQueuedError, RunInProgressError } from "@stage/agents/session-service";

import { DependencyError } from "../errors";
import type { SessionStore } from "../stores/session-store";
import type { TaskContract } from "../stores/task-store";
import { runTask } from "./run-task";

const taskId = "9eb6f136-55d6-4cfb-8b1e-71367d7fd6a8";
const task: TaskContract = { taskId, prompt: "p", jobName: "my-job" };

const setup = (
  overrides: {
    task?: TaskContract | undefined;
    session?: unknown;
    queue?: () => Promise<boolean>;
  } = {},
) => {
  const runJob = mock(async (..._args: unknown[]) => "op-1");
  const getTask = mock(async (_id: string) => ("task" in overrides ? overrides.task : task));
  const get = mock(async (_t: string, _s: string) =>
    "session" in overrides ? overrides.session : ({ id: "s1" } as never),
  );
  const queueMessage = mock(async (_t: string, _s: string, _m: string) =>
    (overrides.queue ?? (async () => true))(),
  );
  const clearMessage = mock(async (_t: string, _s: string) => {});
  const sessions = {
    list: async () => [],
    get,
    delete: async () => false,
    queueMessage,
    clearMessage,
  } as SessionStore;
  return {
    deps: { tasks: { get: getTask }, jobs: { run: runJob }, sessions },
    getTask,
    runJob,
    queueMessage,
    clearMessage,
  };
};

const rejection = async (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e) => e,
  );

test("starts a new session from the stored prompt without a resume", async () => {
  const { deps, runJob, queueMessage } = setup();
  expect(await runTask(deps, taskId)).toEqual({ status: "started", operation: "op-1" });
  expect(runJob).toHaveBeenCalledWith("my-job", taskId);
  expect(queueMessage).not.toHaveBeenCalled();
});

test("reports a missing task and a task without a job", async () => {
  expect(await runTask(setup({ task: undefined }).deps, taskId)).toEqual({
    status: "task_not_found",
  });
  const { deps, runJob } = setup({ task: { taskId, prompt: "p" } });
  expect(await runTask(deps, taskId)).toEqual({ status: "task_not_executable" });
  expect(runJob).not.toHaveBeenCalled();
});

test("a failing task lookup is a task_error dependency failure", async () => {
  const { deps, getTask } = setup();
  getTask.mockRejectedValue(new Error("firestore down"));
  const err = await rejection(runTask(deps, taskId));
  expect(err).toBeInstanceOf(DependencyError);
  expect((err as DependencyError).code).toBe("task_error");
});

test("resumes a session: queues the trimmed message, then starts the job with only the session id", async () => {
  const { deps, runJob, queueMessage } = setup();
  const result = await runTask(deps, taskId, { sessionId: "s1", message: "  answer  " });
  expect(result).toEqual({ status: "started", operation: "op-1" });
  expect(queueMessage).toHaveBeenCalledWith(taskId, "s1", "answer");
  expect(runJob).toHaveBeenCalledWith("my-job", taskId, "s1");
});

test("a resume without a valid message is invalid and queues nothing", async () => {
  const { deps, queueMessage, runJob } = setup();
  const result = await runTask(deps, taskId, { sessionId: "s1", message: " " });
  expect(result.status).toBe("invalid_resume");
  expect(queueMessage).not.toHaveBeenCalled();
  expect(runJob).not.toHaveBeenCalled();
});

test("a missing session, or one that is not the task's, is session_not_found", async () => {
  expect(
    await runTask(setup({ session: undefined }).deps, taskId, { sessionId: "s1", message: "m" }),
  ).toEqual({
    status: "session_not_found",
  });
  const { deps, runJob } = setup({ queue: async () => false });
  expect(await runTask(deps, taskId, { sessionId: "s1", message: "m" })).toEqual({
    status: "session_not_found",
  });
  expect(runJob).not.toHaveBeenCalled();
});

test("a running session, or a message still waiting, stops the resume before the job", async () => {
  const running = setup({ session: { id: "s1", run: { status: "running", startedAt: 1 } } });
  expect(await runTask(running.deps, taskId, { sessionId: "s1", message: "m" })).toEqual({
    status: "run_in_progress",
  });
  expect(running.queueMessage).not.toHaveBeenCalled();

  const lease = setup({ queue: async () => Promise.reject(new RunInProgressError()) });
  expect(await runTask(lease.deps, taskId, { sessionId: "s1", message: "m" })).toEqual({
    status: "run_in_progress",
  });

  const pending = setup({ queue: async () => Promise.reject(new MessageQueuedError()) });
  expect(await runTask(pending.deps, taskId, { sessionId: "s1", message: "m" })).toEqual({
    status: "message_pending",
  });
  expect(pending.runJob).not.toHaveBeenCalled();
});

test("any other session failure is a session_error dependency failure", async () => {
  const { deps } = setup({ queue: async () => Promise.reject(new Error("firestore down")) });
  const err = await rejection(runTask(deps, taskId, { sessionId: "s1", message: "m" }));
  expect((err as DependencyError).code).toBe("session_error");
});

test("when the job cannot start, a queued message is cleared and the failure is a job_error", async () => {
  const resumed = setup();
  resumed.runJob.mockRejectedValue(new Error("cloud run down"));
  const err = await rejection(runTask(resumed.deps, taskId, { sessionId: "s1", message: "m" }));
  expect((err as DependencyError).code).toBe("job_error");
  expect(resumed.clearMessage).toHaveBeenCalledWith(taskId, "s1");

  const fresh = setup();
  fresh.runJob.mockRejectedValue(new Error("cloud run down"));
  await rejection(runTask(fresh.deps, taskId));
  expect(fresh.clearMessage).not.toHaveBeenCalled();
});

test("a failing clear of the queued message is only logged", async () => {
  const { deps, runJob, clearMessage } = setup();
  runJob.mockRejectedValue(new Error("cloud run down"));
  clearMessage.mockRejectedValue(new Error("firestore down"));
  const spy = spyOn(console, "error").mockImplementation(() => {});
  const err = await rejection(runTask(deps, taskId, { sessionId: "s1", message: "m" }));
  expect((err as DependencyError).code).toBe("job_error");
  expect(spy).toHaveBeenCalled();
  spy.mockRestore();
});
