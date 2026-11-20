import { expect, mock, test } from "bun:test";

import { AgentTool, type ReadonlyContext } from "@google/adk";

import { RemoteAgentsToolset } from "./remote-agents";

// In the order listAll returns them: by job, then name.
const registered = [
  { jobName: "generic-agents", name: "assistant" },
  { jobName: "orchestrator-agents", name: "orchestrator" },
  { jobName: "poet-agents", name: "haiku-poet", description: "Writes haiku" },
];
const setup = (env: Record<string, string | undefined> = {}) => {
  const listAll = mock(async () => registered);
  const toolset = new RemoteAgentsToolset({
    registry: () => ({ listAll }),
    env: { GATEWAY_URL: "http://gateway.test:3000/", JOB_NAME: "orchestrator-agents", ...env },
  });
  return { toolset, listAll };
};
const context = (invocationId: string) => ({ invocationId }) as ReadonlyContext;
// The RemoteA2AAgent inside a tool and the config it was built with.
const remote = (tool: unknown) =>
  (tool as { agent: { a2aConfig: { agentCard: string; resolveAgentCardOptions?: unknown } } })
    .agent;

test("offers every registered agent except those of its own job, as AgentTool wrappers", async () => {
  const tools = await setup().toolset.getTools(context("i1"));
  expect(tools.map((tool) => tool.name)).toEqual([
    "generic-agents__assistant",
    "poet-agents__haiku-poet",
  ]);
  expect(tools.every((tool) => tool instanceof AgentTool)).toBe(true);
});

test("points each agent at the gateway endpoint of its job and agent", async () => {
  const tools = await setup().toolset.getTools(context("i1"));
  expect(remote(tools[1]).a2aConfig.agentCard).toBe(
    "http://gateway.test:3000/a2a/poet-agents/haiku-poet/",
  );
});

test('accepts a plaintext http gateway only when GATEWAY_ALLOW_INSECURE is "true"', async () => {
  const strict = await setup().toolset.getTools(context("i1"));
  expect(remote(strict[0]).a2aConfig.resolveAgentCardOptions).toBeUndefined();
  const relaxed = await setup({ GATEWAY_ALLOW_INSECURE: "true" }).toolset.getTools(context("i1"));
  expect(remote(relaxed[0]).a2aConfig.resolveAgentCardOptions).toEqual({ allowInsecureRpc: true });
  const other = await setup({ GATEWAY_ALLOW_INSECURE: "yes" }).toolset.getTools(context("i1"));
  expect(remote(other[0]).a2aConfig.resolveAgentCardOptions).toBeUndefined();
});

test("reads the registry once per invocation, not once per model request", async () => {
  const { toolset, listAll } = setup();
  await toolset.getTools(context("i1"));
  await toolset.getTools(context("i1"));
  expect(listAll).toHaveBeenCalledTimes(1);
  await toolset.getTools(context("i2"));
  expect(listAll).toHaveBeenCalledTimes(2);
});

test("a failed registry read is not cached", async () => {
  let fail = true;
  const listAll = mock(async () => {
    if (fail) throw new Error("firestore down");
    return registered;
  });
  const toolset = new RemoteAgentsToolset({
    registry: () => ({ listAll }),
    env: { GATEWAY_URL: "http://gateway.test" },
  });
  await expect(toolset.getTools(context("i1"))).rejects.toThrow("firestore down");
  fail = false;
  expect(await toolset.getTools(context("i1"))).toHaveLength(3);
});

test("needs GATEWAY_URL, and says so when a run asks for the tools", async () => {
  const { toolset } = setup({ GATEWAY_URL: undefined });
  await expect(toolset.getTools(context("i1"))).rejects.toThrow("GATEWAY_URL");
});

test("tells the model to send JSON for an agent with a structured input, and skips one that takes no input", async () => {
  const haikuInput = {
    type: "object",
    properties: { topic: { type: "string" } },
    required: ["topic"],
  };
  const toolset = new RemoteAgentsToolset({
    registry: () => ({
      listAll: async () => [
        { jobName: "generic-agents", name: "assistant", inputSchema: { type: "string" } },
        {
          jobName: "generic-agents",
          name: "document_analyser",
          inputSchema: { type: "object", properties: {} },
        },
        {
          jobName: "poet-agents",
          name: "haiku",
          description: "Writes haiku",
          inputSchema: haikuInput,
        },
      ],
    }),
    env: { GATEWAY_URL: "http://gateway.test" },
  });

  const tools = await toolset.getTools(context("i1"));

  expect(tools.map((tool) => tool.name)).toEqual([
    "generic-agents__assistant",
    "poet-agents__haiku",
  ]);
  const declarations = tools.map(
    (tool) => (tool as unknown as { agent: { description: string } }).agent.description,
  );
  expect(declarations[0]).not.toContain("JSON");
  expect(declarations[1]).toContain("Writes haiku");
  expect(declarations[1]).toContain("JSON");
  expect(declarations[1]).toContain('"topic"');
});

test("skips registry entries whose names could not be part of an endpoint path", async () => {
  const toolset = new RemoteAgentsToolset({
    registry: () => ({
      listAll: async () => [
        { jobName: "poet-agents", name: "haiku" },
        { jobName: "poet-agents", name: "../../health" },
        { jobName: "Poet Agents?x=1", name: "haiku" },
      ],
    }),
    env: { GATEWAY_URL: "http://gateway.test" },
  });
  const tools = await toolset.getTools(context("i1"));
  expect(tools.map((tool) => tool.name)).toEqual(["poet-agents__haiku"]);
});
