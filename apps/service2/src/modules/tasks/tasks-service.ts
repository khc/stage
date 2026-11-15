import type { AgentRegistry } from "@stage/agents/agent-registry";

import { guard } from "../../errors";
import type { NewTask, TaskContract, TasksStore } from "./tasks-store";

export type TasksServiceDeps = {
  tasksStore: TasksStore;
  agentRegistry: Pick<AgentRegistry, "list">;
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
};

export const createTasksService = ({
  tasksStore,
  agentRegistry,
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
});
