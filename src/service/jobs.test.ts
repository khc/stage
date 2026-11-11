import { expect, mock, test } from "bun:test";
import { createListJobs, createRunJob } from "./jobs";

const config = { project: "p", location: "l" };
const jobPath = (project: string, location: string, job: string) =>
  `projects/${project}/locations/${location}/jobs/${job}`;

test("runs the job by its full resource name and returns the operation name", async () => {
  const runJob = mock(async (_request: unknown) => [
    { name: "operations/op-1" },
  ]);
  const run = createRunJob({ jobPath, runJob } as never, config);

  expect(await run("my-job")).toBe("operations/op-1");
  expect(runJob).toHaveBeenCalledWith({
    name: "projects/p/locations/l/jobs/my-job",
  });
});

test("passes the message as a per-execution AGENT_MESSAGE override", async () => {
  const runJob = mock(async (_request: unknown) => [
    { name: "operations/op-1" },
  ]);
  const run = createRunJob({ jobPath, runJob } as never, config);

  await run("my-job", "hi there");

  expect(runJob).toHaveBeenCalledWith({
    name: "projects/p/locations/l/jobs/my-job",
    overrides: {
      containerOverrides: [
        { env: [{ name: "AGENT_MESSAGE", value: "hi there" }] },
      ],
    },
  });
});

test("propagates a runJob failure", async () => {
  const runJob = mock(async () => {
    throw new Error("boom");
  });
  const run = createRunJob({ jobPath, runJob } as never, config);

  await expect(run("my-job")).rejects.toThrow("boom");
});

const locationPath = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

test("lists jobs under the configured project and location", async () => {
  const jobs = [
    { name: "projects/p/locations/l/jobs/my-job", labels: { team: "agent" } },
  ];
  const listJobs = mock(async (_request: unknown) => [jobs]);
  const list = createListJobs({ locationPath, listJobs } as never, config);

  expect(await list()).toEqual(jobs);
  expect(listJobs).toHaveBeenCalledWith({ parent: "projects/p/locations/l" });
});

test("returns an empty list when there are no jobs", async () => {
  const listJobs = mock(async () => [[]]);
  const list = createListJobs({ locationPath, listJobs } as never, config);

  expect(await list()).toEqual([]);
});

test("propagates a listJobs failure", async () => {
  const listJobs = mock(async () => {
    throw new Error("list failed");
  });
  const list = createListJobs({ locationPath, listJobs } as never, config);

  await expect(list()).rejects.toThrow("list failed");
});
