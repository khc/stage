import type { JobsClient } from "@google-cloud/run";

export type RunJob = (job: string) => Promise<string>;

type JobsApi = Pick<JobsClient, "runJob" | "jobPath">;

export const createRunJob =
  (
    client: JobsApi,
    { project, location }: { project: string; location: string },
  ): RunJob =>
  async (job) => {
    const [operation] = await client.runJob({
      name: client.jobPath(project, location, job),
    });

    return operation.name ?? "";
  };
