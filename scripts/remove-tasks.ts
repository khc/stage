import { Firestore } from "@google-cloud/firestore";

const collections = ["tasks", "sessions"] as const;

// Removes every task (with its documents) and every session (with its events). Returns how many of
// each there were. Deletes document by document: the emulator ignores recursiveDelete on a collection.
export const removeTasks = async (db: Firestore) => {
  const removed: Record<(typeof collections)[number], number> = { tasks: 0, sessions: 0 };
  for (const name of collections) {
    const refs = await db.collection(name).listDocuments();
    for (const ref of refs) await db.recursiveDelete(ref);
    removed[name] = refs.length;
  }
  return removed;
};

if (import.meta.main) {
  let db: Firestore | undefined;
  try {
    // Never reach a real project: this wipes data, so it runs only against the emulator.
    if (!process.env.FIRESTORE_EMULATOR_HOST)
      throw new Error("FIRESTORE_EMULATOR_HOST is not set; refusing to run against Firestore");
    db = new Firestore();
    console.log(JSON.stringify({ removed: await removeTasks(db) }));
  } catch (err) {
    console.error(err instanceof Error ? err.message : "Cleanup failed");
    process.exitCode = 1;
  } finally {
    await db?.terminate();
  }
}
