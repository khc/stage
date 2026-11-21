import { describe, expect, test } from "bun:test";

import { createApp } from "../app";

const app = createApp({
  healthService: { check: () => ({ status: "ok" }) },
  tasksService: {} as never,
  sessionsService: {} as never,
  documentsService: {} as never,
  agentsService: {} as never,
  providersService: {} as never,
  a2aService: {} as never,
  eventsService: {} as never,
});

type Operation = { tags?: string[]; summary?: string; responses?: Record<string, unknown> };
const spec = async () =>
  (await (await app.handle(new Request("http://localhost/openapi.json"))).json()) as {
    openapi: string;
    info: { title: string };
    paths: Record<string, Record<string, Operation>>;
  };

// The paths and methods the Hono service documented, which the UI and the jobs rely on, and the A2A gateway.
const documented = {
  "/health": ["get"],
  "/jobs": ["get"],
  "/jobs/{jobName}/agents": ["get"],
  "/jobs/{jobName}/agents/{agentName}/card": ["get"],
  "/jobs/{jobName}/register": ["post"],
  "/tasks": ["get", "post"],
  "/tasks/{taskId}": ["delete", "get"],
  "/tasks/{taskId}/run": ["post"],
  "/tasks/{taskId}/documents": ["get", "post"],
  "/tasks/{taskId}/documents/{documentId}": ["delete", "get"],
  "/tasks/{taskId}/sessions": ["get"],
  "/tasks/{taskId}/sessions/{sessionId}": ["delete", "get"],
  "/tasks/{taskId}/sessions/{sessionId}/stats": ["get"],
  "/tasks/{taskId}/sessions/{sessionId}/messages": ["get"],
  "/events": ["get"],
  "/providers": ["get", "post"],
  "/providers/models": ["post"],
  "/providers/{providerId}": ["delete", "get", "patch"],
  // The card route (`.../.well-known/agent-card.json`) is served but the generator leaves it out of the document.
  "/a2a/{jobName}/{agentName}": ["post"],
};

describe("OpenAPI document", () => {
  test("is served at /openapi.json and describes every route, and only those", async () => {
    const { openapi, info, paths } = await spec();
    expect(openapi).toMatch(/^3\.1\./);
    expect(info.title).toBe("Agent Jobs API");
    const actual = Object.fromEntries(
      Object.entries(paths).map(([path, operations]) => [path, Object.keys(operations).toSorted()]),
    );
    expect(actual).toEqual(
      Object.fromEntries(Object.entries(documented).map(([p, m]) => [p, m.toSorted()])),
    );
  });

  test("every operation has a tag, a summary and documented responses", async () => {
    for (const [path, operations] of Object.entries((await spec()).paths))
      for (const [method, operation] of Object.entries(operations)) {
        const where = `${method.toUpperCase()} ${path}`;
        expect({ where, tags: operation.tags?.length }).toEqual({ where, tags: 1 });
        expect({ where, summary: Boolean(operation.summary) }).toEqual({ where, summary: true });
        expect({ where, responses: Object.keys(operation.responses ?? {}).length > 0 }).toEqual({
          where,
          responses: true,
        });
      }
  });

  test("documents the error statuses of a route", async () => {
    const run = (await spec()).paths["/tasks/{taskId}/run"]!.post!;
    expect(Object.keys(run.responses!).toSorted()).toEqual(["202", "400", "404", "409", "502"]);
  });

  test("path parameters and the request body schemas come from the models", async () => {
    const { paths } = await spec();
    const create = paths["/tasks"]!.post as unknown as {
      requestBody: { content: Record<string, { schema: { required: string[] } }> };
    };
    expect(create.requestBody.content["application/json"]!.schema.required).toEqual([
      "name",
      "prompt",
      "jobName",
    ]);
    const get = paths["/tasks/{taskId}"]!.get as unknown as {
      parameters: { name: string; in: string }[];
    };
    expect(get.parameters).toMatchObject([{ name: "taskId", in: "path" }]);
  });
});

describe("Scalar reference", () => {
  test("is served at /docs as HTML", async () => {
    const res = await app.handle(new Request("http://localhost/docs"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});

describe("DELETE /tasks/{taskId}", () => {
  test("says in its summary that sub-tasks go with the task", async () => {
    const { paths } = await spec();
    expect(paths["/tasks/{taskId}"]?.delete?.summary).toContain("sub-tasks");
  });
});
