import type { Firestore } from "@google-cloud/firestore";
import { expect, mock, test } from "bun:test";
import { createGetRun } from "./run-contract";

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
    runId: "ignored",
    extra: true,
  };
  const { db, collection, doc } = reader(async () => ({
    id: "a",
    exists: true,
    get: (key: string) => data[key],
  }));
  expect(await createGetRun(db)("a")).toEqual({
    runId: "a",
    prompt: "hello",
    jobName: "my-job",
  });
  expect(collection).toHaveBeenCalledWith("runs");
  expect(doc).toHaveBeenCalledWith("a");
});

test("reads legacy prompt-only contracts without adding undefined fields", async () => {
  const { db } = reader(async () => ({
    id: "a",
    exists: true,
    get: (key: string) => (key === "prompt" ? "hello" : undefined),
  }));
  const contract = await createGetRun(db)("a");
  expect(contract).toEqual({ runId: "a", prompt: "hello" });
  expect(Object.hasOwn(contract!, "jobName")).toBe(false);
});

test("returns undefined when a document is absent", async () => {
  const { db } = reader(async () => ({ exists: false }));
  expect(await createGetRun(db)("a")).toBeUndefined();
});

test("propagates lookup failures", async () => {
  const { db } = reader(async () => {
    throw new Error("read failed");
  });
  await expect(createGetRun(db)("a")).rejects.toThrow("read failed");
});
