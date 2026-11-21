import { describe, expect, mock, spyOn, test } from "bun:test";

import { MessageQueuedError, RunInProgressError } from "@stage/agents/session-service";

import { DependencyError } from "../../errors";
import { QuickTimeoutError, RunFailedError } from "../../platform/agent-services-client";
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
      agentServices?: { has: (job: string) => boolean; run: (...args: never[]) => Promise<void> };
      maxQuickInFlight?: number;
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
    const failRun = mock(async (_t: string, _s: string, _m: string) => {});
    const service = createTasksService(
      {
        tasksStore: { get: getTask },
        agentRegistry: { list: async () => [] },
        cloudRunJobs: { run: runJob },
        sessionsStore: { create, delete: del, get, queueMessage, clearMessage, failRun },
        allowedJobs: overrides.allowedJobs,
        agentServices: overrides.agentServices,
      } as unknown as TasksServiceDeps,
      overrides.maxQuickInFlight !== undefined
        ? { maxQuickInFlight: overrides.maxQuickInFlight }
        : undefined,
    );
    return {
      service,
      getTask,
      runJob,
      create,
      del,
      queueMessage,
      clearMessage,
      failRun,
      getSession: get,
    };
  };
  const quickServices = (run: (...args: unknown[]) => Promise<void> = async () => {}) => {
    const runService = mock(run);
    return {
      runService,
      agentServices: { has: (job: string) => job === "my-job", run: runService },
    };
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
    expect(queueMessage).toHaveBeenCalledWith(taskId, "s1", "answer", undefined);
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
    expect(queueMessage).toHaveBeenCalledWith(taskId, "s-new", "  hello \n world  ", undefined);
    expect(runJob).toHaveBeenCalledWith("my-job", taskId, "s-new");

    const failing = setupRun();
    failing.runJob.mockRejectedValue(new Error("cloud run down"));
    expect(
      ((await rejection(failing.service.run(taskId, { message: "hello" }))) as DependencyError)
        .code,
    ).toBe("job_error");
    expect(failing.del).toHaveBeenCalledWith(taskId, "s-new");
  });

  describe("in quick mode", () => {
    const setup = (run?: (...args: unknown[]) => Promise<void>) => {
      const { runService, agentServices } = quickServices(run);
      return { ...setupRun({ agentServices }), runService };
    };

    test("is unavailable without a service for the job, before any session is created", async () => {
      const none = setupRun({});
      expect(await none.service.run(taskId, { message: "hi" }, "quick")).toEqual({
        status: "quick_unavailable",
      });
      const other = setupRun({ agentServices: { has: () => false, run: async () => {} } });
      expect(await other.service.run(taskId, { message: "hi" }, "quick")).toEqual({
        status: "quick_unavailable",
      });
      for (const { create, runJob } of [none, other]) {
        expect(create).not.toHaveBeenCalled();
        expect(runJob).not.toHaveBeenCalled();
      }
    });

    test("runs a new session on the service instead of the job", async () => {
      const { service, runService, runJob, queueMessage } = setup();
      expect(await service.run(taskId, { message: "hi" }, "quick")).toEqual({
        status: "started",
        operation: "service",
        sessionId: "s-new",
      });
      expect(queueMessage).toHaveBeenCalledWith(taskId, "s-new", "hi", undefined);
      expect(runService).toHaveBeenCalledWith("my-job", taskId, "s-new");
      expect(runJob).not.toHaveBeenCalled();
    });

    test("resumes a session on the service", async () => {
      const { service, runService, runJob } = setup();
      expect(await service.run(taskId, resume, "quick")).toEqual({
        status: "started",
        operation: "service",
      });
      expect(runService).toHaveBeenCalledWith("my-job", taskId, "s1");
      expect(runJob).not.toHaveBeenCalled();
    });

    test("workflow and the default keep running the job", async () => {
      for (const mode of [undefined, "workflow" as const]) {
        const { service, runService, runJob } = setup();
        expect(await service.run(taskId, resume, mode)).toEqual({
          status: "started",
          operation: "op-1",
        });
        expect(runJob).toHaveBeenCalledWith("my-job", taskId, "s1");
        expect(runService).not.toHaveBeenCalled();
      }
    });

    test("a timeout is quick_timeout and keeps the session and the message: the run has started", async () => {
      const fresh = setup(async () => Promise.reject(new QuickTimeoutError()));
      expect(await fresh.service.run(taskId, { message: "hi" }, "quick")).toEqual({
        status: "quick_timeout",
        sessionId: "s-new",
      });
      expect(fresh.del).not.toHaveBeenCalled();

      const resumed = setup(async () => Promise.reject(new QuickTimeoutError()));
      expect(await resumed.service.run(taskId, resume, "quick")).toEqual({
        status: "quick_timeout",
        sessionId: "s1",
      });
      expect(resumed.clearMessage).not.toHaveBeenCalled();
    });

    test("forwards caller signal and enforces maxQuickInFlight cap", async () => {
      let entered!: () => void;
      const reachedService = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const blocker = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { agentServices, runService } = quickServices(async () => {
        entered();
        await blocker;
      });
      const { service } = setupRun({ agentServices, maxQuickInFlight: 1 });
      const controller = new AbortController();

      const inFlight = service.run(taskId, { message: "one" }, "quick", {
        signal: controller.signal,
      });
      await reachedService;
      expect(await service.run(taskId, { message: "two" }, "quick")).toEqual({
        status: "too_many_quick_runs",
      });
      expect(runService).toHaveBeenCalledWith("my-job", taskId, "s-new", controller.signal);

      release();
      expect(await inFlight).toEqual({
        status: "started",
        operation: "service",
        sessionId: "s-new",
      });
      expect(await service.run(taskId, { message: "three" }, "quick")).toMatchObject({
        status: "started",
      });
    });

    describe("in the background", () => {
      const background = { background: true };

      test("returns at once with the session while the service run goes on", async () => {
        let release!: () => void;
        const blocker = new Promise<void>((resolve) => {
          release = resolve;
        });
        const { service, runService, runJob } = setup(() => blocker);
        expect(await service.run(taskId, { message: "hi" }, "quick", background)).toEqual({
          status: "started",
          operation: "service",
          sessionId: "s-new",
        });
        expect(runService).toHaveBeenCalledWith("my-job", taskId, "s-new");
        expect(runJob).not.toHaveBeenCalled();
        release();
      });

      test("keeps its place among the quick runs until the run ends", async () => {
        let release!: () => void;
        const blocker = new Promise<void>((resolve) => {
          release = resolve;
        });
        const { agentServices } = quickServices(() => blocker);
        const { service } = setupRun({ agentServices, maxQuickInFlight: 1 });
        await service.run(taskId, { message: "one" }, "quick", background);
        expect(await service.run(taskId, { message: "two" }, "quick", background)).toEqual({
          status: "too_many_quick_runs",
        });
        release();
        await blocker;
        await Bun.sleep(0);
        expect(await service.run(taskId, { message: "three" }, "quick", background)).toMatchObject({
          status: "started",
        });
      });

      test("a run that never reached the agent fails its session so the stream shows why", async () => {
        const error = spyOn(console, "error").mockImplementation(() => {});
        const fresh = setup(async () => Promise.reject(new Error("service down")));
        expect(await fresh.service.run(taskId, { message: "hi" }, "quick", background)).toMatchObject(
          { status: "started", sessionId: "s-new" },
        );
        await Bun.sleep(0);
        expect(fresh.failRun).toHaveBeenCalledWith(taskId, "s-new", expect.stringContaining("service down"));
        expect(fresh.del).not.toHaveBeenCalled();

        const resumed = setup(async () => Promise.reject(new Error("service down")));
        await resumed.service.run(taskId, resume, "quick", background);
        await Bun.sleep(0);
        expect(resumed.failRun).toHaveBeenCalledWith(taskId, "s1", expect.stringContaining("service down"));
        expect(resumed.clearMessage).not.toHaveBeenCalled();
        error.mockRestore();
      });

      test("a lease conflict leaves the other run's session alone and clears the message", async () => {
        const error = spyOn(console, "error").mockImplementation(() => {});
        const resumed = setup(async () => Promise.reject(new RunInProgressError()));
        await resumed.service.run(taskId, resume, "quick", background);
        await Bun.sleep(0);
        expect(resumed.failRun).not.toHaveBeenCalled();
        expect(resumed.clearMessage).toHaveBeenCalledWith(taskId, "s1");
        error.mockRestore();
      });

      test("a failed run keeps its session and a timeout keeps the session and the message", async () => {
        const failed = setupRun({
          agentServices: quickServices(async () => Promise.reject(new RunFailedError()))
            .agentServices,
          session: { id: "s-new", run: { status: "failed" } },
        });
        await failed.service.run(taskId, { message: "hi" }, "quick", background);
        const timedOut = setup(async () => Promise.reject(new QuickTimeoutError()));
        await timedOut.service.run(taskId, { message: "hi" }, "quick", background);
        await Bun.sleep(0);
        for (const { del, clearMessage, failRun } of [failed, timedOut]) {
          expect(del).not.toHaveBeenCalled();
          expect(clearMessage).not.toHaveBeenCalled();
          expect(failRun).not.toHaveBeenCalled();
        }
      });
    });

    test("a run that started and failed is a started run: its failed session stays to be read", async () => {
      const fail = async () => Promise.reject(new RunFailedError());
      const fresh = setupRun({
        agentServices: quickServices(fail).agentServices,
        session: { id: "s-new", run: { status: "failed" } },
      });
      expect(await fresh.service.run(taskId, { message: "hi" }, "quick")).toEqual({
        status: "started",
        operation: "service",
        sessionId: "s-new",
      });
      expect(fresh.del).not.toHaveBeenCalled();

      const resumed = setupRun({
        agentServices: quickServices(fail).agentServices,
        session: { id: "s1", run: { status: "failed" } },
      });
      expect(await resumed.service.run(taskId, resume, "quick")).toEqual({
        status: "started",
        operation: "service",
      });
      expect(resumed.clearMessage).not.toHaveBeenCalled();
    });

    test("a run that failed before it started leaves no failure to read, so it is a service_error and cleaned up", async () => {
      const fail = async () => Promise.reject(new RunFailedError());
      const fresh = setupRun({
        agentServices: quickServices(fail).agentServices,
        session: { id: "s-new" },
      });
      const err = await rejection(fresh.service.run(taskId, { message: "hi" }, "quick"));
      expect(err).toBeInstanceOf(DependencyError);
      expect((err as DependencyError).code).toBe("service_error");
      expect(fresh.del).toHaveBeenCalledWith(taskId, "s-new");

      const resumed = setupRun({
        agentServices: quickServices(fail).agentServices,
        session: { id: "s1" },
      });
      await rejection(resumed.service.run(taskId, resume, "quick"));
      expect(resumed.clearMessage).toHaveBeenCalledWith(taskId, "s1");

      const unreadable = setupRun({ agentServices: quickServices(fail).agentServices });
      unreadable.getSession
        .mockResolvedValueOnce({ id: "s1" })
        .mockRejectedValue(new Error("firestore down"));
      expect(
        ((await rejection(unreadable.service.run(taskId, resume, "quick"))) as DependencyError)
          .code,
      ).toBe("service_error");
    });

    test("a lease conflict is run_in_progress and is cleaned up like a job that did not start", async () => {
      const fresh = setup(async () => Promise.reject(new RunInProgressError()));
      expect(await fresh.service.run(taskId, { message: "hi" }, "quick")).toEqual({
        status: "run_in_progress",
      });
      expect(fresh.del).toHaveBeenCalledWith(taskId, "s-new");

      const resumed = setup(async () => Promise.reject(new RunInProgressError()));
      expect(await resumed.service.run(taskId, resume, "quick")).toEqual({
        status: "run_in_progress",
      });
      expect(resumed.clearMessage).toHaveBeenCalledWith(taskId, "s1");
    });

    test("any other failure is a service_error dependency failure and is cleaned up", async () => {
      const fresh = setup(async () => Promise.reject(new Error("service down")));
      const err = await rejection(fresh.service.run(taskId, { message: "hi" }, "quick"));
      expect(err).toBeInstanceOf(DependencyError);
      expect((err as DependencyError).code).toBe("service_error");
      expect(fresh.del).toHaveBeenCalledWith(taskId, "s-new");

      const resumed = setup(async () => Promise.reject(new Error("service down")));
      await rejection(resumed.service.run(taskId, resume, "quick"));
      expect(resumed.clearMessage).toHaveBeenCalledWith(taskId, "s1");
    });
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

describe("tasks service default model", () => {
  const providerId = "6f4c3d1e-9b0a-4d2e-8a37-1c6f2b9e7a11";
  const usable = {
    providerId,
    name: "Express",
    kind: "google-express",
    enabled: true,
    models: ["gemini-2.5-flash", "gemini-2.5-pro"],
    disabledModels: ["gemini-2.5-pro"],
  };
  // null stands for a missing provider
  const setupCreate = (provider: unknown = usable) => {
    const create = mock(async (input: unknown) => ({ taskId, ...(input as object) }));
    const get = mock(async (_id: string) => provider);
    const service = createTasksService({
      tasksStore: { create },
      agentRegistry: { list: async () => [] },
      providersStore: { get },
    } as unknown as TasksServiceDeps);
    return { service, create, get };
  };
  const input = (model: string) => ({
    name: "n",
    prompt: "p",
    jobName: "my-job",
    defaultModel: { providerId, model },
  });

  test("stores a usable default model including openai", async () => {
    const { service, create, get } = setupCreate();
    const result = await service.create(input("gemini-2.5-flash"));
    expect(result.status).toBe("created");
    expect(get).toHaveBeenCalledWith(providerId);
    expect(create).toHaveBeenCalledWith(input("gemini-2.5-flash"));

    const openaiSetup = setupCreate({ ...usable, kind: "openai" });
    expect((await openaiSetup.service.create(input("gemini-2.5-flash"))).status).toBe("created");
  });

  test("refuses a default model that is not selectable, and creates nothing", async () => {
    for (const provider of [null, { ...usable, enabled: false }, { ...usable, kind: "other" }]) {
      const { service, create } = setupCreate(provider);
      expect(await service.create(input("gemini-2.5-flash"))).toEqual({ status: "unknown_model" });
      expect(create).not.toHaveBeenCalled();
    }
    const { service, create } = setupCreate();
    expect(await service.create(input("gemini-2.5-pro"))).toEqual({ status: "unknown_model" });
    expect(await service.create(input("gemini-9"))).toEqual({ status: "unknown_model" });
    expect(create).not.toHaveBeenCalled();
  });

  test("a task without a default model never looks up a provider", async () => {
    const { service, get } = setupCreate();
    expect((await service.create({ name: "n", prompt: "p", jobName: "my-job" })).status).toBe(
      "created",
    );
    expect(get).not.toHaveBeenCalled();
  });
});

describe("tasks service run with a model", () => {
  const providerId = "6f4c3d1e-9b0a-4d2e-8a37-1c6f2b9e7a11";
  const provider = {
    providerId,
    kind: "google",
    enabled: true,
    models: ["gemini-2.5-flash", "gemini-2.5-pro"],
    disabledModels: ["gemini-2.5-pro"],
  };
  const model = { providerId, model: "gemini-2.5-flash" };
  const setup = (found: unknown = provider) => {
    const queueMessage = mock(async (..._args: unknown[]) => true);
    const runJob = mock(async (..._args: unknown[]) => "op-1");
    const service = createTasksService({
      tasksStore: { get: async () => ({ taskId, prompt: "p", jobName: "my-job" }) },
      agentRegistry: { list: async () => [] },
      providersStore: { get: async () => found },
      cloudRunJobs: { run: runJob },
      sessionsStore: {
        create: async () => "s-new",
        get: async () => ({ id: "s1" }),
        queueMessage,
        delete: async () => true,
        clearMessage: async () => {},
      },
    } as unknown as TasksServiceDeps);
    return { service, queueMessage, runJob };
  };

  test("queues the message with its model when resuming a session (including openai)", async () => {
    const { service, queueMessage } = setup();
    const result = await service.run(taskId, { sessionId: "s1", message: "hi", model });
    expect(result.status).toBe("started");
    expect(queueMessage).toHaveBeenCalledWith(taskId, "s1", "hi", model);

    const openaiSetup = setup({ ...provider, kind: "openai" });
    expect(
      (await openaiSetup.service.run(taskId, { sessionId: "s1", message: "hi", model })).status,
    ).toBe("started");
  });

  test("queues the first message of a new session with its model", async () => {
    const { service, queueMessage } = setup();
    await service.run(taskId, { message: "hi", model });
    expect(queueMessage).toHaveBeenCalledWith(taskId, "s-new", "hi", model);
  });

  test("a model that cannot be selected is refused before anything is queued or started", async () => {
    for (const found of [null, { ...provider, enabled: false }, { ...provider, kind: "other" }]) {
      const { service, queueMessage, runJob } = setup(found);
      expect(await service.run(taskId, { sessionId: "s1", message: "hi", model })).toEqual({
        status: "unknown_model",
      });
      expect(queueMessage).not.toHaveBeenCalled();
      expect(runJob).not.toHaveBeenCalled();
    }
    const { service, queueMessage } = setup();
    const off = { providerId, model: "gemini-2.5-pro" };
    expect(await service.run(taskId, { message: "hi", model: off })).toEqual({
      status: "unknown_model",
    });
    expect(queueMessage).not.toHaveBeenCalled();
  });

  test("a message without a model queues as before", async () => {
    const { service, queueMessage } = setup();
    await service.run(taskId, { sessionId: "s1", message: "hi" });
    expect(queueMessage).toHaveBeenCalledWith(taskId, "s1", "hi", undefined);
  });
});
