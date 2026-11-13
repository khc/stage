import { expect, test } from "bun:test";

import { createCloudRunJobs } from "./cloud-run-jobs";
import { createJobsClient } from "./cloud-run-jobs-client";

test("with CLOUD_RUN_EMULATOR_HOST, runs a job over plain REST without credentials", async () => {
  const requests: {
    method: string;
    path: string;
    authorization: string | null;
    body: unknown;
  }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      requests.push({
        method: req.method,
        path: new URL(req.url).pathname,
        authorization: req.headers.get("authorization"),
        body: await req.json(),
      });
      return Response.json({ name: "projects/p/locations/l/operations/op-1" });
    },
  });

  try {
    const client = createJobsClient({
      CLOUD_RUN_EMULATOR_HOST: `localhost:${server.port}`,
    });
    const run = createCloudRunJobs(client, { project: "p", location: "l" }).run;

    expect(await run("my-job", "9eb6f136-55d6-4cfb-8b1e-71367d7fd6a8")).toBe(
      "projects/p/locations/l/operations/op-1",
    );
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/v2/projects/p/locations/l/jobs/my-job:run",
        authorization: null,
        body: {
          overrides: {
            containerOverrides: [
              {
                env: [
                  {
                    name: "TASK_ID",
                    value: "9eb6f136-55d6-4cfb-8b1e-71367d7fd6a8",
                  },
                ],
              },
            ],
          },
        },
      },
    ]);
  } finally {
    server.stop(true);
  }
});

test("sends the TASK_ID override in the REST request body", async () => {
  const bodies: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      bodies.push(await req.json());
      return Response.json({ name: "projects/p/locations/l/operations/op-1" });
    },
  });

  try {
    const client = createJobsClient({
      CLOUD_RUN_EMULATOR_HOST: `localhost:${server.port}`,
    });
    await createCloudRunJobs(client, { project: "p", location: "l" }).run(
      "my-job",
      "9eb6f136-55d6-4cfb-8b1e-71367d7fd6a8",
    );

    expect(bodies).toEqual([
      {
        overrides: {
          containerOverrides: [
            {
              env: [
                {
                  name: "TASK_ID",
                  value: "9eb6f136-55d6-4cfb-8b1e-71367d7fd6a8",
                },
              ],
            },
          ],
        },
      },
    ]);
  } finally {
    server.stop(true);
  }
});

test("without CLOUD_RUN_EMULATOR_HOST, returns the default client", () => {
  expect(typeof createJobsClient({}).runJob).toBe("function");
});

test("rejects a CLOUD_RUN_EMULATOR_HOST without a port", () => {
  expect(() => createJobsClient({ CLOUD_RUN_EMULATOR_HOST: "floci-gcp" })).toThrow(
    "CLOUD_RUN_EMULATOR_HOST must be host:port",
  );
});

test("lists every page over plain REST without credentials", async () => {
  const requests: {
    method: string;
    path: string;
    pageToken: string | null;
    authorization: string | null;
  }[] = [];
  const first = { name: "projects/p/locations/l/jobs/first" };
  const second = { name: "projects/p/locations/l/jobs/second" };
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requests.push({
        method: req.method,
        path: url.pathname,
        pageToken: url.searchParams.get("pageToken"),
        authorization: req.headers.get("authorization"),
      });
      return Response.json(
        url.searchParams.get("pageToken") === "page-2"
          ? { jobs: [second] }
          : { jobs: [first], nextPageToken: "page-2" },
      );
    },
  });
  try {
    const client = createJobsClient({
      CLOUD_RUN_EMULATOR_HOST: `localhost:${server.port}`,
    });
    const jobs = await createCloudRunJobs(client, {
      project: "p",
      location: "l",
    }).list();
    expect(jobs.map((job) => job.name)).toEqual([first.name, second.name]);
    expect(requests).toEqual([
      {
        method: "GET",
        path: "/v2/projects/p/locations/l/jobs",
        pageToken: null,
        authorization: null,
      },
      {
        method: "GET",
        path: "/v2/projects/p/locations/l/jobs",
        pageToken: "page-2",
        authorization: null,
      },
    ]);
  } finally {
    server.stop(true);
  }
});

test("normalizes an empty REST listing response to an empty array", async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({}) });
  try {
    const client = createJobsClient({
      CLOUD_RUN_EMULATOR_HOST: `localhost:${server.port}`,
    });
    expect(await createCloudRunJobs(client, { project: "p", location: "l" }).list()).toEqual([]);
  } finally {
    server.stop(true);
  }
});

test("rejects instead of returning partial jobs when a later page fails", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      return new URL(req.url).searchParams.get("pageToken") === "page-2"
        ? Response.json(
            {
              error: {
                code: 403,
                message: "listing denied",
                status: "PERMISSION_DENIED",
              },
            },
            { status: 403 },
          )
        : Response.json({
            jobs: [{ name: "projects/p/locations/l/jobs/first" }],
            nextPageToken: "page-2",
          });
    },
  });
  try {
    const client = createJobsClient({
      CLOUD_RUN_EMULATOR_HOST: `localhost:${server.port}`,
    });
    await expect(
      createCloudRunJobs(client, { project: "p", location: "l" }).list(),
    ).rejects.toThrow("listing denied");
  } finally {
    server.stop(true);
  }
});
