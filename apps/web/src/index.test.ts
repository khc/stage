import { expect, test } from "bun:test";

import config, { createWebFetch } from "./index";

test("dashboard loads at /, /web and /web/ with working assets and proxies API requests", async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return Response.json({ status: "ok" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const server = Bun.serve({
    ...config,
    port: 0,
    development: false,
    fetch: createWebFetch(upstream.url.origin),
  });
  try {
    for (const path of ["/web", "/web/", "/"]) {
      const response = await fetch(new URL(path, server.url));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      const html = await response.text();
      expect(html).toContain("Agent Jobs");
      const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
        .map((match) => match[1])
        .filter((value): value is string => !!value && !value.startsWith("http"));
      expect(assets.length).toBeGreaterThan(0);
      for (const asset of assets) {
        expect((await fetch(new URL(asset, new URL(path, server.url)))).status).toBe(200);
      }
    }
    expect(await (await fetch(new URL("/health", server.url))).json()).toEqual({
      status: "ok",
    });
  } finally {
    server.stop(true);
    upstream.stop(true);
  }
}, 15_000);
