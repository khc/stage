import { expect, mock, test } from "bun:test";

import { FunctionTool, type ReadonlyContext } from "@google/adk";
import { RemoteA2AAgent, type RemoteA2AAgentConfig } from "@google/adk/a2a";

import { RemoteAgentsToolset } from "./remote-agents";

// In the order listAll returns them: by job, then name.
const registered = [
  { jobName: "generic-agents", name: "assistant" },
  { jobName: "orchestrator-agents", name: "orchestrator" },
  { jobName: "poet-agents", name: "haiku-poet", description: "Writes haiku" },
];
const setup = (env: Record<string, string | undefined> = {}) => {
  const listAll = mock(async () => registered);
  const configs: RemoteA2AAgentConfig[] = [];
  const toolset = new RemoteAgentsToolset({
    registry: () => ({ listAll }),
    env: { GATEWAY_URL: "http://gateway.test:3000/", JOB_NAME: "orchestrator-agents", ...env },
    remoteAgent: (config) => {
      configs.push(config);
      return new RemoteA2AAgent(config);
    },
  });
  return { toolset, listAll, configs };
};
const context = (invocationId: string, sessionId?: string) =>
  ({ invocationId, ...(sessionId && { sessionId }) }) as ReadonlyContext;

test("offers every registered agent except those of its own job, as function tools", async () => {
  const tools = await setup().toolset.getTools(context("i1"));
  expect(tools.map((tool) => tool.name)).toEqual([
    "generic-agents__assistant",
    "poet-agents__haiku-poet",
  ]);
  expect(tools.every((tool) => tool instanceof FunctionTool)).toBe(true);
});

test("points each agent at the gateway endpoint of its job and agent", async () => {
  const { toolset, configs } = setup();
  await toolset.getTools(context("i1"));
  expect(configs.map((config) => config.agentCard)).toEqual([
    "http://gateway.test:3000/a2a/generic-agents/assistant/",
    "http://gateway.test:3000/a2a/poet-agents/haiku-poet/",
  ]);
});

