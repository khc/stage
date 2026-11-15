import type { AgentRegistry } from "@stage/agents/agent-registry";
import { MessageQueuedError, RunInProgressError } from "@stage/agents/session-service";
import type { z } from "zod";

import { DependencyError, guard } from "../errors";
import type { CloudRunJobs } from "../platform/cloud-run-jobs";
import { jobNameSchema, resumeSchema } from "../schemas";
import type { DocumentStore } from "../stores/document-store";
import type { SessionStore } from "../stores/session-store";
import type { NewTask, TaskStore } from "../stores/task-store";

export type TaskServiceDeps = {
  tasks: TaskStore;
  jobs: Pick<CloudRunJobs, "run">;
  sessions: SessionStore;
  registry: Pick<AgentRegistry, "list">;
  documents?: DocumentStore;
};

export type CreateTaskResult =
  | { status: "created"; task: Awaited<ReturnType<TaskStore["create"]>> }
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
    }
  | { status: "invalid_resume"; error: z.ZodError };

// What can be done with a task beyond reading it. Every expected outcome is a
// status; a failing dependency throws a DependencyError.
export type TaskService = {
  // A job with registered agents only accepts those; a job without a
  // registration cannot be verified and keeps accepting any valid name.
  create: (input: NewTask) => Promise<CreateTaskResult>;
  // Starts a new session of the task, or resumes one when the body names a sessionId.
  run: (taskId: string, body?: Record<string, unknown>) => Promise<RunTaskResult>;
  // Deletes the task with its sessions, then releases the documents nobody else uses.
  delete: (taskId: string) => Promise<"deleted" | "not_found">;
};

export const createTaskService = ({
  tasks,
  jobs,
  sessions,
  registry,
  documents,
}: TaskServiceDeps): TaskService => ({
  create: (input) =>
    guard("task_error", async (): Promise<CreateTaskResult> => {
      if (input.agentName !== undefined) {
        const known = await registry.list(input.jobName);
        if (known.length && !known.some((a) => a.name === input.agentName))
          return { status: "unknown_agent" };
      }
      return { status: "created", task: await tasks.create(input) };
    }),

  async run(taskId, body) {
    const contract = await guard("task_error", () => tasks.get(taskId));
    if (!contract) return { status: "task_not_found" };
    const jobName = jobNameSchema.safeParse(contract.jobName);
    if (!jobName.success) return { status: "task_not_executable" };

    let resume: { sessionId: string; message: string } | undefined;
    if (body?.sessionId !== undefined) {
      const parsed = resumeSchema.safeParse(body);
      if (!parsed.success) return { status: "invalid_resume", error: parsed.error };
      resume = parsed.data;
      try {
        const existing = await sessions.get(taskId, resume.sessionId);
        if (!existing) return { status: "session_not_found" };
        if (existing.run?.status === "running") return { status: "run_in_progress" };
        // The message waits in Firestore, so the job gets only the session id.
        if (!(await sessions.queueMessage(taskId, resume.sessionId, resume.message)))
          return { status: "session_not_found" };
      } catch (err) {
        if (err instanceof RunInProgressError) return { status: "run_in_progress" };
        if (err instanceof MessageQueuedError) return { status: "message_pending" };
        throw new DependencyError("session_error", err);
      }
    }

    try {
      const operation = resume
        ? await jobs.run(jobName.data, taskId, resume.sessionId)
        : await jobs.run(jobName.data, taskId);
      return { status: "started", operation };
    } catch (err) {
      if (resume)
        await sessions
          .clearMessage(taskId, resume.sessionId)
          .catch((clearErr) => console.error("Failed to clear the queued message", clearErr));
      throw new DependencyError("job_error", err);
    }
  },

  delete: (taskId) =>
    guard("task_error", async () => {
      const task = await tasks.get(taskId);
      if (!task) return "not_found";
      // Sessions go first, so a failure leaves the task in place to retry.
      for (const { id } of await sessions.list(taskId)) await sessions.delete(taskId, id);
      await tasks.delete(taskId);
      // A failure here is only logged, since the task is already gone.
      await documents
        ?.release((task.documents ?? []).map((d) => d.documentId))
        .catch((err) => console.error(err));
      return "deleted";
    }),
});
