import { Firestore } from "@google-cloud/firestore";
import { PubSub } from "@google-cloud/pubsub";
import { createAgentRegistry } from "@stage/agents/agent-registry";
import { z } from "zod";

import { createApp } from "./app";
import { createCloudRunJobs } from "./platform/cloud-run-jobs";
import { createJobsClient } from "./platform/cloud-run-jobs-client";
import { platformEventsFromEnv } from "./platform/platform-event-publisher";
import { createPlatformEventStream } from "./platform/platform-event-stream";
import { createSessionEventStream } from "./platform/session-event-stream";
import { createExtractDocument, createDocumentStore } from "./stores/document-store";
import { createSessionStore } from "./stores/session-store";
import { createTaskStore } from "./stores/task-store";

const env = z
  .object({ GCP_PROJECT: z.string().min(1), GCP_REGION: z.string().min(1) })
  .parse(process.env);

const client = createJobsClient(process.env);
const config = {
  project: env.GCP_PROJECT,
  location: env.GCP_REGION,
};
const platform = platformEventsFromEnv(process.env);
const published = <T>(wrap: ((fn: T) => T) | undefined, fn: T) => (wrap ? wrap(fn) : fn);

const db = new Firestore();
const taskDocuments = process.env.EXTRACT_URL
  ? createDocumentStore(db, createExtractDocument(process.env.EXTRACT_URL))
  : undefined;
const app = createApp({
  jobs: published(platform?.jobs, createCloudRunJobs(client, config)),
  tasks: published(platform?.tasks, createTaskStore(db)),
  sessions: createSessionStore(db),
  documents: taskDocuments && published(platform?.documents, taskDocuments),
  registry: createAgentRegistry(db),
  sessionEventStream: process.env.PUBSUB_TOPIC
    ? createSessionEventStream(new PubSub(), process.env.PUBSUB_TOPIC)
    : undefined,
  platformEventStream: process.env.PLATFORM_EVENTS_TOPIC
    ? createPlatformEventStream(new PubSub(), process.env.PLATFORM_EVENTS_TOPIC)
    : undefined,
});

export default {
  port: Number(process.env.PORT ?? 3000),
  development: process.env.NODE_ENV !== "production",
  fetch: app.fetch,
};
