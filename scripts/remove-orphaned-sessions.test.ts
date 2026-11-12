import { describe, expect, test } from "bun:test";

import { Firestore } from "@google-cloud/firestore";

import { removeOrphanedSessions } from "./remove-orphaned-sessions";

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)("remove orphaned sessions", () => {
  test("dry run keeps data; apply removes only sessions of missing tasks, with their events", async () => {
    const db = new Firestore({ projectId: `orphans-${crypto.randomUUID()}` });
    try {
      await db.collection("tasks").doc("live").set({ prompt: "p" });
      await db.collection("sessions").doc("kept").set({ taskId: "live" });
      await db.collection("sessions").doc("unlinked").set({ appName: "x" });
      await db.collection("sessions").doc("orphan").set({ taskId: "gone" });
      await db.collection("sessions").doc("orphan").collection("events").doc("e1").set({ seq: 1 });

      expect(await removeOrphanedSessions(db)).toEqual({
        sessions: 3,
        orphaned: 1,
        tasksMissing: 1,
      });
      expect((await db.collection("sessions").get()).size).toBe(3);

      await removeOrphanedSessions(db, { apply: true });
      const left = (await db.collection("sessions").get()).docs.map((d) => d.id).toSorted();
      expect(left).toEqual(["kept", "unlinked"]);

      await removeOrphanedSessions(db, { apply: true, includeUnlinked: true });
      expect((await db.collection("sessions").get()).docs.map((d) => d.id)).toEqual(["kept"]);
      expect((await db.collection("sessions").doc("orphan").collection("events").get()).size).toBe(
        0,
      );
    } finally {
      for (const name of ["tasks", "sessions"])
        for (const doc of (await db.collection(name).get()).docs) await db.recursiveDelete(doc.ref);
      await db.terminate();
    }
  });
});
