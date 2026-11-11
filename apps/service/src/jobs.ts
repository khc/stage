import type { JobsClient, protos } from "@google-cloud/run";

export type Resume = { sessionId: string; message: string };
export type RunJob = (
  job: string,
  taskId: string,
  resume?: Resume,
) => Promise<string>;
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

export const createTaskJob =
  (
    client: JobsApi,
    { project, location }: { project: string; location: string },
  ): RunJob =>
  async (job, taskId, resume) => {
    const env = [{ name: "TASK_ID", value: taskId }];
    if (resume)
      env.push(
        { name: "SESSION_ID", value: resume.sessionId },
        { name: "MESSAGE", value: resume.message },
      );
    const [operation] = await client.runJob({
      name: client.jobPath(project, location, job),
      overrides: { containerOverrides: [{ env }] },
    });

    return operation.name ?? "";
  };
