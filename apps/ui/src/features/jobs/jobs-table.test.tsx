import { expect, test } from "bun:test";

import type { Job } from "@/lib/api";
import { renderWithApp } from "@/test-utils";

import { JobsTable } from "./jobs-table";

const job = (name: string) => ({ name: `projects/p/locations/us-central1/jobs/${name}` }) as Job;

test("the jobs table has a row per job and a footer with the count and refresh rate", async () => {
  const html = await renderWithApp(<JobsTable />, [
    [["jobs"], { jobs: [job("alpha-agents"), job("beta-agents")] }],
    [["tasks"], { tasks: [{ taskId: "t", name: "n", prompt: "p", jobName: "alpha-agents" }] }],
  ]);
  expect(html).toContain("alpha-agents");
  expect(html).toContain("beta-agents");
  expect(html).toContain("us-central1");
  expect(html).toContain("2 of 2 jobs shown");
  expect(html).toContain("Refreshes every 15 seconds");
});
