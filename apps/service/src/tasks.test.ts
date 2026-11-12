import { describe, expect, mock, test } from "bun:test";

import { Firestore } from "@google-cloud/firestore";

import { createCreateTask, createDeleteTask, createGetTask, createListTasks } from "./tasks";

const writer = (write = async (_data: unknown) => {}) => {
  const create = mock(write);
  const doc = mock((_id: string) => ({ create }));
  const collection = mock((_name: string) => ({ doc }));
  return {
    db: { collection } as unknown as Pick<Firestore, "collection">,
    collection,
    doc,
    create,
  };
};

test("creates UUID-keyed contracts in runs and preserves the supplied prompt", async () => {
  const { db, collection, doc, create } = writer();
  const save = createCreateTask(db);
  const contract = await save({ prompt: "  hello  ", jobName: "my-job" });
  expect(contract.taskId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(contract.prompt).toBe("  hello  ");
  expect(contract.jobName).toBe("my-job");
  expect(Object.keys(contract).toSorted()).toEqual(["jobName", "prompt", "taskId"]);
  expect(collection).toHaveBeenCalledWith("tasks");
  expect(doc).toHaveBeenCalledWith(contract.taskId);
  expect(create).toHaveBeenCalledWith(contract);
  expect((await save({ prompt: "second", jobName: "my-job" })).taskId).not.toBe(contract.taskId);
});

test("waits for persistence before returning the contract", async () => {
  const deferred = Promise.withResolvers<void>();
  const { db, create } = writer(() => deferred.promise);
  let settled = false;
  const saved = createCreateTask(db)({
    prompt: "hello",
    jobName: "my-job",
  }).then((result) => {
    settled = true;
    return result;
  });
  await Promise.resolve();
  expect(create).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false);
  deferred.resolve();
  expect((await saved).prompt).toBe("hello");
});

test("propagates a failed create without retrying", async () => {
  const { db, create } = writer(async () => {
    throw new Error("write failed");
  });
  await expect(createCreateTask(db)({ prompt: "hello", jobName: "my-job" })).rejects.toThrow(
    "write failed",
  );
  expect(create).toHaveBeenCalledTimes(1);
});

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)("task contracts in Firestore", () => {
  test("persists a contract across clients", async () => {
    const db = new Firestore();
    const reader = new Firestore();
    let taskId: string | undefined;
    try {
      const contract = await createCreateTask(db)({
        prompt: "emulator prompt",
        jobName: "my-job",
      });
      taskId = contract.taskId;
      expect((await reader.collection("tasks").doc(taskId).get()).data()).toEqual(contract);
      expect(await createGetTask(reader)(taskId)).toEqual(contract);
      expect(await createListTasks(reader)()).toContainEqual(contract);
      await db.collection("tasks").doc(taskId).delete();
      expect(await createGetTask(reader)(taskId)).toBeUndefined();
    } finally {
      if (taskId) await db.collection("tasks").doc(taskId).delete();
      await Promise.all([db.terminate(), reader.terminate()]);
    }
  });
});

const snapshot = (id: string, prompt: string, jobName?: string) => ({
  id,
  exists: true,
  get: (field: string) => ({ prompt, jobName, taskId: "ignored", extra: true })[field],
});
const readerWith = (get: () => Promise<unknown>, list: () => Promise<unknown>) => {
  const doc = mock((_id: string) => ({ get }));
  const collection = mock((_name: string) => ({ doc, get: list }));
  return {
    db: { collection } as unknown as Pick<Firestore, "collection">,
    collection,
    doc,
  };
};

test("lists only contract fields using document IDs", async () => {
  const { db, collection } = readerWith(
    async () => undefined,
    async () => ({
      docs: [snapshot("a", "one", "my-job"), snapshot("b", "two")],
    }),
  );
  expect(await createListTasks(db)()).toEqual([
    { taskId: "a", prompt: "one", jobName: "my-job" },
    { taskId: "b", prompt: "two" },
  ]);
  expect(collection).toHaveBeenCalledWith("tasks");
});

test("lists an empty collection", async () => {
  const { db } = readerWith(
    async () => undefined,
    async () => ({ docs: [] }),
  );
  expect(await createListTasks(db)()).toEqual([]);
});

test("propagates list failures", async () => {
  const { db } = readerWith(
    async () => undefined,
    async () => {
      throw new Error("read failed");
    },
  );
  await expect(createListTasks(db)()).rejects.toThrow("read failed");
});

test("stores agentName only when supplied and lists it", async () => {
  const { db, create } = writer();
  const named = await createCreateTask(db)({
    prompt: "p",
    jobName: "my-job",
    agentName: "researcher",
  });
  expect(named.agentName).toBe("researcher");
  expect(create).toHaveBeenCalledWith(named);
  const plain = await createCreateTask(db)({ prompt: "p", jobName: "my-job" });
  expect(Object.keys(plain)).not.toContain("agentName");

  const reader = readerWith(
    async () => undefined,
    async () => ({
      docs: [
        {
          id: "a",
          exists: true,
          get: (f: string) =>
            ({ prompt: "p", jobName: "my-job", agentName: "researcher" })[f as "prompt"],
        },
      ],
    }),
  );
  expect(await createListTasks(reader.db)()).toEqual([
    { taskId: "a", prompt: "p", jobName: "my-job", agentName: "researcher" },
  ]);
});

test("deletes the task document by ID", async () => {
  const del = mock(async () => {});
  const doc = mock((_id: string) => ({ delete: del }));
  const collection = mock((_name: string) => ({ doc }));
  await createDeleteTask({ collection } as never)("task-1");
  expect(collection).toHaveBeenCalledWith("tasks");
  expect(doc).toHaveBeenCalledWith("task-1");
  expect(del).toHaveBeenCalledTimes(1);
});
