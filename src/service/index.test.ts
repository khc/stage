import { expect, test } from "bun:test";

test("dashboard loads at /web and /web/ with working assets and API routes", async () => {
  // Importing the server configuration does not start a server or call GCP.
  const previousProject = process.env.GCP_PROJECT;
  const previousRegion = process.env.GCP_REGION;
  process.env.GCP_PROJECT ??= "test-project";
  process.env.GCP_REGION ??= "test-region";
  try {
    const { default: config } = await import("./index");
    const server = Bun.serve({ ...config, port: 0, development: false });
    try {
      for (const path of ["/web", "/web/", "/"]) {
        const response = await fetch(new URL(path, server.url));
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/html");
        const html = await response.text();
        expect(html).toContain("Agent Jobs");
        const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
          .map((match) => match[1])
          .filter(
            (value): value is string => !!value && !value.startsWith("http"),
          );
        expect(assets.length).toBeGreaterThan(0);
        for (const asset of assets) {
          expect(
            (await fetch(new URL(asset, new URL(path, server.url)))).status,
          ).toBe(200);
        }
      }
      expect(
        await (await fetch(new URL("/health", server.url))).json(),
      ).toEqual({ status: "ok" });
    } finally {
      server.stop(true);
    }
  } finally {
    if (previousProject === undefined) delete process.env.GCP_PROJECT;
    else process.env.GCP_PROJECT = previousProject;
    if (previousRegion === undefined) delete process.env.GCP_REGION;
    else process.env.GCP_REGION = previousRegion;
  }
}, 15_000);
