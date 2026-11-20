import type { DocumentSnapshot, Firestore } from "@google-cloud/firestore";

export type TaskContract = {
  taskId: string;
  name?: string;
  prompt: string;
  jobName?: string;
  agentName?: string;
  documents?: { documentId: string }[];
};
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
