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
      call(serviceWith({ [failing]: async () => Promise.reject(new Error("down")) })),
    );
    expect(err).toBeInstanceOf(DependencyError);
    expect((err as DependencyError).code).toBe(code);
  });
});
