import { expect, test } from "bun:test";

import { createApp } from "./app";
import { openApiDocument } from "./openapi";

const app = createApp({
  jobs: {} as never,
  registry: {} as never,
  tasks: {} as never,
  sessions: {} as never,
});

const toOpenApiPath = (path: string) => path.replace(/:(\w+)/g, "{$1}");
// The API reference describes the API; it does not describe itself.
const SELF = new Set(["/docs", "/openapi.json"]);

const registered = new Set(
  app.routes
    .filter((r) => r.method !== "ALL" && !SELF.has(r.path))
    .map((r) => `${r.method} ${toOpenApiPath(r.path)}`),
);
const documented = new Set(
  Object.entries(openApiDocument.paths as Record<string, Record<string, unknown>>).flatMap(
    ([path, operations]) =>
      Object.keys(operations)
        .filter((method) => ["get", "post", "put", "patch", "delete"].includes(method))
        .map((method) => `${method.toUpperCase()} ${path}`),
  ),
);

test("every route the app registers is in the OpenAPI document", () => {
  expect([...registered].filter((route) => !documented.has(route))).toEqual([]);
});

test("every operation in the OpenAPI document is a route the app registers", () => {
  expect([...documented].filter((route) => !registered.has(route))).toEqual([]);
});

test("the drift check sees the routes (it would pass vacuously on an empty list)", () => {
  expect(registered.size).toBeGreaterThan(15);
  expect(registered.has("GET /tasks/{taskId}/sessions/{sessionId}/messages")).toBe(true);
});
