import type { Firestore } from "@google-cloud/firestore";
import { expect, mock, test } from "bun:test";
import { createGetTask } from "./task-contract";

const reader = (get: () => Promise<unknown>) => {
  const doc = mock((_id: string) => ({ get }));
  const collection = mock((_name: string) => ({ doc }));
  return {
    db: { collection } as unknown as Pick<Firestore, "collection">,
    collection,
    doc,
  };
};

test("gets contract fields from the document ID and excludes extra stored fields", async () => {
  const data: Record<string, unknown> = {
    prompt: "hello",
    jobName: "my-job",
    taskId: "ignored",
    extra: true,
  };
  const { db, collection, doc } = reader(async () => ({
    id: "a",
    exists: true,
    get: (key: string) => data[key],
  }));
  expect(await createGetTask(db)("a")).toEqual({
    taskId: "a",
    prompt: "hello",
    jobName: "my-job",
  });
  expect(collection).toHaveBeenCalledWith("tasks");
  expect(doc).toHaveBeenCalledWith("a");
});

test("reads legacy prompt-only contracts without adding undefined fields", async () => {
  const { db } = reader(async () => ({
    id: "a",
    exists: true,
    get: (key: string) => (key === "prompt" ? "hello" : undefined),
  }));
  const contract = await createGetTask(db)("a");
  expect(contract).toEqual({ taskId: "a", prompt: "hello" });
  expect(Object.hasOwn(contract!, "jobName")).toBe(false);
});

test("returns undefined when a document is absent", async () => {
  const { db } = reader(async () => ({ exists: false }));
  expect(await createGetTask(db)("a")).toBeUndefined();
});

test("propagates lookup failures", async () => {
  const { db } = reader(async () => {
    throw new Error("read failed");
  });
  await expect(createGetTask(db)("a")).rejects.toThrow("read failed");
});
