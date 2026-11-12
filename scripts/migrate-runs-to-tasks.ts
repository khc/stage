import { isDeepStrictEqual } from "node:util";

import { FieldPath, Firestore, type QueryDocumentSnapshot } from "@google-cloud/firestore";
import { z } from "zod";

const uuid = z.uuid();

async function* documents(db: Firestore, collection: string) {
  let last: QueryDocumentSnapshot | undefined;
  while (true) {
    let query = db.collection(collection).orderBy(FieldPath.documentId()).limit(250);
    if (last) query = query.startAfter(last);
    const page = await query.get();
    yield* page.docs;
    if (page.size < 250) return;
    last = page.docs.at(-1);
  }
}

export const migrateRunsToTasks = async (db: Firestore, { apply = false } = {}) => {
  const result = {
    tasks: 0,
    sessions: 0,
    unchangedTasks: 0,
    unchangedSessions: 0,
  };
  for await (const source of documents(db, "runs")) {
    const { runId, ...fields } = source.data();
    if (
      !uuid.safeParse(source.id).success ||
      (runId !== undefined && runId !== source.id) ||
      (fields.taskId !== undefined && fields.taskId !== source.id)
    )
      throw new Error(`Invalid run identity: ${source.id}`);
    const data = { ...fields, taskId: source.id };
    const target = db.collection("tasks").doc(source.id);
    const current = await target.get();
    if (current.exists) {
      if (!isDeepStrictEqual(current.data(), data))
        throw new Error(`Conflicting task: ${source.id}`);
      result.unchangedTasks++;
      continue;
    }
    if (apply) await target.create(data);
    result.tasks++;
  }
  for await (const session of documents(db, "sessions")) {
    const runId: unknown = session.get("runId");
    if (runId === undefined) continue;
    if (!uuid.safeParse(runId).success) throw new Error(`Invalid session runId: ${session.id}`);
    const taskId: unknown = session.get("taskId");
    if (taskId !== undefined) {
      if (taskId !== runId) throw new Error(`Conflicting session: ${session.id}`);
      result.unchangedSessions++;
      continue;
    }
    // Keep runId for compatibility with older readers. Guard against concurrent updates.
    if (apply) await session.ref.update({ taskId: runId }, { lastUpdateTime: session.updateTime });
    result.sessions++;
  }
  return result;
};

if (import.meta.main) {
  let db: Firestore | undefined;
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== "--apply"))
      throw new Error("Usage: bun scripts/migrate-runs-to-tasks.ts [--apply]");
    db = new Firestore();
    const apply = args.includes("--apply");
    const counts = await migrateRunsToTasks(db, { apply });
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...counts }));
  } catch (err) {
    console.error(err instanceof Error ? err.message : "Migration failed");
    process.exitCode = 1;
  } finally {
    await db?.terminate();
  }
}
