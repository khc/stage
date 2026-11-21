import { describe, expect, mock, test } from "bun:test";

import { createCloudRunJobs, createJobsClient } from "./cloud-run-jobs-client";

const config = { project: "p", location: "l" };
const jobPath = (project: string, location: string, job: string) =>
  `projects/${project}/locations/${location}/jobs/${job}`;

describe("createCloudRunJobs", () => {
  test("runs the job by its full resource name with TASK_ID, and returns the operation name", async () => {
    const runJob = mock(async (_request: unknown) => [{ name: "operations/op-1" }]);
    const jobs = createCloudRunJobs({ jobPath, runJob } as never, config);
    expect(await jobs.run("my-job", "task-1")).toBe("operations/op-1");
    expect(runJob).toHaveBeenCalledWith({
      name: "projects/p/locations/l/jobs/my-job",
      overrides: { containerOverrides: [{ env: [{ name: "TASK_ID", value: "task-1" }] }] },
    });
  });

  test("adds a SESSION_ID override when resuming a session", async () => {
    const runJob = mock(async (_request: unknown) => [{ name: "op" }]);
    await createCloudRunJobs({ jobPath, runJob } as never, config).run("my-job", "task-1", "s1");
    expect(runJob).toHaveBeenCalledWith({
      name: "projects/p/locations/l/jobs/my-job",
      overrides: {
        containerOverrides: [
          {
            env: [
              { name: "TASK_ID", value: "task-1" },
              { name: "SESSION_ID", value: "s1" },
            ],
          },
        ],
      },
    });
  });

  test("register runs the job with the register argument and its JOB_NAME", async () => {
    const runJob = mock(async (_request: unknown) => [{ name: "op" }]);
    await createCloudRunJobs({ jobPath, runJob } as never, config).registerAgents("my-job");
    expect(runJob).toHaveBeenCalledWith({
      name: "projects/p/locations/l/jobs/my-job",
      overrides: {
        containerOverrides: [{ args: ["register"], env: [{ name: "JOB_NAME", value: "my-job" }] }],
      },
    });
  });

  test("propagates a runJob failure", async () => {
    const runJob = mock(async () => Promise.reject(new Error("boom")));
    const jobs = createCloudRunJobs({ jobPath, runJob } as never, config);
    await expect(jobs.run("my-job", "task-1")).rejects.toThrow("boom");
  });

  test("lists jobs under the configured project and location", async () => {
    const listJobs = mock(async (_request: unknown) => [[{ name: "a" }]]);
    const locationPath = (project: string, location: string) =>
      `projects/${project}/locations/${location}`;
    const jobs = createCloudRunJobs({ listJobs, locationPath } as never, config);
    expect(await jobs.list()).toEqual([{ name: "a" }]);
    expect(listJobs).toHaveBeenCalledWith({ parent: "projects/p/locations/l" });
  });
});

describe("createJobsClient", () => {
  test("rejects an emulator host without a port", () => {
    expect(() => createJobsClient({ CLOUD_RUN_EMULATOR_HOST: "localhost" })).toThrow("host:port");
  });
});
