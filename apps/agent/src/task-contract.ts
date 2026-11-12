import type { DocumentSnapshot, Firestore } from "@google-cloud/firestore";

export type TaskContract = {
  taskId: string;
  prompt: string;
  jobName?: string;
  agentName?: string;
};
export type GetTask = (taskId: string) => Promise<TaskContract | undefined>;

export const toContract = (doc: DocumentSnapshot): TaskContract => {
  const jobName = doc.get("jobName");
  const agentName = doc.get("agentName");
  return {
    taskId: doc.id,
    prompt: doc.get("prompt"),
    ...(jobName !== undefined && { jobName }),
    ...(agentName !== undefined && { agentName }),
  };
};

export const createGetTask =
  (db: Pick<Firestore, "collection">): GetTask =>
  async (taskId) => {
    const doc = await db.collection("tasks").doc(taskId).get();
    return doc.exists ? toContract(doc) : undefined;
  };
