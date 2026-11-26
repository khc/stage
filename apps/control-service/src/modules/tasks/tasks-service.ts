import type { AgentRegistry } from "@stage/agents/agent-registry";
import { isSelectableModel, type ModelRef } from "@stage/agents/model-ref";
import type { RunMode } from "@stage/agents/run-mode";
import {
  MessageQueuedError,
  RunInProgressError,
  toSessionName,
} from "@stage/agents/session-service";

import { DependencyError, guard } from "../../errors";
import {
  QuickTimeoutError,
  RunFailedError,
  type AgentServices,
} from "../../platform/agent-services-client";
import type { CloudRunJobs } from "../../platform/cloud-run-jobs-client";
import { isJobName } from "../agents/agents-model";
import type { ProvidersStore } from "../providers/providers-store";
import type { DocumentsStore } from "./documents/documents-store";
import type { SessionsStore } from "./sessions/sessions-store";
import type { NewTask, TaskContract, TasksStore } from "./tasks-store";

export type TasksServiceDeps = {
  tasksStore: TasksStore;
  agentRegistry: Pick<AgentRegistry, "list">;
  providersStore: Pick<ProvidersStore, "get">;
  cloudRunJobs: Pick<CloudRunJobs, "run">;
  // The quick services of the jobs that have one; without it, every quick run is unavailable.
  agentServices?: Pick<AgentServices, "has" | "run">;
  sessionsStore: SessionsStore;
  documentsStore?: Pick<DocumentsStore, "release">;
  // The jobs a task may use; undefined allows any valid job name.
  allowedJobs?: ReadonlySet<string>;
};

export type CreateTaskResult =
  | { status: "created"; task: Awaited<ReturnType<TasksStore["create"]>> }
  | { status: "unknown_agent" | "unknown_job" | "unknown_model" };

export type RunTaskResult =
  | { status: "started"; operation: string; sessionId?: string }
  // The quick run's budget ran out; it has started and may still finish, so its session stays.
  | { status: "quick_timeout"; sessionId?: string }
  | {
      status:
        | "quick_unavailable"
        | "too_many_quick_runs"
        | "task_not_found"
        | "task_not_executable"
        | "session_not_found"
        | "run_in_progress"
        | "message_pending"
        | "unknown_model";
    };

// A task with more sub-tasks than this is not deleted in one request.
export const MAX_SUBTASKS = 500;
// Quick service runs waited for synchronously at once across /tasks/:id/run with `mode: "quick"`.
export const MAX_QUICK_IN_FLIGHT = 8;

// Runs a cleanup step that must not change the outcome: a failure is logged and swallowed.
const attempt = async (what: string, step: () => Promise<unknown>): Promise<void> => {
  try {
    await step();
  } catch (err) {
    console.error(what, err);
  }
};

export type TasksServiceConfig = {
  maxQuickInFlight?: number;
};

export type Resume = { sessionId?: string; message: string; model?: ModelRef };

export type RunOptions = {
  // Stops a quick run that is waited for when aborted.
  signal?: AbortSignal;
  // A quick run returns as soon as the session exists, and the service finishes it on its own; the
  // caller follows it on the session's event stream. Without it the call returns when the run has finished.
  background?: boolean;
};

// Every expected outcome is a status; a failing dependency throws a DependencyError.
export type TasksService = {
  // A job outside `allowedJobs` is refused. A job with registered agents only accepts those; a job without a
  // registration cannot be verified and keeps accepting any valid name.
  create: (input: NewTask) => Promise<CreateTaskResult>;
  list: () => Promise<TaskContract[]>;
  get: (taskId: string) => Promise<TaskContract | undefined>;
  // Starts a new session of the task, or resumes one: the message is queued on the
  // session in Firestore and the job gets only the session id. In `workflow` mode (the default)
  // the run is a Cloud Run job started in the background; in `quick` mode it runs on the job's
  // service and the call returns when it has finished, or at once with `background`.
  run: (
    taskId: string,
    resume?: Resume,
    mode?: RunMode,
    options?: RunOptions,
  ) => Promise<RunTaskResult>;
  // Deletes the task with its sessions, then releases the documents nobody else uses.
  delete: (taskId: string) => Promise<"deleted" | "not_found" | "too_many_subtasks">;
};

