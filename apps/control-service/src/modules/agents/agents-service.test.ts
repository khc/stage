import { describe, expect, test } from "bun:test";

import { DependencyError } from "../../errors";
import { createAgentsService } from "./agents-service";

const serviceWith = (overrides: Record<string, unknown> = {}) =>
  createAgentsService({
    cloudRunJobs: { list: async () => [], registerAgents: async () => "op", ...overrides },
    agentRegistry: {
      list: async () => [{ name: "haiku", description: "writes haiku" }],
      ...overrides,
    },
  } as never);
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e) => e,
  );

describe("agents service", () => {
  test("builds the card of a registered agent, and none for an unknown one", async () => {
    const service = serviceWith();
    expect(await service.agentCard("poet-agents", "haiku")).toMatchObject({ name: "haiku" });
    expect(await service.agentCard("poet-agents", "ghost")).toBeUndefined();
  });

  test("registers the agents of a job and returns the operation", async () => {
    expect(await serviceWith().register("poet-agents")).toBe("op");
  });

  test("lists jobs as Cloud Run reports them, with the env names but never the env values", async () => {
    const service = serviceWith({
      list: async () => [
        {
          name: "projects/p/locations/l/jobs/poet-agents",
          terminalCondition: { state: "CONDITION_SUCCEEDED" },
          template: {
            taskCount: 1,
            template: {
              maxRetries: 0,
              containers: [
                {
                  image: "img:1",
                  env: [
                    { name: "GEMINI_API_KEY", value: "s3cret" },
                    {
                      name: "KEY_FROM_SECRET",
                      valueSource: { secretKeyRef: { secret: "s3cret" } },
                    },
                  ],
                },
              ],
            },
          },
        },
      ],
    });
    const jobs = await service.listJobs();
    expect(jobs).toMatchObject([
      {
        name: "projects/p/locations/l/jobs/poet-agents",
        terminalCondition: { state: "CONDITION_SUCCEEDED" },
        template: {
          taskCount: 1,
          template: {
            maxRetries: 0,
            containers: [
              { image: "img:1", env: [{ name: "GEMINI_API_KEY" }, { name: "KEY_FROM_SECRET" }] },
            ],
          },
        },
      },
    ]);
    expect(JSON.stringify(jobs)).not.toContain("s3cret");
  });

  test("lists only the allowed jobs", async () => {
    const service = createAgentsService({
      cloudRunJobs: {
        list: async () => [
          { name: "projects/p/locations/l/jobs/poet-agents" },
          { name: "projects/p/locations/l/jobs/migrate-db" },
        ],
      },
      agentRegistry: { list: async () => [] },
      allowedJobs: new Set(["poet-agents"]),
    } as never);
    expect((await service.listJobs()).map((job) => job.name)).toEqual([
      "projects/p/locations/l/jobs/poet-agents",
    ]);
  });

  test("marks jobs with a configured quick service", async () => {
    const service = createAgentsService({
      cloudRunJobs: {
        list: async () => [
          { name: "projects/p/locations/l/jobs/orchestrator-agents" },
          { name: "projects/p/locations/l/jobs/poet-agents" },
        ],
      },
      agentRegistry: { list: async () => [] },
      agentServices: { has: (jobName: string) => jobName === "orchestrator-agents" },
    } as never);
    expect(
      (await service.listJobs()).map((job) => ({ name: job.name, quickService: job.quickService })),
    ).toEqual([
      { name: "projects/p/locations/l/jobs/orchestrator-agents", quickService: true },
      { name: "projects/p/locations/l/jobs/poet-agents", quickService: false },
    ]);
  });

  test("does not register a job outside the allowed jobs", async () => {
    let called = false;
    const service = createAgentsService({
      cloudRunJobs: { registerAgents: async () => ((called = true), "op") },
      agentRegistry: { list: async () => [] },
      allowedJobs: new Set(["poet-agents"]),
    } as never);
    expect(await service.register("other-job")).toBeUndefined();
    expect(called).toBe(false);
    expect(await service.register("poet-agents")).toBe("op");
  });

  test.each([
    ["listJobs", "job_error", (s: ReturnType<typeof serviceWith>) => s.listJobs(), "list"],
    [
      "listAgents",
      "agents_error",
      (s: ReturnType<typeof serviceWith>) => s.listAgents("j"),
      "list",
    ],
    [
      "register",
      "job_error",
      (s: ReturnType<typeof serviceWith>) => s.register("j"),
      "registerAgents",
    ],
  ] as const)("%s failing is a %s dependency error", async (_name, code, call, failing) => {
    const err = await rejection(
      call(
        serviceWith({
          [failing]: async () => Promise.reject(new Error("down")),
        }),
      ),
    );
    expect(err).toBeInstanceOf(DependencyError);
    expect((err as DependencyError).code).toBe(code);
  });
});