test('accepts a plaintext http gateway only when GATEWAY_ALLOW_INSECURE is "true"', async () => {
  const optionsFor = async (env: Record<string, string>) => {
    const { toolset, configs } = setup(env);
    await toolset.getTools(context("i1"));
    return configs[0]?.resolveAgentCardOptions;
  };
  expect(await optionsFor({})).toBeUndefined();
  expect(await optionsFor({ GATEWAY_ALLOW_INSECURE: "true" })).toEqual({ allowInsecureRpc: true });
  expect(await optionsFor({ GATEWAY_ALLOW_INSECURE: "yes" })).toBeUndefined();
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
  const declarations = tools.map((tool) => tool.description);
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

const taskId = "5f4c3d1e-9b0a-4d2e-8a37-1c6f2b9e7a10";

test("names the orchestrator's task and session in every request to another agent", async () => {
  const { toolset, configs } = setup({ TASK_ID: taskId });
  await toolset.getTools(context("i1", "s-1"));
  expect(configs.every((config) => config.beforeRequestCallbacks?.length === 1)).toBe(true);

  // The callback adds the reference to the outgoing A2A message and keeps what ADK put there.
  const params: { message: { metadata: Record<string, unknown> } } = {
    message: { metadata: { existing: 1 } },
  };
  await configs[0]!.beforeRequestCallbacks![0]!({} as never, params as never);
  expect(params.message.metadata).toEqual({
    existing: 1,
    "stage:parent": { taskId, sessionId: "s-1" },
  });
});

test.each([
  ["no TASK_ID", {}, "s-1"],
  ["a TASK_ID that is not a UUID", { TASK_ID: "nope" }, "s-1"],
  ["no session id", { TASK_ID: taskId }, undefined],
])("sends no parent reference with %s", async (_case, env, sessionId) => {
  const { toolset, configs } = setup(env as Record<string, string>);
  await toolset.getTools(context("i1", sessionId));
  expect(configs.every((config) => config.beforeRequestCallbacks === undefined)).toBe(true);
});

// Agents with run modes: one supports both, one only quick, one none (as before).
const withModes = (env: Record<string, string | undefined> = {}) => {
  const configs: RemoteA2AAgentConfig[] = [];
  const toolset = new RemoteAgentsToolset({
    registry: () => ({
      listAll: async () => [
        {
          jobName: "generic-agents",
          name: "assistant",
          modes: ["quick", "workflow"] as ("quick" | "workflow")[],
        },
        { jobName: "generic-agents", name: "lookup", modes: ["quick"] as ("quick" | "workflow")[] },
        { jobName: "generic-agents", name: "plain" },
      ],
    }),
    env: { GATEWAY_URL: "http://gateway.test", ...env },
    // The agent is never reached: a call fails once it has been built, which is all these tests need.
    remoteAgent: (config) => {
      configs.push(config);
      return { name: config.name, description: config.description } as RemoteA2AAgent;
    },
  });
  return { toolset, configs };
};
const toolNamed = async (toolset: RemoteAgentsToolset, name: string) =>
  (await toolset.getTools(context("i1", "s-1"))).find((tool) => tool.name === name) as FunctionTool;
// ADK has no public accessor for the declaration the model is shown.
const declarationOf = (tool: FunctionTool) => tool["_getDeclaration"]();
const call = (tool: FunctionTool, args: Record<string, unknown>) =>
  tool.runAsync({ args, toolContext: undefined as never }).catch(() => {});
const metadataOf = async (config: RemoteA2AAgentConfig) => {
  const params: { message: { metadata?: Record<string, unknown> } } = { message: {} };
  for (const callback of config.beforeRequestCallbacks ?? [])
    await callback({} as never, params as never);
  return params.message.metadata;
};

test("an agent with modes takes a mode among the ones it supports; one without keeps its schema", async () => {
  const { toolset } = withModes();
  const parameters = async (name: string) =>
    (
      declarationOf(await toolNamed(toolset, name)) as {
        parameters: { properties: Record<string, { enum?: string[] }>; required: string[] };
      }
    ).parameters;

  const both = await parameters("generic-agents__assistant");
  expect(both.properties.mode?.enum).toEqual(["quick", "workflow"]);
  expect(both.required).toEqual(["request", "mode"]);
  expect((await parameters("generic-agents__lookup")).properties.mode?.enum).toEqual(["quick"]);
  const plain = await parameters("generic-agents__plain");
  expect(plain.properties).not.toHaveProperty("mode");
  expect(plain.required).toEqual(["request"]);

  const tools = await toolset.getTools(context("i1"));
  expect(tools[0]!.description).toContain("quick, workflow");
  expect(tools[2]!.description).not.toContain("quick");
});

test("the mode parameter tells the model when to use each mode", async () => {
  const { toolset } = withModes();
  const declaration = declarationOf(await toolNamed(toolset, "generic-agents__assistant")) as {
    parameters: { properties: { mode: { description: string } } };
  };
  const described = declaration.parameters.properties.mode.description;
  expect(described).toMatch(/quick.*(lookup|single answer).*waits/is);
  expect(described).toMatch(/workflow.*(multi-step|long).*background/is);
});

test("builds one remote agent per agent and mode, on first use, and keeps it", async () => {
  const { toolset, configs } = withModes();
  const assistant = await toolNamed(toolset, "generic-agents__assistant");
  // Agents with modes are built on use; the one without is built with the tools, as before.
  expect(configs.map((config) => config.name)).toEqual(["generic-agents__plain"]);

  await call(assistant, { request: "a", mode: "quick" });
  await call(assistant, { request: "b", mode: "quick" });
  await call(assistant, { request: "c", mode: "workflow" });
  expect(configs.map((config) => config.name)).toEqual([
    "generic-agents__plain",
    "generic-agents__assistant",
    "generic-agents__assistant",
  ]);
});

test("each mode's agent sends its own mode, next to the parent reference, with no shared state", async () => {
  const { toolset, configs } = withModes({ TASK_ID: taskId });
  const assistant = await toolNamed(toolset, "generic-agents__assistant");
  await Promise.all([
    call(assistant, { request: "a", mode: "quick" }),
    call(assistant, { request: "b", mode: "workflow" }),
  ]);
  const [quick, workflow] = configs.filter((config) => config.name === "generic-agents__assistant");
  expect(await metadataOf(quick!)).toEqual({
    "stage:parent": { taskId, sessionId: "s-1" },
    "stage:mode": "quick",
  });
  expect(await metadataOf(workflow!)).toEqual({
    "stage:parent": { taskId, sessionId: "s-1" },
    "stage:mode": "workflow",
  });
});

test("without a parent, a mode is still sent, and an agent without modes sends none", async () => {
  const { toolset, configs } = withModes();
  await call(await toolNamed(toolset, "generic-agents__lookup"), { request: "a", mode: "quick" });
  const lookup = configs.find((config) => config.name === "generic-agents__lookup")!;
  expect(await metadataOf(lookup)).toEqual({ "stage:mode": "quick" });
  const plain = configs.find((config) => config.name === "generic-agents__plain")!;
  expect(plain.beforeRequestCallbacks).toBeUndefined();
});
