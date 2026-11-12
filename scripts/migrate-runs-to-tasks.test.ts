import { describe, expect, test } from "bun:test";

import { Firestore } from "@google-cloud/firestore";

import { migrateRunsToTasks } from "./migrate-runs-to-tasks";

// Isolated emulator projects prevent these migration tests touching local app data.
const withDatabase = async (testBody: (db: Firestore) => Promise<void>) => {
  const db = new Firestore({ projectId: `migration-${crypto.randomUUID()}` });
  try {
    await testBody(db);
  } finally {
    for (const name of ["runs", "tasks", "sessions"]) {
      const docs = await db.collection(name).get();
      for (const doc of docs.docs) await doc.ref.delete();
    }
    await db.terminate();
  }
};

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)("runs to tasks migration", () => {
  test("dry run leaves source, target and sessions untouched", () =>
    withDatabase(async (db) => {
      const id = crypto.randomUUID();
      await db.collection("runs").doc(id).create({ runId: id, prompt: "hello", jobName: "my-job" });
      await db
        .collection("sessions")
        .doc("s1")
        .create({ runId: id, state: { count: 1 } });
      expect(await migrateRunsToTasks(db)).toMatchObject({
        tasks: 1,
        sessions: 1,
      });
      expect((await db.collection("tasks").get()).empty).toBe(true);
      expect((await db.collection("sessions").doc("s1").get()).data()).toEqual({
        runId: id,
        state: { count: 1 },
      });
      expect((await db.collection("runs").doc(id).get()).exists).toBe(true);
    }));

  test("copies contracts, links sessions, preserves legacy data and is repeatable", () =>
    withDatabase(async (db) => {
      const id = crypto.randomUUID();
      const source = {
        runId: id,
        prompt: "hello",
        jobName: "my-job",
        extra: { keep: true },
      };
      await db.collection("runs").doc(id).create(source);
      await db
        .collection("sessions")
        .doc("s1")
        .create({ runId: id, state: { count: 1 } });
      await db.collection("sessions").doc("chat").create({ state: {} });
      expect(await migrateRunsToTasks(db, { apply: true })).toMatchObject({
        tasks: 1,
        sessions: 1,
      });
      expect((await db.collection("tasks").doc(id).get()).data()).toEqual({
        taskId: id,
        prompt: "hello",
        jobName: "my-job",
        extra: { keep: true },
      });
      expect((await db.collection("runs").doc(id).get()).data()).toEqual(source);
      expect((await db.collection("sessions").doc("s1").get()).data()).toEqual({
        runId: id,
        taskId: id,
        state: { count: 1 },
      });
      expect((await db.collection("sessions").doc("chat").get()).data()).toEqual({ state: {} });
      expect(await migrateRunsToTasks(db, { apply: true })).toEqual({
        tasks: 0,
        sessions: 0,
        unchangedTasks: 1,
        unchangedSessions: 1,
      });
    }));

  test("refuses to overwrite a conflicting task", () =>
    withDatabase(async (db) => {
      const id = crypto.randomUUID();
      await db.collection("runs").doc(id).create({ runId: id, prompt: "old" });
      await db.collection("tasks").doc(id).create({ taskId: id, prompt: "different" });
      await expect(migrateRunsToTasks(db, { apply: true })).rejects.toThrow("Conflicting task");
      expect((await db.collection("tasks").doc(id).get()).get("prompt")).toBe("different");
    }));

  test("rejects inconsistent source identities without copying", () =>
    withDatabase(async (db) => {
      const id = crypto.randomUUID();
      await db.collection("runs").doc(id).create({ runId: crypto.randomUUID(), prompt: "hello" });
      await expect(migrateRunsToTasks(db, { apply: true })).rejects.toThrow("Invalid run identity");
      expect((await db.collection("tasks").get()).empty).toBe(true);
    }));

  test("refuses to replace an existing session link", () =>
    withDatabase(async (db) => {
      const runId = crypto.randomUUID();
      const taskId = crypto.randomUUID();
      await db.collection("sessions").doc("s1").create({ runId, taskId });
      await expect(migrateRunsToTasks(db, { apply: true })).rejects.toThrow("Conflicting session");
      expect((await db.collection("sessions").doc("s1").get()).get("taskId")).toBe(taskId);
    }));

  test("visits multiple pages and accepts legacy prompt-only contracts", () =>
    withDatabase(async (db) => {
      const batch = db.batch();
      for (let i = 0; i < 251; i++) {
        const id = crypto.randomUUID();
        batch.create(db.collection("runs").doc(id), {
          runId: id,
          prompt: `prompt ${i}`,
        });
      }
      await batch.commit();
      expect((await migrateRunsToTasks(db, { apply: true })).tasks).toBe(251);
      expect((await db.collection("tasks").get()).size).toBe(251);
    }));
});
