import type { AgentRegistry } from "@stage/agents/agent-registry";
import {
  MessageQueuedError,
  RunInProgressError,
  toSessionName,
} from "@stage/agents/session-service";

import { DependencyError, guard } from "../../errors";
import type { CloudRunJobs } from "../../platform/cloud-run-jobs-client";
import { isJobName } from "../agents/agents-model";
import type { DocumentsStore } from "./documents/documents-store";
import type { SessionsStore } from "./sessions/sessions-store";
import type { NewTask, TaskContract, TasksStore } from "./tasks-store";

export type TasksServiceDeps = {
  tasksStore: TasksStore;
  agentRegistry: Pick<AgentRegistry, "list">;
  cloudRunJobs: Pick<CloudRunJobs, "run">;
  sessionsStore: SessionsStore;
  documentsStore?: Pick<DocumentsStore, "release">;
  // The jobs a task may use; undefined allows any valid job name.
  allowedJobs?: ReadonlySet<string>;
};

export type CreateTaskResult =
  | { status: "created"; task: Awaited<ReturnType<TasksStore["create"]>> }
  | { status: "unknown_agent" | "unknown_job" };

export type RunTaskResult =
  | { status: "started"; operation: string; sessionId?: string }
  | {
      status:
        | "task_not_found"
        | "task_not_executable"
        | "session_not_found"
        | "run_in_progress"
        | "message_pending";
    };

// A task with more sub-tasks than this is not deleted in one request.
export const MAX_SUBTASKS = 500;

export type Resume = { sessionId?: string; message: string };

// Every expected outcome is a status; a failing dependency throws a DependencyError.
export type TasksService = {
  // A job outside `allowedJobs` is refused. A job with registered agents only accepts those; a job without a
  // registration cannot be verified and keeps accepting any valid name.
  create: (input: NewTask) => Promise<CreateTaskResult>;
  list: () => Promise<TaskContract[]>;
  get: (taskId: string) => Promise<TaskContract | undefined>;
  // Starts a new session of the task, or resumes one: the message is queued on the
  // session in Firestore and the job gets only the session id.
  run: (taskId: string, resume?: Resume) => Promise<RunTaskResult>;
  // Deletes the task with its sessions, then releases the documents nobody else uses.
  delete: (taskId: string) => Promise<"deleted" | "not_found" | "too_many_subtasks">;
};

export const createTasksService = ({
  tasksStore,
  agentRegistry,
  cloudRunJobs,
  sessionsStore,
  documentsStore,
  allowedJobs,
}: TasksServiceDeps): TasksService => ({
  create: (input) =>
    guard("task_error", async (): Promise<CreateTaskResult> => {
      if (allowedJobs && !allowedJobs.has(input.jobName)) return { status: "unknown_job" };
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
    if (!isJobName(task.jobName ?? "") || (allowedJobs && !allowedJobs.has(task.jobName!)))
      return { status: "task_not_executable" };

    let targetSessionId = resume?.sessionId;
    let createdSession = false;
    if (resume) {
      if (targetSessionId) {
        try {
          const existing = await sessionsStore.get(taskId, targetSessionId);
          if (!existing) return { status: "session_not_found" };
          if (existing.run?.status === "running") return { status: "run_in_progress" };
          // The message waits in Firestore, so the job gets only the session id.
          if (!(await sessionsStore.queueMessage(taskId, targetSessionId, resume.message)))
            return { status: "session_not_found" };
        } catch (err) {
          if (err instanceof RunInProgressError) return { status: "run_in_progress" };
          if (err instanceof MessageQueuedError) return { status: "message_pending" };
          throw new DependencyError("session_error", err);
        }
      } else {
        targetSessionId = await guard("session_error", async () => {
          const id = await sessionsStore.create(taskId, toSessionName(resume.message));
          try {
            await sessionsStore.queueMessage(taskId, id, resume.message);
          } catch (err) {
            await sessionsStore.delete(taskId, id).catch(() => {});
            throw err;
          }
          return id;
        });
        createdSession = true;
      }
    }

    try {
      const operation = targetSessionId
        ? await cloudRunJobs.run(task.jobName!, taskId, targetSessionId)
        : await cloudRunJobs.run(task.jobName!, taskId);
      return {
        status: "started",
        operation,
        ...(createdSession && { sessionId: targetSessionId }),
      };
    } catch (err) {
      if (createdSession && targetSessionId) {
        await sessionsStore
          .delete(taskId, targetSessionId)
          .catch((delErr) => console.error("Failed to remove unstarted session", delErr));
      } else if (resume?.sessionId) {
        await sessionsStore
          .clearMessage(taskId, resume.sessionId)
          .catch((clearErr) => console.error("Failed to clear the queued message", clearErr));
      }
      throw new DependencyError("job_error", err);
    }
  },

  delete: (taskId) =>
    guard("task_error", async () => {
      const task = await tasksStore.get(taskId);
      if (!task) return "not_found";
      // The task and its sub-tasks, and theirs, breadth first; the seen set stops a parent loop.
      const found = [task];
      const seen = new Set([taskId]);
      for (const { taskId: id } of found)
        for (const child of await tasksStore.listChildren(id))
          if (!seen.has(child.taskId)) {
            if (found.length > MAX_SUBTASKS) return "too_many_subtasks";
            seen.add(child.taskId);
            found.push(child);
          }
      // Deepest first, so a failure leaves the task and the shallower ones in place to retry.
      for (const { taskId: id, documents } of found.toReversed()) {
        // Sessions go first, so a failure leaves the task in place to retry.
        for (const { id: sessionId } of await sessionsStore.list(id))
          await sessionsStore.delete(id, sessionId);
        await tasksStore.delete(id);
        // A failure here is only logged, since the task is already gone.
        await documentsStore
          ?.release((documents ?? []).map((document) => document.documentId))
          .catch((err) => console.error(err));
      }
      return "deleted";
    }),
});
