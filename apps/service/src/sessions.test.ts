import { Firestore } from "@google-cloud/firestore";
import { createEvent } from "@google/adk";
import { describe, expect, test } from "bun:test";
import { FirestoreSessionService } from "@agent-jobs/agent/session-service";
import { createTaskSessions } from "./sessions";

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)("task sessions", () => {
  test("lists only task summaries and gets owned sessions with state and ordered events", async () => {
    const db = new Firestore();
    const service = new FirestoreSessionService(db);
    const api = createTaskSessions(db);
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
      expect(loaded?.events.map((e) => e.content?.parts?.[0]?.text)).toEqual([
        "one",
        "two",
      ]);
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
      await db.terminate();
    }
  });
});
