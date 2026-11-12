import { Firestore } from "@google-cloud/firestore";

// A session is orphaned when its taskId points to a task that no longer
// exists. Sessions without a taskId are not task sessions and are kept unless
// includeUnlinked is set.
export const removeOrphanedSessions = async (
  db: Firestore,
  { apply = false, includeUnlinked = false } = {},
) => {
  const sessions = await db.collection("sessions").get();
  const taskIds = [...new Set(sessions.docs.map((s) => s.get("taskId")).filter(Boolean))];
  const missing = new Set<string>();
  if (taskIds.length) {
    const tasks = await db.getAll(...taskIds.map((id) => db.collection("tasks").doc(id)));
    for (const task of tasks) if (!task.exists) missing.add(task.id);
  }
  const orphans = sessions.docs.filter((s) => {
    const taskId = s.get("taskId");
    return taskId ? missing.has(taskId) : includeUnlinked;
  });
  if (apply) for (const session of orphans) await db.recursiveDelete(session.ref);
  return { sessions: sessions.size, orphaned: orphans.length, tasksMissing: missing.size };
};

if (import.meta.main) {
  let db: Firestore | undefined;
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== "--apply" && arg !== "--include-unlinked"))
      throw new Error(
        "Usage: bun scripts/remove-orphaned-sessions.ts [--apply] [--include-unlinked]",
      );
    db = new Firestore();
    const apply = args.includes("--apply");
    console.log(
      JSON.stringify({
        mode: apply ? "apply" : "dry-run",
        ...(await removeOrphanedSessions(db, {
          apply,
          includeUnlinked: args.includes("--include-unlinked"),
        })),
      }),
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : "Cleanup failed");
    process.exitCode = 1;
  } finally {
    await db?.terminate();
  }
}
