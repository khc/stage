import type { Firestore } from "@google-cloud/firestore";
import {
  createGetTask,
  toContract,
  type GetTask,
  type TaskContract,
} from "@stage/agents/task-contract";

export type { TaskContract } from "@stage/agents/task-contract";

export type NewTask = { name: string; prompt: string; jobName: string; agentName?: string };

export type TasksStore = {
  create: (input: NewTask) => Promise<TaskContract & { name: string; jobName: string }>;
  list: () => Promise<TaskContract[]>;
  get: GetTask;
  // False when there was no such task.
  delete: (taskId: string) => Promise<boolean>;
};

export const createTasksStore = (firestore: Pick<Firestore, "collection">): TasksStore => {
  const tasks = firestore.collection("tasks");
  return {
    async create({ name, prompt, jobName, agentName }) {
      const contract = {
        taskId: crypto.randomUUID(),
        name,
        prompt,
        jobName,
        documents: [],
        ...(agentName !== undefined && { agentName }),
      };
      await tasks.doc(contract.taskId).create(contract);
      return contract;
    },
    async list() {
      return (await tasks.get()).docs.map(toContract);
    },
    get: createGetTask(firestore),
    async delete(taskId) {
      const ref = tasks.doc(taskId);
      if (!(await ref.get()).exists) return false;
      await ref.delete();
      return true;
    },
  };
};
