import type { Firestore } from "@google-cloud/firestore";

export type TaskContract = { taskId: string; prompt: string; jobName?: string };
export type GetTask = (taskId: string) => Promise<TaskContract | undefined>;

export const createGetTask =
  (db: Pick<Firestore, "collection">): GetTask =>
  async (taskId) => {
    const doc = await db.collection("tasks").doc(taskId).get();
    if (!doc.exists) return undefined;
    const jobName = doc.get("jobName");
    return {
      taskId: doc.id,
      prompt: doc.get("prompt"),
      ...(jobName !== undefined && { jobName }),
    };
  };
