import type { AgentRegistry } from "@stage/agents/agent-registry";

import { guard } from "../../errors";
import type { DocumentsStore } from "./documents/documents-store";
import type { SessionsStore } from "./sessions/sessions-store";
import type { NewTask, TaskContract, TasksStore } from "./tasks-store";

export type TasksServiceDeps = {
  tasksStore: TasksStore;
  agentRegistry: Pick<AgentRegistry, "list">;
  sessionsStore: Pick<SessionsStore, "list" | "delete">;
  documentsStore?: Pick<DocumentsStore, "release">;
};

export type CreateTaskResult =
  | { status: "created"; task: Awaited<ReturnType<TasksStore["create"]>> }
  | { status: "unknown_agent" };

// Every expected outcome is a status; a failing dependency throws a DependencyError.
export type TasksService = {
  // A job with registered agents only accepts those; a job without a
  // registration cannot be verified and keeps accepting any valid name.
  create: (input: NewTask) => Promise<CreateTaskResult>;
  list: () => Promise<TaskContract[]>;
  get: (taskId: string) => Promise<TaskContract | undefined>;
  // Deletes the task with its sessions, then releases the documents nobody else uses.
  delete: (taskId: string) => Promise<"deleted" | "not_found">;
};

export const createTasksService = ({
  tasksStore,
  agentRegistry,
  sessionsStore,
  documentsStore,
}: TasksServiceDeps): TasksService => ({
  create: (input) =>
    guard("task_error", async (): Promise<CreateTaskResult> => {
      if (input.agentName !== undefined) {
        const known = await agentRegistry.list(input.jobName);
        if (known.length && !known.some((agent) => agent.name === input.agentName))
          return { status: "unknown_agent" };
      }
      return { status: "created", task: await tasksStore.create(input) };
    }),
  list: () => guard("task_error", tasksStore.list),
  get: (taskId) => guard("task_error", () => tasksStore.get(taskId)),
  delete: (taskId) =>
    guard("task_error", async () => {
      const task = await tasksStore.get(taskId);
      if (!task) return "not_found";
      // Sessions go first, so a failure leaves the task in place to retry.
      for (const { id } of await sessionsStore.list(taskId)) await sessionsStore.delete(taskId, id);
      await tasksStore.delete(taskId);
      // A failure here is only logged, since the task is already gone.
      await documentsStore
        ?.release((task.documents ?? []).map((document) => document.documentId))
        .catch((err) => console.error(err));
      return "deleted";
    }),
});
