import { Firestore } from "@google-cloud/firestore";
import { PubSub } from "@google-cloud/pubsub";
import { z } from "zod";
import { createApp } from "./app";
import { createTaskSessions } from "./sessions";
import { createLiveEvents } from "./live-events";
import { createJobsClient } from "./cloud-run";
import { createListJobs, createRegisterJob, createTaskJob } from "./jobs";
import { createListAgents } from "@agent-jobs/agents/agent-registry";
import {
  createCreateTask,
  createDeleteTask,
  createListTasks,
  createGetTask,
} from "./tasks";

const env = z
  .object({ GCP_PROJECT: z.string().min(1), GCP_REGION: z.string().min(1) })
  .parse(process.env);

const client = createJobsClient(process.env);
const config = {
  project: env.GCP_PROJECT,
  location: env.GCP_REGION,
};
const runJob = createTaskJob(client, config);
const registerJob = createRegisterJob(client, config);
const listJobs = createListJobs(client, config);

const db = new Firestore();
const app = createApp(
  runJob,
  listJobs,
  createCreateTask(db),
  createListTasks(db),
  createGetTask(db),
  createTaskSessions(db),
  process.env.PUBSUB_TOPIC
    ? createLiveEvents(new PubSub(), process.env.PUBSUB_TOPIC)
    : undefined,
  { register: registerJob, list: createListAgents(db) },
  createDeleteTask(db),
);

export default {
  port: Number(process.env.PORT ?? 3000),
  development: process.env.NODE_ENV !== "production",
  fetch: app.fetch,
};
