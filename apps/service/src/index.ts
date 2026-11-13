import { Firestore } from "@google-cloud/firestore";
import { PubSub } from "@google-cloud/pubsub";
import { createAgentRegistry } from "@stage/agents/agent-registry";
import { z } from "zod";

import { createApp } from "./app";
import { createJobsClient } from "./platform/cloud-run";
import { createCloudRunJobs } from "./platform/cloud-run-jobs";
import { createLiveEvents } from "./platform/live-events";
import { platformEventsFromEnv } from "./platform/platform-events";
import { createPlatformStream } from "./platform/platform-stream";
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
  liveEvents: process.env.PUBSUB_TOPIC
    ? createLiveEvents(new PubSub(), process.env.PUBSUB_TOPIC)
    : undefined,
  platformStream: process.env.PLATFORM_EVENTS_TOPIC
    ? createPlatformStream(new PubSub(), process.env.PLATFORM_EVENTS_TOPIC)
    : undefined,
});

export default {
  port: Number(process.env.PORT ?? 3000),
  development: process.env.NODE_ENV !== "production",
  fetch: app.fetch,
};
