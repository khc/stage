import type { Firestore } from "@google-cloud/firestore";
import { toContract, type TaskContract } from "@agent-jobs/agent/task-contract";

export type { TaskContract, GetTask } from "@agent-jobs/agent/task-contract";
export { createGetTask } from "@agent-jobs/agent/task-contract";

export type CreateTask = (input: {
  prompt: string;
  jobName: string;
  agentName?: string;
}) => Promise<TaskContract & { jobName: string }>;
export type ListTasks = () => Promise<TaskContract[]>;

export const createCreateTask =
  (db: Pick<Firestore, "collection">): CreateTask =>
  async ({ prompt, jobName, agentName }) => {
    const contract = {
      taskId: crypto.randomUUID(),
      prompt,
      jobName,
      ...(agentName !== undefined && { agentName }),
    };
    await db.collection("tasks").doc(contract.taskId).create(contract);
    return contract;
  };

export const createListTasks =
  (db: Pick<Firestore, "collection">): ListTasks =>
  async () =>
    (await db.collection("tasks").get()).docs.map(toContract);
