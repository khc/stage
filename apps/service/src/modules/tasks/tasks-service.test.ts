import { describe, expect, mock, spyOn, test } from "bun:test";

import { MessageQueuedError, RunInProgressError } from "@stage/agents/session-service";

import { DependencyError } from "../../errors";
import { createTasksService, type TasksServiceDeps } from "./tasks-service";

const taskId = "5f4c3d1e-9b0a-4d2e-8a37-1c6f2b9e7a10";

const setupDelete = (found = true) => {
  const order: string[] = [];
  const sessionsDelete = mock(async (_taskId: string, id: string) => {
    order.push(`session ${id}`);
    return true;
  });
  const deleteTask = mock(async (_id: string) => {
    order.push("task");
    return true;
  });
  const release = mock(async (_ids: string[]) => {
    order.push("documents");
  });
  const deps = {
    tasksStore: {
      get: async () =>
        found ? { taskId, prompt: "p", documents: [{ documentId: "d1" }] } : undefined,
      delete: deleteTask,
    },
    agentRegistry: { list: async () => [] },
    cloudRunJobs: { run: async () => "op" },
    sessionsStore: { list: async () => [{ id: "s1" }, { id: "s2" }], delete: sessionsDelete },
    documentsStore: { release },
  } as unknown as TasksServiceDeps;
  return { service: createTasksService(deps), order, deleteTask, release, sessionsDelete };
};

