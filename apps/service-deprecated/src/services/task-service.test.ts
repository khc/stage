import { expect, mock, spyOn, test } from "bun:test";

import { MessageQueuedError, RunInProgressError } from "@stage/agents/session-service";

import { DependencyError } from "../errors";
import type { DocumentStore } from "../stores/document-store";
import type { SessionStore } from "../stores/session-store";
import type { TaskContract } from "../stores/task-store";
import { createTaskService, type TaskServiceDeps } from "./task-service";

const taskId = "9eb6f136-55d6-4cfb-8b1e-71367d7fd6a8";

// Stubs for only the methods a test uses; the rest of each dependency stays empty.
type Stubs = {
  [K in keyof TaskServiceDeps]?: Partial<NonNullable<TaskServiceDeps[K]>>;
};
const serviceWith = (stubs: Stubs) =>
  createTaskService({
    tasks: {},
    jobs: {},
    sessions: {},
    registry: { list: async () => [] },
    ...stubs,
  } as TaskServiceDeps);
const runTask = (stubs: Stubs, id: string, body?: Record<string, unknown>) =>
  serviceWith(stubs).run(id, body);
const deleteTaskWithSessions = (stubs: Stubs, id: string) => serviceWith(stubs).delete(id);

// ---- run

const task: TaskContract = { taskId, prompt: "p", jobName: "my-job" };

const setupRun = (
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
  const { deps, runJob, queueMessage } = setupRun();
  expect(await runTask(deps, taskId)).toEqual({ status: "started", operation: "op-1" });
  expect(runJob).toHaveBeenCalledWith("my-job", taskId);
  expect(queueMessage).not.toHaveBeenCalled();
});

test("reports a missing task and a task without a job", async () => {
  expect(await runTask(setupRun({ task: undefined }).deps, taskId)).toEqual({
    status: "task_not_found",
  });
  const { deps, runJob } = setupRun({ task: { taskId, prompt: "p" } });
  expect(await runTask(deps, taskId)).toEqual({ status: "task_not_executable" });
  expect(runJob).not.toHaveBeenCalled();
});

test("a failing task lookup is a task_error dependency failure", async () => {
  const { deps, getTask } = setupRun();
  getTask.mockRejectedValue(new Error("firestore down"));
  const err = await rejection(runTask(deps, taskId));
  expect(err).toBeInstanceOf(DependencyError);
  expect((err as DependencyError).code).toBe("task_error");
});

test("resumes a session: queues the trimmed message, then starts the job with only the session id", async () => {
  const { deps, runJob, queueMessage } = setupRun();
  const result = await runTask(deps, taskId, { sessionId: "s1", message: "  answer  " });
  expect(result).toEqual({ status: "started", operation: "op-1" });
  expect(queueMessage).toHaveBeenCalledWith(taskId, "s1", "answer");
  expect(runJob).toHaveBeenCalledWith("my-job", taskId, "s1");
});

test("a resume without a valid message is invalid and queues nothing", async () => {
  const { deps, queueMessage, runJob } = setupRun();
  const result = await runTask(deps, taskId, { sessionId: "s1", message: " " });
  expect(result.status).toBe("invalid_resume");
  expect(queueMessage).not.toHaveBeenCalled();
  expect(runJob).not.toHaveBeenCalled();
});

test("a missing session, or one that is not the task's, is session_not_found", async () => {
  expect(
    await runTask(setupRun({ session: undefined }).deps, taskId, { sessionId: "s1", message: "m" }),
  ).toEqual({
    status: "session_not_found",
  });
  const { deps, runJob } = setupRun({ queue: async () => false });
  expect(await runTask(deps, taskId, { sessionId: "s1", message: "m" })).toEqual({
    status: "session_not_found",
  });
  expect(runJob).not.toHaveBeenCalled();
});

test("a running session, or a message still waiting, stops the resume before the job", async () => {
  const running = setupRun({ session: { id: "s1", run: { status: "running", startedAt: 1 } } });
  expect(await runTask(running.deps, taskId, { sessionId: "s1", message: "m" })).toEqual({
    status: "run_in_progress",
  });
  expect(running.queueMessage).not.toHaveBeenCalled();

  const lease = setupRun({ queue: async () => Promise.reject(new RunInProgressError()) });
  expect(await runTask(lease.deps, taskId, { sessionId: "s1", message: "m" })).toEqual({
    status: "run_in_progress",
  });

  const pending = setupRun({ queue: async () => Promise.reject(new MessageQueuedError()) });
  expect(await runTask(pending.deps, taskId, { sessionId: "s1", message: "m" })).toEqual({
    status: "message_pending",
  });
  expect(pending.runJob).not.toHaveBeenCalled();
});

test("any other session failure is a session_error dependency failure", async () => {
  const { deps } = setupRun({ queue: async () => Promise.reject(new Error("firestore down")) });
  const err = await rejection(runTask(deps, taskId, { sessionId: "s1", message: "m" }));
  expect((err as DependencyError).code).toBe("session_error");
});

