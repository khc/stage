import { PubSub, type Topic } from "@google-cloud/pubsub";

import type { DocumentStore } from "../stores/document-store";
import type { TaskStore } from "../stores/task-store";
import type { CloudRunJobs } from "./cloud-run-jobs";

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
    tasks: (store: TaskStore): TaskStore => ({
      ...store,
      async create(input) {
        const task = await store.create(input);
        void emit("task.created", {
          taskId: task.taskId,
          jobName: task.jobName,
          agentName: task.agentName,
        });
        return task;
      },
      async delete(taskId) {
        const deleted = await store.delete(taskId);
        if (deleted) void emit("task.deleted", { taskId });
        return deleted;
      },
    }),
    jobs: (jobs: CloudRunJobs): CloudRunJobs => ({
      ...jobs,
      async run(jobName, taskId, sessionId) {
        const operation = await jobs.run(jobName, taskId, sessionId);
        void emit("task.run_requested", { taskId, jobName, sessionId });
        return operation;
      },
      async registerAgents(jobName) {
        const operation = await jobs.registerAgents(jobName);
        void emit("job.registration_requested", { jobName });
        return operation;
      },
    }),
    documents: (docs: DocumentStore): DocumentStore => ({
      ...docs,
      async create(taskId, file) {
        const document = await docs.create(taskId, file);
        void emit("document.added", { taskId, documentId: document.documentId });
        return document;
      },
      async delete(taskId, documentId) {
        const removed = await docs.delete(taskId, documentId);
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
