import type { JobsClient, protos } from "@google-cloud/run";

export type RunJob = (job: string, message?: string) => Promise<string>;
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

export const createRunJob =
  (
    client: JobsApi,
    { project, location }: { project: string; location: string },
  ): RunJob =>
  async (job, message) => {
    const [operation] = await client.runJob({
      name: client.jobPath(project, location, job),
      ...(message !== undefined && {
        overrides: {
          containerOverrides: [
            { env: [{ name: "AGENT_MESSAGE", value: message }] },
          ],
        },
      }),
    });

    return operation.name ?? "";
  };
