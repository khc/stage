import { describe, expect, test } from "bun:test";

import { Firestore } from "@google-cloud/firestore";
import { createEvent } from "@google/adk";
import { FirestoreSessionService } from "@stage/agents/session-service";

import { createSessionsStore } from "./sessions-store";

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)("sessions store", () => {
  test("lists only task summaries and gets owned sessions with state and ordered events", async () => {
    const firestore = new Firestore();
    const service = new FirestoreSessionService(firestore);
    const api = createSessionsStore(firestore);
    const key = { appName: `test-${crypto.randomUUID()}`, userId: "user" };
    const taskId = crypto.randomUUID();
    const otherTaskId = crypto.randomUUID();
    const first = await service.createSession({
      ...key,
      taskId,
      state: { count: 1 },
    });
    const other = await service.createSession({ ...key, taskId: otherTaskId });
    const chat = await service.createSession(key);
    try {
      for (const text of ["one", "two"]) {
        await service.appendEvent({
          session: first,
          event: createEvent({
            author: "agent",
            content: { role: "model", parts: [{ text }] },
          }),
        });
      }
      const summaries = await api.list(taskId);
      expect(summaries).toEqual([
        {
          id: first.id,
          taskId,
          appName: key.appName,
          userId: key.userId,
          lastUpdateTime: first.lastUpdateTime,
        },
      ]);
      const loaded = await api.get(taskId, first.id);
      expect(loaded).toMatchObject({
        id: first.id,
        taskId,
        state: { count: 1 },
      });
      expect(loaded?.events.map((e) => e.content?.parts?.[0]?.text)).toEqual(["one", "two"]);
      expect(await api.get(taskId, other.id)).toBeUndefined();
      expect(await api.get(taskId, chat.id)).toBeUndefined();
      expect(await api.get(taskId, "missing")).toBeUndefined();
      expect(await api.list(crypto.randomUUID())).toEqual([]);
      expect(await api.delete(taskId, other.id)).toBe(false);
      expect(await api.delete(taskId, chat.id)).toBe(false);
      expect(await api.get(otherTaskId, other.id)).toBeDefined();
      expect(await api.delete(taskId, first.id)).toBe(true);
      expect(await api.get(taskId, first.id)).toBeUndefined();
      expect(await api.list(taskId)).toEqual([]);
      expect(await api.delete(taskId, first.id)).toBe(false);
    } finally {
      for (const session of [first, other, chat])
        await service.deleteSession({ ...key, sessionId: session.id });
      await firestore.terminate();
    }
  });

  test("exposes the run of a session in the list and the detail", async () => {
    const firestore = new Firestore();
    const service = new FirestoreSessionService(firestore);
    const api = createSessionsStore(firestore);
    const key = { appName: `test-${crypto.randomUUID()}`, userId: "user" };
    const taskId = crypto.randomUUID();
    const session = await service.createSession({ ...key, taskId });
    const ref = { ...key, sessionId: session.id };
    try {
      expect((await api.list(taskId))[0]?.run).toBeUndefined();
      await service.startRun(ref);
      expect((await api.list(taskId))[0]?.run).toMatchObject({ status: "running" });
      expect((await api.get(taskId, session.id))?.run).toMatchObject({ status: "running" });
      await service.finishRun(ref, "boom");
      expect((await api.get(taskId, session.id))?.run).toMatchObject({
        status: "failed",
        error: "boom",
      });
    } finally {
      await service.deleteSession(ref);
      await firestore.terminate();
    }
  });

  test("queues a message only for a session of the task", async () => {
    const firestore = new Firestore();
    const service = new FirestoreSessionService(firestore);
    const api = createSessionsStore(firestore);
    const key = { appName: `test-${crypto.randomUUID()}`, userId: "user" };
    const taskId = crypto.randomUUID();
    const session = await service.createSession({ ...key, taskId });
    const ref = { ...key, sessionId: session.id };
    try {
      expect(await api.queueMessage(crypto.randomUUID(), session.id, "x")).toBe(false);
      expect(await service.pendingMessage(ref)).toBeUndefined();
      expect(await api.queueMessage(taskId, session.id, "answer")).toBe(true);
      expect(await service.pendingMessage(ref)).toBe("answer");
      await api.clearMessage(taskId, session.id);
      expect(await service.pendingMessage(ref)).toBeUndefined();
      const model = { providerId: crypto.randomUUID(), model: "gemini-2.5-flash" };
      expect(await api.queueMessage(taskId, session.id, "with model", model)).toBe(true);
      expect(await service.pendingModel(ref)).toEqual(model);
      await api.clearMessage(taskId, session.id);
      expect(await service.pendingModel(ref)).toBeUndefined();
    } finally {
      await service.deleteSession(ref);
      await firestore.terminate();
    }
  });

  test("failRun records a failed run on a session nobody holds, and leaves a live run alone", async () => {
    const firestore = new Firestore();
    const service = new FirestoreSessionService(firestore);
    const api = createSessionsStore(firestore);
    const key = { appName: `test-${crypto.randomUUID()}`, userId: "user" };
    const taskId = crypto.randomUUID();
    const session = await service.createSession({ ...key, taskId });
    const ref = { ...key, sessionId: session.id };
    try {
      await api.failRun(taskId, session.id, "service down", "quick");
      expect((await api.get(taskId, session.id))?.run).toMatchObject({
        status: "failed",
        error: "service down",
        mode: "quick",
      });
      await service.startRun(ref);
      await api.failRun(taskId, session.id, "too late");
      expect((await api.get(taskId, session.id))?.run?.status).toBe("running");
      await service.finishRun(ref);
      await api.failRun(crypto.randomUUID(), session.id, "wrong task");
    } finally {
      await service.deleteSession(ref);
      await firestore.terminate();
    }
  });

  test("creates a session owned by the task under the runtime owner", async () => {
    const firestore = new Firestore();
    const api = createSessionsStore(firestore);
    const taskId = crypto.randomUUID();
    const sessionId = await api.create(taskId);
    try {
      const created = await api.get(taskId, sessionId);
      expect(created).toMatchObject({ id: sessionId, taskId });
      expect(await api.list(taskId)).toHaveLength(1);
    } finally {
      await api.delete(taskId, sessionId);
      await firestore.terminate();
    }
  });
});
