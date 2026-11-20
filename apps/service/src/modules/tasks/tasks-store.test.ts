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
