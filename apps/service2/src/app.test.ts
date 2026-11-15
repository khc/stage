import { describe, expect, test } from "bun:test";

import { createApp } from "./app";
import type { HealthService } from "./modules/health/service";

const request = (app: ReturnType<typeof createApp>, path: string) =>
  app.handle(new Request(`http://localhost${path}`));

describe("GET /health", () => {
  test("answers ok from the health service", async () => {
    const healthService: HealthService = { check: () => ({ status: "ok" }) };
    const res = await request(createApp({ healthService }), "/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("rejects a response that breaks the schema", async () => {
    const healthService = { check: () => ({ status: "down" }) } as unknown as HealthService;
    const res = await request(createApp({ healthService }), "/health");
    expect(res.status).toBe(422);
  });
});
