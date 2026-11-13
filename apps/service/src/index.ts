import { createListAgents } from "@stage/agents/agent-registry";
import { Firestore } from "@google-cloud/firestore";
import { PubSub } from "@google-cloud/pubsub";
import { z } from "zod";

import { createApp } from "./app";
import { createJobsClient } from "./cloud-run";
import { createExtractDocument, createTaskDocuments } from "./documents";
import { createListJobs, createRegisterJob, createTaskJob } from "./jobs";
import { createLiveEvents } from "./live-events";
import { platformEventsFromEnv } from "./platform-events";
import { createTaskSessions } from "./sessions";
import { createCreateTask, createDeleteTask, createListTasks, createGetTask } from "./tasks";

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
const runJob = published(platform?.runJob, createTaskJob(client, config));
const registerJob = published(platform?.registerJob, createRegisterJob(client, config));
const listJobs = createListJobs(client, config);

const db = new Firestore();
const taskDocuments = process.env.EXTRACT_URL
  ? createTaskDocuments(db, createExtractDocument(process.env.EXTRACT_URL))
  : undefined;
const app = createApp(
  runJob,
  listJobs,
  published(platform?.createTask, createCreateTask(db)),
  createListTasks(db),
  createGetTask(db),
  createTaskSessions(db),
  process.env.PUBSUB_TOPIC ? createLiveEvents(new PubSub(), process.env.PUBSUB_TOPIC) : undefined,
  { register: registerJob, list: createListAgents(db) },
  published(platform?.deleteTask, createDeleteTask(db)),
  taskDocuments && published(platform?.documents, taskDocuments),
);

export default {
  port: Number(process.env.PORT ?? 3000),
  development: process.env.NODE_ENV !== "production",
  fetch: app.fetch,
};
