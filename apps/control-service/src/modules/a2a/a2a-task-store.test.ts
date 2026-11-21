import { expect, test } from "bun:test";

import type { Task } from "@a2a-js/sdk";

import { createBoundedTaskStore } from "./a2a-task-store";

const task = (id: string) =>
  ({ id, kind: "task", contextId: "c", status: { state: "working" } }) as Task;

test("keeps the most recently saved tasks and drops the oldest beyond the limit", async () => {
  const store = createBoundedTaskStore(2);
  await store.save(task("a"));
  await store.save(task("b"));
  await store.save(task("c"));
  expect(await store.load("a")).toBeUndefined();
  expect((await store.load("b"))?.id).toBe("b");
  expect((await store.load("c"))?.id).toBe("c");
});

test("saving a task again refreshes it instead of dropping a newer one", async () => {
  const store = createBoundedTaskStore(2);
  await store.save(task("a"));
  await store.save(task("b"));
  await store.save(task("a"));
  await store.save(task("c"));
  expect(await store.load("b")).toBeUndefined();
  expect((await store.load("a"))?.id).toBe("a");
});

test("hands out a copy, so a caller cannot change what is stored", async () => {
  const store = createBoundedTaskStore(2);
  await store.save(task("a"));
  const loaded = (await store.load("a"))!;
  loaded.status = { state: "completed" };
  expect((await store.load("a"))?.status.state).toBe("working");
});

test("does not keep the message history, which only repeats what the caller sent", async () => {
  const store = createBoundedTaskStore(2);
  await store.save({
    ...task("a"),
    history: [{ kind: "message", messageId: "m", role: "user", parts: [] }],
  });
  expect((await store.load("a"))?.history).toBeUndefined();
});
