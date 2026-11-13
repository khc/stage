import { afterAll, describe, expect, spyOn, test } from "bun:test";

import { Firestore } from "@google-cloud/firestore";
import { createEvent } from "@google/adk";

import {
  FirestoreSessionService,
  MessageQueuedError,
  RunInProgressError,
  RunLostError,
  runState,
} from "./session-service";

const db = new Firestore();
const newService = () => new FirestoreSessionService(db);
const apps: string[] = [];
const newApp = () => {
  const appName = `test-${crypto.randomUUID()}`;
  apps.push(appName);
  return { appName, userId: "u" };
};
// Every test works in its own app, so removing what each app holds leaves
// nothing behind in the emulator.
afterAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) return;
  const service = newService();
  for (const appName of apps) {
    const { sessions } = await service.listSessions({ appName });
    for (const { userId, id } of sessions)
      await service.deleteSession({ appName, userId, sessionId: id });
  }
});
const reply = (text: string, extra: Parameters<typeof createEvent>[0] = {}) =>
  createEvent({
    author: "agent",
    content: { role: "model", parts: [{ text }] },
    ...extra,
  });
const texts = (events: { content?: { parts?: { text?: string }[] } }[]) =>
  events.map((e) => e.content?.parts?.[0]?.text);

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)("FirestoreSessionService", () => {
  test("persists a session across service instances and drops temp state", async () => {
    const key = newApp();
    const created = await newService().createSession({
      ...key,
      sessionId: "s1",
      state: { a: 1, "temp:x": 2 },
    });

    const loaded = await newService().getSession({ ...key, sessionId: "s1" });

    expect(created.id).toBe("s1");
    expect(loaded?.id).toBe("s1");
    expect(loaded?.state).toEqual({ a: 1 });
    expect(loaded?.events).toEqual([]);
  });

  test("links separate sessions to a run and preserves metadata across reads and events", async () => {
    const key = newApp();
    const taskId = crypto.randomUUID();
    const service = newService();
    const first = await service.createSession({ ...key, taskId });
    const second = await service.createSession({ ...key, taskId });
    try {
      expect(first.id).not.toBe(second.id);
      expect(first).toMatchObject({ taskId });
      const documentId = [key.appName, key.userId, first.id].map(encodeURIComponent).join(":");
      expect((await db.collection("sessions").doc(documentId).get()).get("taskId")).toBe(taskId);
      await service.appendEvent({ session: first, event: reply("one") });
      expect(await newService().getSession({ ...key, sessionId: first.id })).toMatchObject({
        taskId,
      });
      const listed = await newService().listSessions(key);
      expect(listed.sessions).toHaveLength(2);
      expect(listed.sessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: first.id, taskId }),
          expect.objectContaining({ id: second.id, taskId }),
        ]),
      );
    } finally {
      await service.deleteSession({ ...key, sessionId: first.id });
      await service.deleteSession({ ...key, sessionId: second.id });
    }
  });

  test("omits taskId for sessions created without a task contract", async () => {
    const key = newApp();
    const session = await newService().createSession(key);
    try {
      const loaded = await newService().getSession({
        ...key,
        sessionId: session.id,
      });
      expect(Object.hasOwn(session, "taskId")).toBe(false);
      expect(Object.hasOwn(loaded!, "taskId")).toBe(false);
      const documentId = [key.appName, key.userId, session.id].map(encodeURIComponent).join(":");
      expect((await db.collection("sessions").doc(documentId).get()).get("taskId")).toBeUndefined();
    } finally {
      await newService().deleteSession({ ...key, sessionId: session.id });
    }
  });

  test("appendEvent persists events in order and applies the state delta", async () => {
    const key = newApp();
    const service = newService();
    const session = await service.createSession({ ...key, sessionId: "s1" });

    await service.appendEvent({ session, event: reply("one") });
    await service.appendEvent({
      session,
      event: reply("two", { actions: { stateDelta: { count: 2 } } }),
    });

    const loaded = await newService().getSession({ ...key, sessionId: "s1" });
    expect(texts(loaded!.events)).toEqual(["one", "two"]);
    expect(loaded!.state).toEqual({ count: 2 });
  });

  test("never persists temp: state from a state delta", async () => {
    const key = newApp();
    const service = newService();
    const session = await service.createSession({ ...key, sessionId: "s1" });

    await service.appendEvent({
      session,
      event: reply("x", { actions: { stateDelta: { "temp:t": 1, k: "v" } } }),
    });

    const loaded = await newService().getSession({ ...key, sessionId: "s1" });
    expect(loaded!.state).toEqual({ k: "v" });
  });

  test("does not persist partial events", async () => {
    const key = newApp();
    const service = newService();
    const session = await service.createSession({ ...key, sessionId: "s1" });

    await service.appendEvent({
      session,
      event: reply("p", { partial: true }),
    });

    const loaded = await newService().getSession({ ...key, sessionId: "s1" });
    expect(loaded!.events).toEqual([]);
  });

  test("getSession honors numRecentEvents and afterTimestamp", async () => {
    const key = newApp();
    const service = newService();
    const session = await service.createSession({ ...key, sessionId: "s1" });
    for (const [text, timestamp] of [
      ["a", 1000],
      ["b", 2000],
      ["c", 3000],
    ] as const) {
      await service.appendEvent({
        session,
        event: reply(text, { timestamp }),
      });
    }

    const recent = await newService().getSession({
      ...key,
      sessionId: "s1",
      config: { numRecentEvents: 2 },
    });
    const after = await newService().getSession({
      ...key,
      sessionId: "s1",
      config: { afterTimestamp: 2000 },
    });

    expect(texts(recent!.events)).toEqual(["b", "c"]);
    expect(texts(after!.events)).toEqual(["b", "c"]);
  });

  test("listSessions filters by user and orders by last update time", async () => {
    const { appName } = newApp();
    const service = newService();
    await service.createSession({ appName, userId: "u", sessionId: "old" });
    await Bun.sleep(5);
    await service.createSession({ appName, userId: "u", sessionId: "new" });
    await service.createSession({ appName, userId: "other", sessionId: "x" });

    const listed = await newService().listSessions({
      appName,
      userId: "u",
      order: "desc",
    });

    expect(listed.sessions.map((s) => s.id)).toEqual(["new", "old"]);
    expect(listed.totalItems).toBe(2);
    expect(listed.sessions[0]?.events).toEqual([]);
  });

  test("deleteSession removes the session and its events", async () => {
    const key = newApp();
    const service = newService();
    const session = await service.createSession({ ...key, sessionId: "s1" });
    await service.appendEvent({ session, event: reply("one") });

    await service.deleteSession({ ...key, sessionId: "s1" });

    expect(await service.getSession({ ...key, sessionId: "s1" })).toBeUndefined();
    await service.createSession({ ...key, sessionId: "s1" });
    expect((await service.getSession({ ...key, sessionId: "s1" }))!.events).toEqual([]);
  });

  test("getSession returns undefined for an unknown session", async () => {
    expect(await newService().getSession({ ...newApp(), sessionId: "missing" })).toBeUndefined();
  });
});

