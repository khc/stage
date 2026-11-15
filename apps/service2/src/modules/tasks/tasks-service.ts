import type { AgentRegistry } from "@stage/agents/agent-registry";
import { MessageQueuedError, RunInProgressError } from "@stage/agents/session-service";

import { DependencyError, guard } from "../../errors";
import type { CloudRunJobs } from "../../platform/cloud-run-jobs-client";
import type { DocumentsStore } from "./documents/documents-store";
import type { SessionsStore } from "./sessions/sessions-store";
import { isJobName } from "./tasks-model";
import type { NewTask, TaskContract, TasksStore } from "./tasks-store";

export type TasksServiceDeps = {
  tasksStore: TasksStore;
  agentRegistry: Pick<AgentRegistry, "list">;
  cloudRunJobs: Pick<CloudRunJobs, "run">;
  sessionsStore: SessionsStore;
  documentsStore?: Pick<DocumentsStore, "release">;
};

export type CreateTaskResult =
  | { status: "created"; task: Awaited<ReturnType<TasksStore["create"]>> }
  | { status: "unknown_agent" };

export type RunTaskResult =
  | { status: "started"; operation: string }
  | {
      status:
        | "task_not_found"
        | "task_not_executable"
        | "session_not_found"
        | "run_in_progress"
        | "message_pending";
    };

export type Resume = { sessionId: string; message: string };

// Every expected outcome is a status; a failing dependency throws a DependencyError.
export type TasksService = {
  // A job with registered agents only accepts those; a job without a
  // registration cannot be verified and keeps accepting any valid name.
  create: (input: NewTask) => Promise<CreateTaskResult>;
  list: () => Promise<TaskContract[]>;
  get: (taskId: string) => Promise<TaskContract | undefined>;
  // Starts a new session of the task, or resumes one: the message is queued on the
  // session in Firestore and the job gets only the session id.
  run: (taskId: string, resume?: Resume) => Promise<RunTaskResult>;
  // Deletes the task with its sessions, then releases the documents nobody else uses.
  delete: (taskId: string) => Promise<"deleted" | "not_found">;
};

export const createTasksService = ({
  tasksStore,
  agentRegistry,
  cloudRunJobs,
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
  async run(taskId, resume) {
    const task = await guard("task_error", () => tasksStore.get(taskId));
    if (!task) return { status: "task_not_found" };
    if (!isJobName(task.jobName ?? "")) return { status: "task_not_executable" };

    if (resume) {
      try {
        const existing = await sessionsStore.get(taskId, resume.sessionId);
        if (!existing) return { status: "session_not_found" };
        if (existing.run?.status === "running") return { status: "run_in_progress" };
        // The message waits in Firestore, so the job gets only the session id.
        if (!(await sessionsStore.queueMessage(taskId, resume.sessionId, resume.message)))
          return { status: "session_not_found" };
      } catch (err) {
        if (err instanceof RunInProgressError) return { status: "run_in_progress" };
        if (err instanceof MessageQueuedError) return { status: "message_pending" };
        throw new DependencyError("session_error", err);
      }
    }

    try {
      const operation = resume
        ? await cloudRunJobs.run(task.jobName!, taskId, resume.sessionId)
        : await cloudRunJobs.run(task.jobName!, taskId);
      return { status: "started", operation };
    } catch (err) {
      if (resume)
        await sessionsStore
          .clearMessage(taskId, resume.sessionId)
          .catch((clearErr) => console.error("Failed to clear the queued message", clearErr));
      throw new DependencyError("job_error", err);
    }
  },

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
