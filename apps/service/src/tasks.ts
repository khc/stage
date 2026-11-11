import type { Firestore } from "@google-cloud/firestore";
import type { TaskContract } from "@agent-jobs/agent/task-contract";

export type { TaskContract, GetTask } from "@agent-jobs/agent/task-contract";
export { createGetTask } from "@agent-jobs/agent/task-contract";

export type CreateTask = (input: {
  prompt: string;
  jobName: string;
}) => Promise<TaskContract & { jobName: string }>;
export type ListTasks = () => Promise<TaskContract[]>;

export const createCreateTask =
  (db: Pick<Firestore, "collection">): CreateTask =>
  async ({ prompt, jobName }) => {
    const contract = { taskId: crypto.randomUUID(), prompt, jobName };
    await db.collection("tasks").doc(contract.taskId).create(contract);
    return contract;
  };

export const createListTasks =
  (db: Pick<Firestore, "collection">): ListTasks =>
  async () => {
    const snapshot = await db.collection("tasks").get();
    return snapshot.docs.map((doc) => {
      const jobName = doc.get("jobName");
      return {
        taskId: doc.id,
        prompt: doc.get("prompt"),
        ...(jobName !== undefined && { jobName }),
      };
    });
  };
