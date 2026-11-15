import type { Firestore } from "@google-cloud/firestore";
import {
  createGetTask,
  toContract,
  type GetTask,
  type TaskContract,
} from "@stage/agents/task-contract";

export type { GetTask, TaskContract } from "@stage/agents/task-contract";

export type NewTask = { prompt: string; jobName: string; agentName?: string };

export type TaskStore = {
  create: (input: NewTask) => Promise<TaskContract & { jobName: string }>;
  list: () => Promise<TaskContract[]>;
  get: GetTask;
  // False when there was no such task.
  delete: (taskId: string) => Promise<boolean>;
};

export const createTaskStore = (db: Pick<Firestore, "collection">): TaskStore => {
  const tasks = db.collection("tasks");
  return {
    async create({ prompt, jobName, agentName }) {
      const contract = {
        taskId: crypto.randomUUID(),
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
    get: createGetTask(db),
    async delete(taskId) {
      const ref = tasks.doc(taskId);
      if (!(await ref.get()).exists) return false;
      await ref.delete();
      return true;
    },
  };
};
