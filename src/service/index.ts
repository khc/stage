import { Firestore } from "@google-cloud/firestore";
import { z } from "zod";
import { runAgent } from "../agent";
import { createApp } from "./app";
import { createJobsClient } from "./cloud-run";
import { createListJobs, createRunJob } from "./jobs";
import { createCreateRun, createListRuns, createGetRun } from "./runs";

const env = z
  .object({ GCP_PROJECT: z.string().min(1), GCP_REGION: z.string().min(1) })
  .parse(process.env);

const client = createJobsClient(process.env);
const config = {
  project: env.GCP_PROJECT,
  location: env.GCP_REGION,
};
const runJob = createRunJob(client, config);
const listJobs = createListJobs(client, config);

const db = new Firestore();
const app = createApp(
  runAgent,
  runJob,
  listJobs,
  createCreateRun(db),
  createListRuns(db),
  createGetRun(db),
);

export default {
  port: Number(process.env.PORT ?? 3000),
  fetch: app.fetch,
};
