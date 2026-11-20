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
      listChildren: async () => [],
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
      tasksStore: {
        get: async () => ({ taskId, prompt: "p" }),
        listChildren: async () => [],
        delete: async () => true,
      },
      agentRegistry: { list: async () => [] },
      sessionsStore: { list: async () => [], delete: async () => true },
    } as unknown as TasksServiceDeps);
    expect(await withoutDocuments.delete(taskId)).toBe("deleted");
    expect(service).toBeDefined();
  });
});

describe("tasks service create", () => {
  const input = { name: "Haiku task", prompt: "p", jobName: "my-job", agentName: "haiku" };
  const createWith = (registered: string[], allowedJobs?: ReadonlySet<string>) => {
    const create = mock(async (i: typeof input) => ({
      ...i,
      taskId,
      documents: [],
    }));
    const service = createTasksService({
      tasksStore: { create },
      agentRegistry: { list: async () => registered.map((name) => ({ name })) },
      allowedJobs,
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

  test("refuses a job outside the allowed jobs", async () => {
    const { service, create } = createWith([], new Set(["other-job"]));
    expect(await service.create(input)).toEqual({ status: "unknown_job" });
    expect(create).not.toHaveBeenCalled();
    expect((await createWith([], new Set(["my-job"])).service.create(input)).status).toBe(
      "created",
    );
  });

  test("a job without a registration accepts any valid agent name", async () => {
    expect((await createWith([]).service.create(input)).status).toBe("created");
  });
});

describe("tasks service run", () => {
  const task = { taskId, prompt: "p", jobName: "my-job" };
  const setupRun = (
    overrides: {
      task?: unknown;
      session?: unknown;
      queue?: () => Promise<boolean>;
      allowedJobs?: ReadonlySet<string>;
    } = {},
  ) => {
    const runJob = mock(async (..._args: unknown[]) => "op-1");
    const getTask = mock(async (_id: string) => ("task" in overrides ? overrides.task : task));
    const create = mock(async (_t: string, _name?: string) => "s-new");
    const del = mock(async (_t: string, _s: string) => true);
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
      sessionsStore: { create, delete: del, get, queueMessage, clearMessage },
      allowedJobs: overrides.allowedJobs,
    } as unknown as TasksServiceDeps);
    return { service, getTask, runJob, create, del, queueMessage, clearMessage };
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

  test("a task whose job is not an allowed one is not executable", async () => {
    const { service, runJob } = setupRun({
      allowedJobs: new Set(["other-job"]),
    });
    expect(await service.run(taskId)).toEqual({
      status: "task_not_executable",
    });
    expect(runJob).not.toHaveBeenCalled();
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

  test("starts a new session with a user message and removes it if the job fails to start", async () => {
    const { service, create, queueMessage, runJob } = setupRun();
    expect(await service.run(taskId, { message: "  hello \n world  " })).toEqual({
      status: "started",
      operation: "op-1",
      sessionId: "s-new",
    });
    expect(create).toHaveBeenCalledWith(taskId, "hello world");
    expect(queueMessage).toHaveBeenCalledWith(taskId, "s-new", "  hello \n world  ");
    expect(runJob).toHaveBeenCalledWith("my-job", taskId, "s-new");

    const failing = setupRun();
    failing.runJob.mockRejectedValue(new Error("cloud run down"));
    expect(
      ((await rejection(failing.service.run(taskId, { message: "hello" }))) as DependencyError)
        .code,
    ).toBe("job_error");
    expect(failing.del).toHaveBeenCalledWith(taskId, "s-new");
  });
});

// A tree of tasks: parent -> child -> grandchild, each with a session and a document of its own.
const setupTree = (children: Record<string, string[]>) => {
  const order: string[] = [];
  const known = new Set(Object.keys(children));
  const sessionsDelete = mock(async (id: string, _session: string) => {
    order.push(`session of ${id}`);
    return true;
  });
  const deleteTask = mock(async (id: string) => {
    order.push(`task ${id}`);
    return true;
  });
  const release = mock(async (ids: string[]) => {
    order.push(`documents ${ids.join(",")}`);
  });
  const service = createTasksService({
    tasksStore: {
      get: async (id: string) =>
        known.has(id)
          ? { taskId: id, prompt: "p", documents: [{ documentId: `d-${id}` }] }
          : undefined,
      listChildren: async (id: string) =>
        (children[id] ?? []).map((child) => ({
          taskId: child,
          prompt: "p",
          documents: [{ documentId: `d-${child}` }],
        })),
      delete: deleteTask,
    },
    agentRegistry: { list: async () => [] },
    cloudRunJobs: { run: async () => "op" },
    sessionsStore: {
      list: async (id: string) => [{ id: `s-${id}` }],
      delete: (id: string, session: string) => sessionsDelete(id, session),
    },
    documentsStore: { release },
  } as unknown as TasksServiceDeps);
  return { service, order, deleteTask, sessionsDelete };
};

describe("tasks service delete with sub-tasks", () => {
  test("deletes the sub-tasks and theirs first, each with its sessions, then the task", async () => {
    const { service, order } = setupTree({
      parent: ["child"],
      child: ["grandchild"],
      grandchild: [],
    });
    expect(await service.delete("parent")).toBe("deleted");
    expect(order).toEqual([
      "session of grandchild",
      "task grandchild",
      "documents d-grandchild",
      "session of child",
      "task child",
      "documents d-child",
      "session of parent",
      "task parent",
      "documents d-parent",
    ]);
  });

  test("a failure while deleting a sub-task leaves the task and the shallower tasks in place", async () => {
    const { service, sessionsDelete, deleteTask } = setupTree({ parent: ["child"], child: [] });
    sessionsDelete.mockRejectedValue(new Error("firestore down"));
    const err = await service.delete("parent").then(
      () => undefined,
      (e) => e,
    );
    expect(err).toBeInstanceOf(DependencyError);
    expect(deleteTask).not.toHaveBeenCalled();
  });

  test("a parent reference that loops back does not loop the delete", async () => {
    const { service, deleteTask } = setupTree({ parent: ["child"], child: ["parent"] });
    expect(await service.delete("parent")).toBe("deleted");
    expect(deleteTask.mock.calls.map(([id]) => id)).toEqual(["child", "parent"]);
  });
});

describe("tasks service delete cap", () => {
  test("refuses to delete a task with more than 500 sub-tasks, and deletes nothing", async () => {
    const children: Record<string, string[]> = {
      parent: Array.from({ length: 501 }, (_, i) => `child-${i}`),
    };
    const { service, deleteTask, sessionsDelete } = setupTree(children);
    expect(await service.delete("parent")).toBe("too_many_subtasks");
    expect(deleteTask).not.toHaveBeenCalled();
    expect(sessionsDelete).not.toHaveBeenCalled();
  });

  test("deletes a task with exactly 500 sub-tasks", async () => {
    const { service, deleteTask } = setupTree({
      parent: Array.from({ length: 500 }, (_, i) => `child-${i}`),
    });
    expect(await service.delete("parent")).toBe("deleted");
    expect(deleteTask).toHaveBeenCalledTimes(501);
  });
});
