import { Firestore } from "@google-cloud/firestore";
import { z } from "zod";
import { runAgent } from "../agent";
import { createApp } from "./app";
import { createJobsClient } from "./cloud-run";
import { createListJobs, createTaskJob } from "./jobs";
import { createCreateTask, createListTasks, createGetTask } from "./tasks";

const env = z
  .object({ GCP_PROJECT: z.string().min(1), GCP_REGION: z.string().min(1) })
  .parse(process.env);

const client = createJobsClient(process.env);
const config = {
  project: env.GCP_PROJECT,
  location: env.GCP_REGION,
};
const runJob = createTaskJob(client, config);
const listJobs = createListJobs(client, config);

const db = new Firestore();
const app = createApp(
  runAgent,
  runJob,
  listJobs,
  createCreateTask(db),
  createListTasks(db),
  createGetTask(db),
);

export default {
  port: Number(process.env.PORT ?? 3000),
  fetch: app.fetch,
};
