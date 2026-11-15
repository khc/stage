import { expect, mock, test } from "bun:test";

import { createCloudRunJobs } from "./cloud-run-jobs";

const config = { project: "p", location: "l" };
const jobPath = (project: string, location: string, job: string) =>
  `projects/${project}/locations/${location}/jobs/${job}`;

test("runs the job by its full resource name and returns the operation name", async () => {
  const runJob = mock(async (_request: unknown) => [{ name: "operations/op-1" }]);
  const run = createCloudRunJobs({ jobPath, runJob } as never, config).run;

  expect(await run("my-job", "9eb6f136-55d6-4cfb-8b1e-71367d7fd6a8")).toBe("operations/op-1");
  expect(runJob).toHaveBeenCalledWith({
    name: "projects/p/locations/l/jobs/my-job",
    overrides: {
      containerOverrides: [
        {
          env: [{ name: "TASK_ID", value: "9eb6f136-55d6-4cfb-8b1e-71367d7fd6a8" }],
        },
      ],
    },
  });
});

test("passes the task ID as a per-execution TASK_ID override", async () => {
  const runJob = mock(async (_request: unknown) => [{ name: "operations/op-1" }]);
  const run = createCloudRunJobs({ jobPath, runJob } as never, config).run;

  await run("my-job", "9eb6f136-55d6-4cfb-8b1e-71367d7fd6a8");

  expect(runJob).toHaveBeenCalledWith({
    name: "projects/p/locations/l/jobs/my-job",
    overrides: {
      containerOverrides: [
        {
          env: [{ name: "TASK_ID", value: "9eb6f136-55d6-4cfb-8b1e-71367d7fd6a8" }],
        },
      ],
    },
  });
});

test("propagates a runJob failure", async () => {
  const runJob = mock(async () => {
    throw new Error("boom");
  });
  const run = createCloudRunJobs({ jobPath, runJob } as never, config).run;

  await expect(run("my-job", "9eb6f136-55d6-4cfb-8b1e-71367d7fd6a8")).rejects.toThrow("boom");
});

const locationPath = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

test("lists jobs under the configured project and location", async () => {
  const jobs = [{ name: "projects/p/locations/l/jobs/my-job", labels: { team: "agent" } }];
  const listJobs = mock(async (_request: unknown) => [jobs]);
  const list = createCloudRunJobs({ locationPath, listJobs } as never, config).list;

  expect(await list()).toEqual(jobs);
  expect(listJobs).toHaveBeenCalledWith({ parent: "projects/p/locations/l" });
});

test("returns an empty list when there are no jobs", async () => {
  const listJobs = mock(async () => [[]]);
  const list = createCloudRunJobs({ locationPath, listJobs } as never, config).list;

  expect(await list()).toEqual([]);
});

test("propagates a listJobs failure", async () => {
  const listJobs = mock(async () => {
    throw new Error("list failed");
  });
  const list = createCloudRunJobs({ locationPath, listJobs } as never, config).list;

  await expect(list()).rejects.toThrow("list failed");
});

test("adds only a SESSION_ID override when resuming a session", async () => {
  const runJob = mock(async (_request: unknown) => [{ name: "operations/op-1" }]);
  const run = createCloudRunJobs({ jobPath, runJob } as never, config).run;

  await run("my-job", "task-1", "s1");

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
  const runJob = mock(async (_request: unknown) => [{ name: "operations/op-9" }]);
  const register = createCloudRunJobs({ jobPath, runJob } as never, config).registerAgents;

  expect(await register("my-job")).toBe("operations/op-9");
  expect(runJob).toHaveBeenCalledWith({
    name: "projects/p/locations/l/jobs/my-job",
    overrides: {
      containerOverrides: [{ args: ["register"], env: [{ name: "JOB_NAME", value: "my-job" }] }],
    },
  });
});
