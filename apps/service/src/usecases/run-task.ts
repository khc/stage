import { MessageQueuedError, RunInProgressError } from "@stage/agents/session-service";
import type { z } from "zod";

import { DependencyError, guard } from "../errors";
import type { CloudRunJobs } from "../platform/cloud-run-jobs";
import { jobNameSchema, resumeSchema } from "../schemas";
import type { SessionStore } from "../stores/session-store";
import type { TaskStore } from "../stores/task-store";

export type RunTaskDeps = {
  tasks: Pick<TaskStore, "get">;
  jobs: Pick<CloudRunJobs, "run">;
  sessions: SessionStore;
};

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

// Starts a new session of a task, or resumes one when the body names a sessionId.
// Dependency failures throw a DependencyError; everything expected is a status.
export const runTask = async (
  { tasks, jobs, sessions }: RunTaskDeps,
  taskId: string,
  body?: Record<string, unknown>,
): Promise<RunTaskResult> => {
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
};