export const createTasksService = (
  {
    tasksStore,
    agentRegistry,
    providersStore,
    cloudRunJobs,
    agentServices,
    sessionsStore,
    documentsStore,
    allowedJobs,
  }: TasksServiceDeps,
  { maxQuickInFlight = MAX_QUICK_IN_FLIGHT }: TasksServiceConfig = {},
): TasksService => {
  let quickInFlight = 0;
  // Whether a model can be used: its provider exists and offers it.
  const isUsable = async (ref: ModelRef) => {
    const provider = await providersStore.get(ref.providerId);
    return !!provider && isSelectableModel(provider, ref.model);
  };
  return {
    create: (input) =>
      guard("task_error", async (): Promise<CreateTaskResult> => {
        if (allowedJobs && !allowedJobs.has(input.jobName)) return { status: "unknown_job" };
        if (input.agentName !== undefined) {
          const known = await agentRegistry.list(input.jobName);
          if (known.length && !known.some((agent) => agent.name === input.agentName))
            return { status: "unknown_agent" };
        }
        if (input.defaultModel && !(await isUsable(input.defaultModel)))
          return { status: "unknown_model" };
        return { status: "created", task: await tasksStore.create(input) };
      }),
    list: () => guard("task_error", tasksStore.list),
    get: (taskId) => guard("task_error", () => tasksStore.get(taskId)),
    async run(taskId, resume, mode = "workflow", { signal, background = false } = {}) {
      const task = await guard("task_error", () => tasksStore.get(taskId));
      if (!task) return { status: "task_not_found" };
      if (!isJobName(task.jobName ?? "") || (allowedJobs && !allowedJobs.has(task.jobName!)))
        return { status: "task_not_executable" };
      if (mode === "quick" && !agentServices?.has(task.jobName!))
        return { status: "quick_unavailable" };
      if (resume?.model && !(await isUsable(resume.model))) return { status: "unknown_model" };

      const counted = mode === "quick";
      // A background run keeps its place among the quick runs until it ends.
      let handedOff = false;
      if (counted) {
        if (quickInFlight >= maxQuickInFlight) return { status: "too_many_quick_runs" };
        quickInFlight++;
      }

      try {
        let targetSessionId = resume?.sessionId;
        let createdSession = false;
        if (resume) {
          if (targetSessionId) {
            try {
              const existing = await sessionsStore.get(taskId, targetSessionId);
              if (!existing) return { status: "session_not_found" };
              if (existing.run?.status === "running") return { status: "run_in_progress" };
              // The message waits in Firestore, so the job gets only the session id.
              if (
                !(await sessionsStore.queueMessage(
                  taskId,
                  targetSessionId,
                  resume.message,
                  resume.model,
                ))
              )
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
                await sessionsStore.queueMessage(taskId, id, resume.message, resume.model);
              } catch (err) {
                await sessionsStore.delete(taskId, id).catch(() => {});
                throw err;
              }
              return id;
            });
            createdSession = true;
          }
        }

        const started = (): RunTaskResult => ({
          status: "started",
          operation: "service",
          ...(createdSession && { sessionId: targetSessionId }),
        });
        // The run did not finish as a plain success: a status for the expected outcomes, a throw otherwise.
        const recover = async (err: unknown): Promise<RunTaskResult> => {
          // The service has the run: it may still finish, so its session and message stay.
          if (err instanceof QuickTimeoutError)
            return {
              status: "quick_timeout",
              ...(targetSessionId && { sessionId: targetSessionId }),
            };
          // The service ran it and the run failed: its session records the failure for the caller to
          // read. A run that failed before it started recorded nothing, so that is a service failure.
          if (err instanceof RunFailedError && targetSessionId) {
            let failed = false;
            try {
              failed = (await sessionsStore.get(taskId, targetSessionId))?.run?.status === "failed";
            } catch {
              // The lookup failed: treat the run as not recorded, like a run that never started.
            }
            if (failed) return started();
          }
          if (background && targetSessionId && !(err instanceof RunInProgressError)) {
            // The caller has the session id and is already following it: let its stream show the failure.
            await attempt("Failed to record the run failure", () =>
              sessionsStore.failRun(
                taskId,
                targetSessionId,
                err instanceof Error ? err.message : String(err),
                "quick",
              ),
            );
          } else if (createdSession && targetSessionId) {
            await attempt("Failed to remove unstarted session", () =>
              sessionsStore.delete(taskId, targetSessionId),
            );
          } else if (resume?.sessionId) {
            await attempt("Failed to clear the queued message", () =>
              sessionsStore.clearMessage(taskId, resume.sessionId!),
            );
          }
          if (err instanceof RunInProgressError) return { status: "run_in_progress" };
          throw new DependencyError(mode === "quick" ? "service_error" : "job_error", err);
        };

        if (mode === "quick" && background) {
          handedOff = true;
          agentServices!
            .run(task.jobName!, taskId, targetSessionId)
            .catch(recover)
            .catch((err) => console.error("Quick run failed", err))
            .finally(() => quickInFlight--);
          return started();
        }

        try {
          const operation =
            mode === "quick"
              ? await (
                  signal
                    ? agentServices!.run(task.jobName!, taskId, targetSessionId, signal)
                    : agentServices!.run(task.jobName!, taskId, targetSessionId)
                ).then(() => "service")
              : targetSessionId
                ? await cloudRunJobs.run(task.jobName!, taskId, targetSessionId)
                : await cloudRunJobs.run(task.jobName!, taskId);
          return {
            status: "started",
            operation,
            ...(createdSession && { sessionId: targetSessionId }),
          };
        } catch (err) {
          return await recover(err);
        }
      } finally {
        if (counted && !handedOff) quickInFlight--;
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
  };
};
