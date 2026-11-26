import { describe, expect, spyOn, test } from "bun:test";

import {
  FirestoreSessionService,
  MessageQueuedError,
  RunInProgressError,
  runFields,
  runState,
  toSessionName,
} from "./session-service";

test("toSessionName normalizes whitespace, truncates long prompts, and skips blank prompts", () => {
  expect(toSessionName("   ")).toBeUndefined();
  expect(toSessionName("  Who directed\n  The Shawshank Redemption?  ")).toBe(
    "Who directed The Shawshank Redemption?",
  );
  const long = "a".repeat(130);
  const name = toSessionName(long);
  expect(name).toHaveLength(120);
  expect(name?.endsWith("…")).toBe(true);
});

describe("runState", () => {
  const base = { runStatus: "running", runStartedAt: 100, runLeaseUntil: 1_000 } as const;
  test("reports nothing for a session that never ran", () => {
    expect(runState({})).toBeUndefined();
  });
  test("reports a live run as running", () => {
    expect(runState(base, 500)).toEqual({ status: "running", startedAt: 100 });
  });
  test("reports the mode the run was hosted in", () => {
    expect(runState({ ...base, runMode: "quick" }, 500)).toEqual({
      status: "running",
      startedAt: 100,
      mode: "quick",
    });
  });
  test("reads a stored mode it does not know as none", () => {
    const doc = { get: (field: string) => (field === "runMode" ? "bogus" : undefined) };
    expect(runFields(doc).runMode).toBeUndefined();
    expect(runFields({ get: (field) => (field === "runMode" ? "quick" : undefined) }).runMode).toBe(
      "quick",
    );
  });
  test("reports a run whose lease lapsed as failed", () => {
    expect(runState(base, 2_000)).toEqual({
      status: "failed",
      startedAt: 100,
      endedAt: 1_000,
      error: "The run stopped responding",
    });
  });
  test("reports finished runs with their end and error", () => {
    expect(
      runState({ runStatus: "failed", runStartedAt: 1, runEndedAt: 2, runError: "boom" }),
    ).toEqual({ status: "failed", startedAt: 1, endedAt: 2, error: "boom" });
  });
});

const fakeDb = (fields: Record<string, unknown> = {}) => {
  const updates: Record<string, unknown>[] = [];
  const ref = {
    get: async () => snapshot,
    update: async (data: Record<string, unknown>) => {
      updates.push(data);
      Object.assign(fields, data);
    },
  };
  const snapshot = { exists: true, get: (name: string) => fields[name] };
  const db = {
    collection: () => ({ doc: () => ref }),
    runTransaction: async (fn: (tx: unknown) => Promise<void>) =>
      fn({
        get: async () => snapshot,
        update: (_r: unknown, data: object) => {
          updates.push(data as Record<string, unknown>);
          Object.assign(fields, data);
        },
      }),
  };
  return { db: db as never, updates };
};
const key = { appName: "a", userId: "u", sessionId: "s" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("queued messages", () => {
  const fields = () => ({ pendingMessage: null as string | null }) as Record<string, unknown>;
  test("a message survives a failed run and is cleared by a successful one", async () => {
    const f = fields();
    const service = new FirestoreSessionService(fakeDb(f).db, 5);
    await service.queueMessage(key, "answer", { now: 1_000 });
    await service.startRun(key, { now: 2_000 });
    expect(f.pendingMessage).toBe("answer");
    await service.finishRun(key, "boom");
    expect(f.pendingMessage).toBe("answer");
    await service.startRun(key, { now: 3_000 });
    await service.finishRun(key);
    expect(f.pendingMessage).toBeNull();
  });

  test("a message left by a failed run does not block the next one", async () => {
    const f = fields();
    const service = new FirestoreSessionService(fakeDb(f).db, 5);
    await service.queueMessage(key, "one", { now: 1_000 });
    await service.startRun(key, { now: 2_000 });
    await service.finishRun(key, "boom", 3_000);
    await service.queueMessage(key, "two", { now: 4_000 });
    expect(f.pendingMessage).toBe("two");
  });

  test("refuses a second message moments later but accepts one after the TTL", async () => {
    const f = fields();
    const service = new FirestoreSessionService(fakeDb(f).db, 5);
    await service.queueMessage(key, "one", { now: 1_000 });
    await expect(service.queueMessage(key, "two", { now: 2_000 })).rejects.toBeInstanceOf(
      MessageQueuedError,
    );
    await service.queueMessage(key, "two", { now: 1_000 + 61_000 });
    expect(f.pendingMessage).toBe("two");
  });

  test("refuses a message while the session runs", async () => {
    const f = fields();
    const service = new FirestoreSessionService(fakeDb(f).db, 5);
    await service.startRun(key, { now: 1_000 });
    await expect(service.queueMessage(key, "x", { now: 2_000 })).rejects.toBeInstanceOf(
      RunInProgressError,
    );
    await service.finishRun(key);
  });

  test("pendingMessage returns the queued message, or nothing", async () => {
    const f = fields();
    const service = new FirestoreSessionService(fakeDb(f).db, 5);
    expect(await service.pendingMessage(key)).toBeUndefined();
    await service.queueMessage(key, "one", { now: 1_000 });
    expect(await service.pendingMessage(key)).toBe("one");
  });

  test("clearMessage drops the queued message", async () => {
    const f = fields();
    const service = new FirestoreSessionService(fakeDb(f).db, 5);
    await service.queueMessage(key, "one", { now: 1_000 });
    await service.clearMessage(key);
    expect(f.pendingMessage).toBeNull();
  });
});

describe("run lease heartbeat", () => {
  test("renews the lease between events until the run finishes", async () => {
    const { db, updates } = fakeDb();
    const service = new FirestoreSessionService(db, 5);
    await service.startRun(key);
    await sleep(30);
    const renewals = updates.filter((u) => "runLeaseUntil" in u).length;
    expect(renewals).toBeGreaterThan(1);
    await service.finishRun(key);
    const after = updates.length;
    await sleep(20);
    expect(updates.length).toBe(after);
  });

  test("a run that lost the session stops renewing the lease and cannot end the other run", async () => {
    const fields: Record<string, unknown> = {};
    const { db, updates } = fakeDb(fields);
    const service = new FirestoreSessionService(db, 5);
    await service.startRun(key);
    // Another run takes the session over.
    Object.assign(fields, { runId: "other", runStatus: "running", runLeaseUntil: 9e15 });
    const spy = spyOn(console, "error").mockImplementation(() => {});
    await sleep(30);
    const before = updates.length;
    await sleep(20);
    expect(updates.length).toBe(before);
    await service.finishRun(key);
    expect(fields.runStatus).toBe("running");
    expect(fields.runId).toBe("other");
    spy.mockRestore();
  });

  test("finishRun keeps only the first line of the error, trimmed", async () => {
    const fields: Record<string, unknown> = {};
    const { db } = fakeDb(fields);
    const service = new FirestoreSessionService(db, 5);
    await service.startRun(key);
    await service.finishRun(key, `${"x".repeat(500)}\n at secret/path.ts:1`);
    expect(fields.runError).toBe("x".repeat(200));
  });
});
