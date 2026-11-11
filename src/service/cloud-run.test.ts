import { expect, test } from "bun:test";
import { createJobsClient } from "./cloud-run";
import { createRunJob } from "./jobs";

test("with CLOUD_RUN_EMULATOR_HOST, runs a job over plain REST without credentials", async () => {
  const requests: { method: string; path: string; authorization: string | null }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      requests.push({
        method: req.method,
        path: new URL(req.url).pathname,
        authorization: req.headers.get("authorization"),
      });
      return Response.json({ name: "projects/p/locations/l/operations/op-1" });
    },
  });

  try {
    const client = createJobsClient({
      CLOUD_RUN_EMULATOR_HOST: `localhost:${server.port}`,
    });
    const run = createRunJob(client, { project: "p", location: "l" });

    expect(await run("my-job")).toBe("projects/p/locations/l/operations/op-1");
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/v2/projects/p/locations/l/jobs/my-job:run",
        authorization: null,
      },
    ]);
  } finally {
    server.stop(true);
  }
});

test("sends the AGENT_MESSAGE override in the REST request body", async () => {
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
    await createRunJob(client, { project: "p", location: "l" })("my-job", "hi there");

    expect(bodies).toEqual([
      {
        overrides: {
          containerOverrides: [{ env: [{ name: "AGENT_MESSAGE", value: "hi there" }] }],
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
