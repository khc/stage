import { expect, test } from "bun:test";

test("service server starts and serves API routes", async () => {
  const previousProject = process.env.GCP_PROJECT;
  const previousRegion = process.env.GCP_REGION;
  process.env.GCP_PROJECT ??= "test-project";
  process.env.GCP_REGION ??= "test-region";
  try {
    const { default: config } = await import("./index");
    const server = Bun.serve({ ...config, port: 0, development: false });
    try {
      expect(
        await (await fetch(new URL("/health", server.url))).json(),
      ).toEqual({ status: "ok" });
      expect((await fetch(new URL("/openapi.json", server.url))).status).toBe(
        200,
      );
    } finally {
      server.stop(true);
    }
  } finally {
    if (previousProject === undefined) delete process.env.GCP_PROJECT;
    else process.env.GCP_PROJECT = previousProject;
    if (previousRegion === undefined) delete process.env.GCP_REGION;
    else process.env.GCP_REGION = previousRegion;
  }
});
