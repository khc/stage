import { expect, mock, test } from "bun:test";
import { createRunJob } from "./jobs";

const config = { project: "p", location: "l" };
const jobPath = (project: string, location: string, job: string) =>
  `projects/${project}/locations/${location}/jobs/${job}`;

test("runs the job by its full resource name and returns the operation name", async () => {
  const runJob = mock(async (_request: unknown) => [{ name: "operations/op-1" }]);
  const run = createRunJob({ jobPath, runJob } as never, config);

  expect(await run("my-job")).toBe("operations/op-1");
  expect(runJob).toHaveBeenCalledWith({
    name: "projects/p/locations/l/jobs/my-job",
  });
});

test("propagates a runJob failure", async () => {
  const runJob = mock(async () => {
    throw new Error("boom");
  });
  const run = createRunJob({ jobPath, runJob } as never, config);

  await expect(run("my-job")).rejects.toThrow("boom");
});
