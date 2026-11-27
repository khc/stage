import { describe, expect, test } from "bun:test";

import { Firestore } from "@google-cloud/firestore";

import { removeTasks } from "./remove-tasks";

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)("remove tasks", () => {
  test("removes every task and session with their documents and events, and counts them", async () => {
    const db = new Firestore({ projectId: `remove-tasks-${crypto.randomUUID()}` });
    try {
      await db.collection("tasks").doc("t1").set({ prompt: "p" });
      await db.collection("tasks").doc("t1").collection("documents").doc("d1").set({ name: "a" });
      await db.collection("tasks").doc("t2").set({ prompt: "q" });
      await db.collection("sessions").doc("s1").set({ taskId: "t1" });
      await db.collection("sessions").doc("s1").collection("events").doc("e1").set({ seq: 1 });
      await db.collection("sessions").doc("unlinked").set({ appName: "x" });
      await db.collection("other").doc("kept").set({ ok: true });

      expect(await removeTasks(db)).toEqual({ tasks: 2, sessions: 2 });

      expect((await db.collection("tasks").get()).size).toBe(0);
      expect((await db.collection("sessions").get()).size).toBe(0);
      expect((await db.collection("tasks").doc("t1").collection("documents").get()).size).toBe(0);
      expect((await db.collection("sessions").doc("s1").collection("events").get()).size).toBe(0);
      expect((await db.collection("other").get()).size).toBe(1);
      expect(await removeTasks(db)).toEqual({ tasks: 0, sessions: 0 });
    } finally {
      await db.recursiveDelete(db.collection("other"));
      await db.terminate();
    }
  });
});
