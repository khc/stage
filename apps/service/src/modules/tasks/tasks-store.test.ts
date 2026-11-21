import { describe, expect, mock, test } from "bun:test";

import type { Firestore } from "@google-cloud/firestore";

import { createTasksStore } from "./tasks-store";

type Doc = { exists: boolean; id: string; data: () => Record<string, unknown> };
const fakeDb = (stored: Record<string, Record<string, unknown>> = {}) => {
  const create = mock(async (_data: unknown) => {});
  const remove = mock(async () => {});
  const doc = mock((id: string) => ({
    create,
    delete: remove,
    get: async (): Promise<Doc> => ({ exists: id in stored, id, data: () => stored[id] ?? {} }),
  }));
  const collection = mock((_name: string) => ({
    doc,
    where: (field: string, _op: string, value: unknown) => ({
      get: async () => ({
        docs: Object.entries(stored)
          .filter(([, data]) => data[field] === value)
          .map(([id, data]) => ({
            exists: true,
            id,
            data: () => data,
            get: (field: string) => data[field],
          })),
      }),
    }),
    get: async () => ({
      docs: Object.entries(stored).map(([id, data]): Doc => ({
        exists: true,
        id,
        data: () => data,
      })),
    }),
  }));
  return {
    firestore: { collection } as unknown as Pick<Firestore, "collection">,
    collection,
    doc,
    create,
    remove,
  };
};

describe("task store", () => {
  test("creates a UUID-keyed contract and keeps the name and prompt as given", async () => {
    const { firestore, collection, doc, create } = fakeDb();
    const contract = await createTasksStore(firestore).create({
      name: "  Greeting  ",
      prompt: "  hi  ",
      jobName: "my-job",
    });
    expect(contract.taskId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(contract.name).toBe("  Greeting  ");
    expect(contract.prompt).toBe("  hi  ");
    expect(Object.keys(contract).toSorted()).toEqual([
      "documents",
      "jobName",
      "name",
      "prompt",
      "taskId",
    ]);
    expect(collection).toHaveBeenCalledWith("tasks");
    expect(doc).toHaveBeenCalledWith(contract.taskId);
    expect(create).toHaveBeenCalledWith(contract);
  });

  test("includes agentName only when given", async () => {
    const { firestore } = fakeDb();
    const contract = await createTasksStore(firestore).create({
      name: "Haiku task",
      prompt: "p",
      jobName: "j",
      agentName: "haiku",
    });
    expect(contract.agentName).toBe("haiku");
  });

  test("includes the default model only when given", async () => {
    const { firestore, create } = fakeDb();
    const defaultModel = {
      providerId: "5f4c3d1e-9b0a-4d2e-8a37-1c6f2b9e7a10",
      model: "gemini-2.5-flash",
    };
    const contract = await createTasksStore(firestore).create({
      name: "t",
      prompt: "p",
      jobName: "j",
      defaultModel,
    });
    expect(contract.defaultModel).toEqual(defaultModel);
    expect(create).toHaveBeenCalledWith(contract);
    const plain = await createTasksStore(firestore).create({
      name: "t",
      prompt: "p",
      jobName: "j",
    });
    expect(Object.hasOwn(plain, "defaultModel")).toBe(false);
  });

  test("stores the parent task and session of a delegated task", async () => {
    const { firestore, create } = fakeDb();
    const contract = await createTasksStore(firestore).create({
      name: "a2a: hi",
      prompt: "hi",
      jobName: "j",
      parentTaskId: "5f4c3d1e-9b0a-4d2e-8a37-1c6f2b9e7a10",
      parentSessionId: "s-1",
    });
    expect(contract).toMatchObject({
      parentTaskId: "5f4c3d1e-9b0a-4d2e-8a37-1c6f2b9e7a10",
      parentSessionId: "s-1",
    });
    expect(create).toHaveBeenCalledWith(contract);
  });

  test("writes no parent unless both the task and the session are given", async () => {
    const { firestore } = fakeDb();
    const contract = await createTasksStore(firestore).create({
      name: "t",
      prompt: "p",
      jobName: "j",
      parentTaskId: "5f4c3d1e-9b0a-4d2e-8a37-1c6f2b9e7a10",
    });
    expect(Object.hasOwn(contract, "parentTaskId")).toBe(false);
    expect(Object.hasOwn(contract, "parentSessionId")).toBe(false);
  });

  test("lists the children of a task by its parentTaskId", async () => {
    const { firestore, collection } = fakeDb({
      child1: { prompt: "a", parentTaskId: "parent", parentSessionId: "s-1" },
      child2: { prompt: "b", parentTaskId: "parent", parentSessionId: "s-2" },
      other: { prompt: "c", parentTaskId: "elsewhere", parentSessionId: "s-3" },
      loner: { prompt: "d" },
    });
    const children = await createTasksStore(firestore).listChildren("parent");
    expect(children.map((task) => task.taskId)).toEqual(["child1", "child2"]);
    expect(children[0]).toMatchObject({ parentTaskId: "parent", parentSessionId: "s-1" });
    expect(collection).toHaveBeenCalledWith("tasks");
  });

  test("propagates a failed create", async () => {
    const { firestore, create } = fakeDb();
    create.mockRejectedValueOnce(new Error("write failed"));
    await expect(
      createTasksStore(firestore).create({ name: "Task", prompt: "p", jobName: "j" }),
    ).rejects.toThrow("write failed");
  });

  test("delete returns false when there is no such task and true after deleting one", async () => {
    const { firestore, remove } = fakeDb({ t1: { prompt: "p", jobName: "j" } });
    const store = createTasksStore(firestore);
    expect(await store.delete("nope")).toBe(false);
    expect(remove).not.toHaveBeenCalled();
    expect(await store.delete("t1")).toBe(true);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test("get returns undefined for a missing task", async () => {
    expect(await createTasksStore(fakeDb().firestore).get("nope")).toBeUndefined();
  });
});