test("when the job cannot start, a queued message is cleared and the failure is a job_error", async () => {
  const resumed = setupRun();
  resumed.runJob.mockRejectedValue(new Error("cloud run down"));
  const err = await rejection(runTask(resumed.deps, taskId, { sessionId: "s1", message: "m" }));
  expect((err as DependencyError).code).toBe("job_error");
  expect(resumed.clearMessage).toHaveBeenCalledWith(taskId, "s1");

  const fresh = setupRun();
  fresh.runJob.mockRejectedValue(new Error("cloud run down"));
  await rejection(runTask(fresh.deps, taskId));
  expect(fresh.clearMessage).not.toHaveBeenCalled();
});

test("a failing clear of the queued message is only logged", async () => {
  const { deps, runJob, clearMessage } = setupRun();
  runJob.mockRejectedValue(new Error("cloud run down"));
  clearMessage.mockRejectedValue(new Error("firestore down"));
  const spy = spyOn(console, "error").mockImplementation(() => {});
  const err = await rejection(runTask(deps, taskId, { sessionId: "s1", message: "m" }));
  expect((err as DependencyError).code).toBe("job_error");
  expect(spy).toHaveBeenCalled();
  spy.mockRestore();
});

// ---- create

const created = (agents: string[]) => {
  const create = mock(async (input: { prompt: string; jobName: string; agentName?: string }) => ({
    taskId,
    ...input,
  }));
  const list = mock(async (_job: string) => agents.map((name) => ({ name })));
  return { service: serviceWith({ tasks: { create }, registry: { list } }), create, list };
};

test("create saves the task and returns it", async () => {
  const { service, create } = created([]);
  const result = await service.create({ prompt: "p", jobName: "my-job" });
  expect(result).toEqual({ status: "created", task: { taskId, prompt: "p", jobName: "my-job" } });
  expect(create).toHaveBeenCalledTimes(1);
});

test("create rejects an agent the job has not registered, and saves nothing", async () => {
  const { service, create } = created(["assistant", "researcher"]);
  expect(await service.create({ prompt: "p", jobName: "my-job", agentName: "ghost" })).toEqual({
    status: "unknown_agent",
  });
  expect(create).not.toHaveBeenCalled();
  const ok = await service.create({ prompt: "p", jobName: "my-job", agentName: "researcher" });
  expect(ok.status).toBe("created");
});

test("create accepts any agent name for a job with no registration", async () => {
  const { service } = created([]);
  const result = await service.create({ prompt: "p", jobName: "my-job", agentName: "anything" });
  expect(result.status).toBe("created");
});

test("a failing save or registry lookup is a task_error dependency failure", async () => {
  const { service, create } = created([]);
  create.mockRejectedValue(new Error("firestore down"));
  const err = await service.create({ prompt: "p", jobName: "my-job" }).then(
    () => undefined,
    (e) => e,
  );
  expect(err).toBeInstanceOf(DependencyError);
  expect((err as DependencyError).code).toBe("task_error");
});

// ---- delete

const setupDelete = (found = true) => {
  const order: string[] = [];
  const sessionsDelete = mock(async (_t: string, id: string) => {
    order.push(`session ${id}`);
    return true;
  });
  const sessions = {
    list: async () => [{ id: "s1" }, { id: "s2" }],
    delete: sessionsDelete,
  } as unknown as SessionStore;
  const deleteTask = mock(async (_id: string) => {
    order.push("task");
    return true;
  });
  const release = mock(async (_ids: string[]) => {
    order.push("documents");
  });
  const documents = { release } as unknown as DocumentStore;
  const getTask = async () =>
    found ? { taskId, prompt: "p", documents: [{ documentId: "d1" }] } : undefined;
  return {
    deps: { tasks: { get: getTask, delete: deleteTask }, sessions, documents },
    order,
    deleteTask,
    release,
    sessionsDelete,
  };
};

test("deletes the sessions first, then the task, then releases its documents", async () => {
  const { deps, order, release } = setupDelete();
  expect(await deleteTaskWithSessions(deps, taskId)).toBe("deleted");
  expect(order).toEqual(["session s1", "session s2", "task", "documents"]);
  expect(release).toHaveBeenCalledWith(["d1"]);
});

test("a missing task deletes nothing", async () => {
  const { deps, deleteTask, sessionsDelete } = setupDelete(false);
  expect(await deleteTaskWithSessions(deps, taskId)).toBe("not_found");
  expect(deleteTask).not.toHaveBeenCalled();
  expect(sessionsDelete).not.toHaveBeenCalled();
});

test("a failing session delete leaves the task in place and is a task_error", async () => {
  const { deps, deleteTask, sessionsDelete } = setupDelete();
  sessionsDelete.mockRejectedValue(new Error("firestore down"));
  const err = await deleteTaskWithSessions(deps, taskId).then(
    () => undefined,
    (e) => e,
  );
  expect(err).toBeInstanceOf(DependencyError);
  expect((err as DependencyError).code).toBe("task_error");
  expect(deleteTask).not.toHaveBeenCalled();
});

test("a failing document release is only logged, since the task is already gone", async () => {
  const { deps, release } = setupDelete();
  release.mockRejectedValue(new Error("firestore down"));
  const spy = spyOn(console, "error").mockImplementation(() => {});
  expect(await deleteTaskWithSessions(deps, taskId)).toBe("deleted");
  expect(spy).toHaveBeenCalled();
  spy.mockRestore();
});
