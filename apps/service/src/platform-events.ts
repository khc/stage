import { PubSub, type Topic } from "@google-cloud/pubsub";

import type { TaskDocuments } from "./documents";
import type { RegisterJob, RunJob } from "./jobs";
import type { CreateTask, DeleteTask } from "./tasks";

export type PlatformEventType =
  | "task.created"
  | "task.deleted"
  | "task.run_requested"
  | "document.added"
  | "document.removed"
  | "job.registration_requested";

export type PublishPlatformEvent = (
  type: PlatformEventType,
  data: { taskId?: string } & Record<string, unknown>,
) => Promise<void>;

export const createPlatformPublisher = (
  getTopic: () => Promise<Pick<Topic, "publishMessage">>,
): PublishPlatformEvent => {
  let topic: ReturnType<typeof getTopic> | undefined;
  return async (type, data) => {
    topic ??= getTopic().catch((err) => {
      topic = undefined;
      throw err;
    });
    const eventId = crypto.randomUUID();
    await (
      await topic
    ).publishMessage({
      data: Buffer.from(JSON.stringify({ eventId, type, occurredAt: Date.now(), ...data })),
      attributes: {
        eventId,
        eventType: type,
        ...(data.taskId !== undefined && { taskId: data.taskId }),
      },
    });
  };
};

// Wraps service operations so each success publishes one event. Publishing
// is best effort and in the background: it never delays or fails the operation.
export const withPlatformEvents = (publish: PublishPlatformEvent) => {
  const emit: PublishPlatformEvent = (type, data) =>
    publish(type, data).catch((err) => console.error(`Platform event ${type} failed`, err));

  return {
    createTask:
      (create: CreateTask): CreateTask =>
      async (input) => {
        const task = await create(input);
        void emit("task.created", {
          taskId: task.taskId,
          jobName: task.jobName,
          agentName: task.agentName,
        });
        return task;
      },
    deleteTask:
      (remove: DeleteTask): DeleteTask =>
      async (taskId) => {
        await remove(taskId);
        void emit("task.deleted", { taskId });
      },
    runJob:
      (run: RunJob): RunJob =>
      async (jobName, taskId, resume) => {
        const operation = await run(jobName, taskId, resume);
        void emit("task.run_requested", { taskId, jobName, sessionId: resume?.sessionId });
        return operation;
      },
    registerJob:
      (register: RegisterJob): RegisterJob =>
      async (jobName) => {
        const operation = await register(jobName);
        void emit("job.registration_requested", { jobName });
        return operation;
      },
    documents: (docs: TaskDocuments): TaskDocuments => ({
      ...docs,
      async add(taskId, file) {
        const document = await docs.add(taskId, file);
        void emit("document.added", { taskId, documentId: document.documentId });
        return document;
      },
      async remove(taskId, documentId) {
        const removed = await docs.remove(taskId, documentId);
        if (removed) void emit("document.removed", { taskId, documentId });
        return removed;
      },
    }),
  };
};

export const platformEventsFromEnv = (
  env: Record<string, string | undefined>,
  pubsub: Pick<PubSub, "topic"> = new PubSub(),
) => {
  const name = env.PLATFORM_EVENTS_TOPIC;
  if (!name) return undefined;
  return withPlatformEvents(
    createPlatformPublisher(async () => (await pubsub.topic(name).get({ autoCreate: true }))[0]),
  );
};
