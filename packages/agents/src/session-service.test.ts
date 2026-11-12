import { afterAll, describe, expect, test } from "bun:test";

import { Firestore } from "@google-cloud/firestore";
import { createEvent } from "@google/adk";

import { FirestoreSessionService } from "./session-service";

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
