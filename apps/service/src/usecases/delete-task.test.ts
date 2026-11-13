import { expect, mock, spyOn, test } from "bun:test";

import { DependencyError } from "../errors";
import type { DocumentStore } from "../stores/document-store";
import type { SessionStore } from "../stores/session-store";
import { deleteTaskWithSessions } from "./delete-task";

const taskId = "9eb6f136-55d6-4cfb-8b1e-71367d7fd6a8";

const setup = (found = true) => {
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
  const { deps, order, release } = setup();
  expect(await deleteTaskWithSessions(deps, taskId)).toBe("deleted");
  expect(order).toEqual(["session s1", "session s2", "task", "documents"]);
  expect(release).toHaveBeenCalledWith(["d1"]);
});

test("a missing task deletes nothing", async () => {
  const { deps, deleteTask, sessionsDelete } = setup(false);
  expect(await deleteTaskWithSessions(deps, taskId)).toBe("not_found");
  expect(deleteTask).not.toHaveBeenCalled();
  expect(sessionsDelete).not.toHaveBeenCalled();
});

test("a failing session delete leaves the task in place and is a task_error", async () => {
  const { deps, deleteTask, sessionsDelete } = setup();
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
  const { deps, release } = setup();
  release.mockRejectedValue(new Error("firestore down"));
  const spy = spyOn(console, "error").mockImplementation(() => {});
  expect(await deleteTaskWithSessions(deps, taskId)).toBe("deleted");
  expect(spy).toHaveBeenCalled();
  spy.mockRestore();
});
