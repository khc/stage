import type { DocumentSnapshot, Firestore } from "@google-cloud/firestore";
import { z } from "zod";

export type TaskContract = {
  taskId: string;
  name?: string;
  prompt: string;
  jobName?: string;
  agentName?: string;
  documents?: { documentId: string }[];
};
// The prompt a job accepts, for a task's first turn and for a queued message.
export const promptSchema = z.string().trim().min(1).max(10_000);
export type GetTask = (taskId: string) => Promise<TaskContract | undefined>;

export const toContract = (doc: DocumentSnapshot): TaskContract => {
  const name = doc.get("name");
  const jobName = doc.get("jobName");
  const agentName = doc.get("agentName");
  const documents = doc.get("documents");
  return {
    taskId: doc.id,
    ...(name !== undefined && { name }),
    prompt: doc.get("prompt"),
    ...(jobName !== undefined && { jobName }),
    ...(agentName !== undefined && { agentName }),
    ...(documents !== undefined && { documents }),
  };
};

export const createGetTask =
  (db: Pick<Firestore, "collection">): GetTask =>
  async (taskId) => {
    const doc = await db.collection("tasks").doc(taskId).get();
    return doc.exists ? toContract(doc) : undefined;
  };
