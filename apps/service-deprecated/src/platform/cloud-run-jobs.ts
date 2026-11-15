import type { JobsClient, protos } from "@google-cloud/run";

type JobsApi = Pick<JobsClient, "listJobs" | "locationPath" | "runJob" | "jobPath">;
type Config = { project: string; location: string };
type Env = { name: string; value: string }[];

// The Cloud Run Jobs of the configured project and region.
export type CloudRunJobs = {
  list: () => Promise<protos.google.cloud.run.v2.IJob[]>;
  // Starts one execution. Resuming passes only the session id; the message is queued in Firestore.
  run: (job: string, taskId: string, sessionId?: string) => Promise<string>;
  // Runs the job image in its `register` mode, which records its agents.
  registerAgents: (job: string) => Promise<string>;
};

export const createCloudRunJobs = (client: JobsApi, config: Config): CloudRunJobs => {
  const { project, location } = config;
  const execute = async (job: string, override: { env: Env; args?: string[] }) => {
    const [operation] = await client.runJob({
      name: client.jobPath(project, location, job),
      overrides: { containerOverrides: [override] },
    });
    return operation.name ?? "";
  };
  return {
    async list() {
      const [jobs] = await client.listJobs({ parent: client.locationPath(project, location) });
      return jobs;
    },
    run(job, taskId, sessionId) {
      const env = [{ name: "TASK_ID", value: taskId }];
      if (sessionId) env.push({ name: "SESSION_ID", value: sessionId });
      return execute(job, { env });
    },
    registerAgents(job) {
      return execute(job, { args: ["register"], env: [{ name: "JOB_NAME", value: job }] });
    },
  };
};