describe("runState", () => {
  const base = { runStatus: "running", runStartedAt: 100, runLeaseUntil: 1_000 } as const;
  test("reports nothing for a session that never ran", () => {
    expect(runState({})).toBeUndefined();
  });
  test("reports a live run as running", () => {
    expect(runState(base, 500)).toEqual({ status: "running", startedAt: 100 });
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

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)("session runs", () => {
  test("a live run blocks a second one until it finishes or its lease lapses", async () => {
    const key = newApp();
    const service = newService();
    const { id } = await service.createSession(key);
    const ref = { ...key, sessionId: id };
    await service.startRun(ref, 1_000);
    await expect(service.startRun(ref, 2_000)).rejects.toBeInstanceOf(RunInProgressError);
    await service.finishRun(ref, undefined, 3_000);
    const done = await service.getSession(ref);
    expect((done as { run?: unknown }).run).toMatchObject({ status: "succeeded", endedAt: 3_000 });
    await service.startRun(ref, 4_000);
    await expect(service.startRun(ref, 5_000)).rejects.toBeInstanceOf(RunInProgressError);
    await service.startRun(ref, 4_000 + 11 * 60_000);
  });

  test("of two simultaneous runs exactly one starts", async () => {
    const key = newApp();
    const service = newService();
    const { id } = await service.createSession(key);
    const ref = { ...key, sessionId: id };
    const results = await Promise.allSettled([service.startRun(ref), service.startRun(ref)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((r) => r.status === "rejected");
    expect((failure as PromiseRejectedResult).reason).toBeInstanceOf(RunInProgressError);
    await service.finishRun(ref);
  });

  test("of two simultaneous messages exactly one is queued", async () => {
    const key = newApp();
    const service = newService();
    const { id } = await service.createSession(key);
    const ref = { ...key, sessionId: id };
    const results = await Promise.allSettled([
      service.queueMessage(ref, "one"),
      service.queueMessage(ref, "two"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason,
    ).toBeInstanceOf(MessageQueuedError);
    expect(["one", "two"]).toContain((await service.pendingMessage(ref)) ?? "");
  });

  test("a queued message is read back and cleared by a successful run", async () => {
    const key = newApp();
    const service = newService();
    const { id } = await service.createSession(key);
    const ref = { ...key, sessionId: id };
    expect(await service.pendingMessage(ref)).toBeUndefined();
    await service.queueMessage(ref, "answer");
    expect(await service.pendingMessage(ref)).toBe("answer");
    await service.startRun(ref);
    await service.finishRun(ref);
    expect(await service.pendingMessage(ref)).toBeUndefined();
  });

  test("appendEvent tells onUserEvent about user messages only", async () => {
    const key = newApp();
    const service = newService();
    const seen: string[] = [];
    service.onUserEvent = async (event) => {
      seen.push(event.author ?? "");
    };
    const session = await service.createSession(key);
    await service.appendEvent({ session, event: reply("hi", { author: "user" }) });
    await service.appendEvent({ session, event: reply("hello") });
    expect(seen).toEqual(["user"]);
  });

  test("a run that lost the session cannot append events or end the new run", async () => {
    const key = newApp();
    const first = newService();
    const second = newService();
    const session = await first.createSession(key);
    const ref = { ...key, sessionId: session.id };
    // The first run started long ago and its lease lapsed, so a second run takes the session over.
    await first.startRun(ref, Date.now() - 11 * 60_000);
    await second.startRun(ref);
    const stale = await first.getSession(ref);
    const lost = await first.appendEvent({ session: stale!, event: reply("late") }).catch((e) => e);
    expect(lost).toBeInstanceOf(RunLostError);
    await first.finishRun(ref, "late failure");
    const current = await second.getSession(ref);
    expect((current as { run?: { status: string } }).run?.status).toBe("running");
    await second.appendEvent({ session: current!, event: reply("current") });
    const after = await second.getSession(ref);
    expect(texts(after!.events)).toEqual(["current"]);
    await second.finishRun(ref);
  });

  test("findOwner returns the app and user a session was created under", async () => {
    const key = newApp();
    const service = newService();
    const { id } = await service.createSession(key);
    expect(await service.findOwner(id)).toEqual(key);
    expect(await service.findOwner(crypto.randomUUID())).toBeUndefined();
  });

  test("finishRun with an error records a failed run", async () => {
    const key = newApp();
    const service = newService();
    const { id } = await service.createSession(key);
    const ref = { ...key, sessionId: id };
    await service.startRun(ref);
    await service.finishRun(ref, "boom");
    expect(((await service.getSession(ref)) as { run?: unknown }).run).toMatchObject({
      status: "failed",
      error: "boom",
    });
  });
});

// A minimal in-memory Firestore: one session document, enough for the run lease.
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
    await service.queueMessage(key, "answer", 1_000);
    await service.startRun(key, 2_000);
    expect(f.pendingMessage).toBe("answer");
    await service.finishRun(key, "boom");
    expect(f.pendingMessage).toBe("answer");
    await service.startRun(key, 3_000);
    await service.finishRun(key);
    expect(f.pendingMessage).toBeNull();
  });

  test("a message left by a failed run does not block the next one", async () => {
    const f = fields();
    const service = new FirestoreSessionService(fakeDb(f).db, 5);
    await service.queueMessage(key, "one", 1_000);
    await service.startRun(key, 2_000);
    await service.finishRun(key, "boom", 3_000);
    await service.queueMessage(key, "two", 4_000);
    expect(f.pendingMessage).toBe("two");
  });

  test("refuses a second message moments later but accepts one after the TTL", async () => {
    const f = fields();
    const service = new FirestoreSessionService(fakeDb(f).db, 5);
    await service.queueMessage(key, "one", 1_000);
    await expect(service.queueMessage(key, "two", 2_000)).rejects.toBeInstanceOf(
      MessageQueuedError,
    );
    await service.queueMessage(key, "two", 1_000 + 61_000);
    expect(f.pendingMessage).toBe("two");
  });

  test("refuses a message while the session runs", async () => {
    const f = fields();
    const service = new FirestoreSessionService(fakeDb(f).db, 5);
    await service.startRun(key, 1_000);
    await expect(service.queueMessage(key, "x", 2_000)).rejects.toBeInstanceOf(RunInProgressError);
    await service.finishRun(key);
  });

  test("pendingMessage returns the queued message, or nothing", async () => {
    const f = fields();
    const service = new FirestoreSessionService(fakeDb(f).db, 5);
    expect(await service.pendingMessage(key)).toBeUndefined();
    await service.queueMessage(key, "one", 1_000);
    expect(await service.pendingMessage(key)).toBe("one");
  });

  test("clearMessage drops the queued message", async () => {
    const f = fields();
    const service = new FirestoreSessionService(fakeDb(f).db, 5);
    await service.queueMessage(key, "one", 1_000);
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
