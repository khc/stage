import type { JobsClient, protos } from "@google-cloud/run";

// Resuming passes only the session id; the message is queued in Firestore.
export type RunJob = (job: string, taskId: string, sessionId?: string) => Promise<string>;
export type RegisterJob = (job: string) => Promise<string>;
export type ListJobs = () => Promise<protos.google.cloud.run.v2.IJob[]>;

export const createListJobs =
  (
    client: Pick<JobsClient, "listJobs" | "locationPath">,
    { project, location }: { project: string; location: string },
  ): ListJobs =>
  async () => {
    const [jobs] = await client.listJobs({
      parent: client.locationPath(project, location),
    });
    return jobs;
  };

type JobsApi = Pick<JobsClient, "runJob" | "jobPath">;
type Config = { project: string; location: string };
type Env = { name: string; value: string }[];

const execute = async (
  client: JobsApi,
  { project, location }: Config,
  job: string,
  override: { env: Env; args?: string[] },
) => {
  const [operation] = await client.runJob({
    name: client.jobPath(project, location, job),
    overrides: { containerOverrides: [override] },
  });
  return operation.name ?? "";
};

export const createTaskJob =
  (client: JobsApi, config: Config): RunJob =>
  async (job, taskId, sessionId) => {
    const env = [{ name: "TASK_ID", value: taskId }];
    if (sessionId) env.push({ name: "SESSION_ID", value: sessionId });
    return execute(client, config, job, { env });
  };

// Runs the job image in its `register` mode, which records its agents.
export const createRegisterJob =
  (client: JobsApi, config: Config): RegisterJob =>
  (job) =>
    execute(client, config, job, {
      args: ["register"],
      env: [{ name: "JOB_NAME", value: job }],
    });
