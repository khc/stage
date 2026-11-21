import { expect, mock, test } from "bun:test";

import type { Firestore } from "@google-cloud/firestore";

import { createGetTask, promptSchema } from "./task-contract";

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

test("includes agentName when stored", async () => {
  const data: Record<string, unknown> = {
    prompt: "hello",
    jobName: "my-job",
    agentName: "researcher",
  };
  const { db } = reader(async () => ({
    id: "a",
    exists: true,
    get: (key: string) => data[key],
  }));
  expect(await createGetTask(db)("a")).toEqual({
    taskId: "a",
    prompt: "hello",
    jobName: "my-job",
    agentName: "researcher",
  });
});

test("promptSchema trims, rejects blank text and caps the length at 10 000 characters", () => {
  expect(promptSchema.safeParse("  hello  ")).toMatchObject({ success: true, data: "hello" });
  expect(promptSchema.safeParse("   ").success).toBe(false);
  expect(promptSchema.safeParse("a".repeat(10_000)).success).toBe(true);
  expect(promptSchema.safeParse("a".repeat(10_001)).success).toBe(false);
});

test("carries the parent task and session of a delegated task, and omits them otherwise", async () => {
  const stored: Record<string, unknown> = {
    prompt: "hello",
    parentTaskId: "5f4c3d1e-9b0a-4d2e-8a37-1c6f2b9e7a10",
    parentSessionId: "s-1",
  };
  const { db } = reader(async () => ({
    id: "a",
    exists: true,
    get: (key: string) => stored[key],
  }));
  expect(await createGetTask(db)("a")).toEqual({
    taskId: "a",
    prompt: "hello",
    parentTaskId: "5f4c3d1e-9b0a-4d2e-8a37-1c6f2b9e7a10",
    parentSessionId: "s-1",
  });
});

test("carries the default model of a task when stored, and omits it otherwise", async () => {
  const defaultModel = {
    providerId: "5f4c3d1e-9b0a-4d2e-8a37-1c6f2b9e7a10",
    model: "gemini-2.5-flash",
  };
  const stored: Record<string, unknown> = { prompt: "hello", defaultModel };
  const { db } = reader(async () => ({ id: "a", exists: true, get: (key: string) => stored[key] }));
  expect(await createGetTask(db)("a")).toEqual({ taskId: "a", prompt: "hello", defaultModel });

  const bare: Record<string, unknown> = { prompt: "hello" };
  const { db: bareDb } = reader(async () => ({
    id: "a",
    exists: true,
    get: (key: string) => bare[key],
  }));
  expect(await createGetTask(bareDb)("a")).toEqual({ taskId: "a", prompt: "hello" });
});
