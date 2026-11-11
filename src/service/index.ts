import { JobsClient } from "@google-cloud/run";
import { z } from "zod";
import { runAgent } from "../agent";
import { createApp } from "./app";
import { createRunJob } from "./jobs";

const env = z
  .object({ GCP_PROJECT: z.string().min(1), GCP_REGION: z.string().min(1) })
  .parse(process.env);

const runJob = createRunJob(new JobsClient(), {
  project: env.GCP_PROJECT,
  location: env.GCP_REGION,
});

const app = createApp(runAgent, runJob);

export default {
  port: Number(process.env.PORT ?? 3000),
  fetch: app.fetch,
};
