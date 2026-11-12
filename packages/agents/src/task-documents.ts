import { Firestore } from "@google-cloud/firestore";

export type TaskDocument = { filename: string; contentType: string; content: string };
export type LoadTaskDocuments = (taskId: string) => Promise<TaskDocument[]>;

// Reads the documents attached to a task: the task lists their IDs and each
// ID is a document in the `documents` collection (written by the service).
export const createLoadTaskDocuments = (
  db: Pick<Firestore, "collection" | "getAll">,
): LoadTaskDocuments => {
  return async (taskId) => {
    const task = await db.collection("tasks").doc(taskId).get();
    const refs: { documentId: string }[] = task.get("documents") ?? [];
    if (!refs.length) return [];
    const snaps = await db.getAll(...refs.map((r) => db.collection("documents").doc(r.documentId)));
    return snaps
      .filter((s) => s.exists)
      .map((s) => ({
        filename: s.get("filename"),
        contentType: s.get("contentType"),
        content: s.get("content"),
      }));
  };
};
