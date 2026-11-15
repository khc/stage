import { describe, expect, mock, spyOn, test } from "bun:test";

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