describe("tasks service delete", () => {
  test("deletes the sessions first, then the task, then releases its documents", async () => {
    const { service, order, release } = setupDelete();
    expect(await service.delete(taskId)).toBe("deleted");
    expect(order).toEqual(["session s1", "session s2", "task", "documents"]);
    expect(release).toHaveBeenCalledWith(["d1"]);
  });

  test("a missing task deletes nothing", async () => {
    const { service, deleteTask, sessionsDelete } = setupDelete(false);
    expect(await service.delete(taskId)).toBe("not_found");
    expect(deleteTask).not.toHaveBeenCalled();
    expect(sessionsDelete).not.toHaveBeenCalled();
  });

  test("a failing session delete leaves the task in place and is a task_error", async () => {
    const { service, deleteTask, sessionsDelete } = setupDelete();
    sessionsDelete.mockRejectedValue(new Error("firestore down"));
    const err = await service.delete(taskId).then(
      () => undefined,
      (e) => e,
    );
    expect(err).toBeInstanceOf(DependencyError);
    expect((err as DependencyError).code).toBe("task_error");
    expect(deleteTask).not.toHaveBeenCalled();
  });

  test("a failing document release is only logged, since the task is already gone", async () => {
    const { service, release } = setupDelete();
    release.mockRejectedValue(new Error("firestore down"));
    const spy = spyOn(console, "error").mockImplementation(() => {});
    expect(await service.delete(taskId)).toBe("deleted");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test("works without a documents store", async () => {
    const { service } = setupDelete();
    const withoutDocuments = createTasksService({
      tasksStore: { get: async () => ({ taskId, prompt: "p" }), delete: async () => true },
      agentRegistry: { list: async () => [] },
      sessionsStore: { list: async () => [], delete: async () => true },
    } as unknown as TasksServiceDeps);
    expect(await withoutDocuments.delete(taskId)).toBe("deleted");
    expect(service).toBeDefined();
  });
});

describe("tasks service create", () => {
  const input = { prompt: "p", jobName: "my-job", agentName: "haiku" };
  const createWith = (registered: string[]) => {
    const create = mock(async (i: typeof input) => ({ ...i, taskId, documents: [] }));
    const service = createTasksService({
      tasksStore: { create },
      agentRegistry: { list: async () => registered.map((name) => ({ name })) },
    } as unknown as TasksServiceDeps);
    return { service, create };
  };

  test("accepts a registered agent", async () => {
    expect((await createWith(["haiku"]).service.create(input)).status).toBe("created");
  });

  test("refuses an unregistered agent when the job has registered agents", async () => {
    const { service, create } = createWith(["other"]);
    expect(await service.create(input)).toEqual({ status: "unknown_agent" });
    expect(create).not.toHaveBeenCalled();
  });

  test("a job without a registration accepts any valid agent name", async () => {
    expect((await createWith([]).service.create(input)).status).toBe("created");
  });
});

describe("tasks service run", () => {
  const task = { taskId, prompt: "p", jobName: "my-job" };
  const setupRun = (
    overrides: { task?: unknown; session?: unknown; queue?: () => Promise<boolean> } = {},
  ) => {
    const runJob = mock(async (..._args: unknown[]) => "op-1");
    const getTask = mock(async (_id: string) => ("task" in overrides ? overrides.task : task));
    const get = mock(async (_t: string, _s: string) =>
      "session" in overrides ? overrides.session : { id: "s1" },
    );
    const queueMessage = mock(async (_t: string, _s: string, _m: string) =>
      (overrides.queue ?? (async () => true))(),
    );
    const clearMessage = mock(async (_t: string, _s: string) => {});
    const service = createTasksService({
      tasksStore: { get: getTask },
      agentRegistry: { list: async () => [] },
      cloudRunJobs: { run: runJob },
      sessionsStore: { get, queueMessage, clearMessage },
    } as unknown as TasksServiceDeps);
    return { service, getTask, runJob, queueMessage, clearMessage };
  };
  const resume = { sessionId: "s1", message: "answer" };
  const rejection = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (e) => e,
    );

  test("starts a new session without a resume", async () => {
    const { service, runJob, queueMessage } = setupRun();
    expect(await service.run(taskId)).toEqual({ status: "started", operation: "op-1" });
    expect(runJob).toHaveBeenCalledWith("my-job", taskId);
    expect(queueMessage).not.toHaveBeenCalled();
  });

  test("reports a missing task, and a task without a valid job name", async () => {
    expect(await setupRun({ task: undefined }).service.run(taskId)).toEqual({
      status: "task_not_found",
    });
    for (const jobName of [undefined, "Bad_Name"]) {
      const { service, runJob } = setupRun({ task: { taskId, prompt: "p", jobName } });
      expect(await service.run(taskId)).toEqual({ status: "task_not_executable" });
      expect(runJob).not.toHaveBeenCalled();
    }
  });

  test("a failing task lookup is a task_error dependency failure", async () => {
    const { service, getTask } = setupRun();
    getTask.mockRejectedValue(new Error("firestore down"));
    const err = await rejection(service.run(taskId));
    expect(err).toBeInstanceOf(DependencyError);
    expect((err as DependencyError).code).toBe("task_error");
  });

  test("resumes a session: queues the message, then starts the job with only the session id", async () => {
    const { service, runJob, queueMessage } = setupRun();
    expect(await service.run(taskId, resume)).toEqual({ status: "started", operation: "op-1" });
    expect(queueMessage).toHaveBeenCalledWith(taskId, "s1", "answer");
    expect(runJob).toHaveBeenCalledWith("my-job", taskId, "s1");
  });

  test("a missing session, or one that is not the task's, is session_not_found", async () => {
    expect(await setupRun({ session: undefined }).service.run(taskId, resume)).toEqual({
      status: "session_not_found",
    });
    const { service, runJob } = setupRun({ queue: async () => false });
    expect(await service.run(taskId, resume)).toEqual({ status: "session_not_found" });
    expect(runJob).not.toHaveBeenCalled();
  });

  test("a running session, or a message still waiting, stops the resume before the job", async () => {
    const running = setupRun({ session: { id: "s1", run: { status: "running", startedAt: 1 } } });
    expect(await running.service.run(taskId, resume)).toEqual({ status: "run_in_progress" });
    expect(running.queueMessage).not.toHaveBeenCalled();

    const lease = setupRun({ queue: async () => Promise.reject(new RunInProgressError()) });
    expect(await lease.service.run(taskId, resume)).toEqual({ status: "run_in_progress" });

    const pending = setupRun({ queue: async () => Promise.reject(new MessageQueuedError()) });
    expect(await pending.service.run(taskId, resume)).toEqual({ status: "message_pending" });
    expect(pending.runJob).not.toHaveBeenCalled();
  });

  test("any other session failure is a session_error dependency failure", async () => {
    const { service } = setupRun({
      queue: async () => Promise.reject(new Error("firestore down")),
    });
    expect(((await rejection(service.run(taskId, resume))) as DependencyError).code).toBe(
      "session_error",
    );
  });

  test("when the job cannot start, a queued message is cleared and the failure is a job_error", async () => {
    const resumed = setupRun();
    resumed.runJob.mockRejectedValue(new Error("cloud run down"));
    expect(((await rejection(resumed.service.run(taskId, resume))) as DependencyError).code).toBe(
      "job_error",
    );
    expect(resumed.clearMessage).toHaveBeenCalledWith(taskId, "s1");

    const fresh = setupRun();
    fresh.runJob.mockRejectedValue(new Error("cloud run down"));
    await rejection(fresh.service.run(taskId));
    expect(fresh.clearMessage).not.toHaveBeenCalled();
  });

  test("a failing clear of the queued message is only logged", async () => {
    const { service, runJob, clearMessage } = setupRun();
    runJob.mockRejectedValue(new Error("cloud run down"));
    clearMessage.mockRejectedValue(new Error("firestore down"));
    const spy = spyOn(console, "error").mockImplementation(() => {});
    expect(((await rejection(service.run(taskId, resume))) as DependencyError).code).toBe(
      "job_error",
    );
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
