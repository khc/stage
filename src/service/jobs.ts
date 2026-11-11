import type { JobsClient } from "@google-cloud/run";

export type RunJob = (job: string, message?: string) => Promise<string>;

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
          containerOverrides: [{ env: [{ name: "AGENT_MESSAGE", value: message }] }],
        },
      }),
    });

    return operation.name ?? "";
  };
