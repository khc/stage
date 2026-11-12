import { FunctionTool, LlmAgent, type BaseAgent } from "@google/adk";
import { z } from "zod";
import type { AgentInfo, JsonSchema } from "./agent-registry";
import { haikuAgent, haikuInput, haikuOutput } from "./haiku-agent";
import { createModel } from "./model";

export const getCurrentTime = new FunctionTool({
  name: "get_current_time",
  description: "Returns the current time for a city.",
  parameters: z.object({
    city: z.string().describe("The city to get the current time for."),
  }),
  execute: ({ city }) => ({ city, time: new Date().toISOString() }),
});

export const rootAgent = new LlmAgent({
  name: "assistant",
  model: createModel(process.env),
  description: "A simple assistant that can tell the current time.",
  instruction:
    "You are a helpful assistant. Use get_current_time when asked about the time in a city.",
  tools: [getCurrentTime],
});

// An agent with the contract it is registered under: what a task's message to
// it should look like and what its final reply contains. Free-text agents use
// string schemas; the schemas are published in the registry as JSON Schema.
export type AgentSpec = {
  agent: BaseAgent;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
};

// Agents a task can select by its `agentName`; rootAgent is the default.
export const agents: Record<string, AgentSpec> = {
  [rootAgent.name]: {
    agent: rootAgent,
    inputSchema: z.string().describe("A question or request, in plain text."),
    outputSchema: z.string().describe("The assistant's plain-text reply."),
  },
  [haikuAgent.name]: {
    agent: haikuAgent,
    inputSchema: haikuInput,
    outputSchema: haikuOutput,
  },
};

const toJsonSchema = (schema: z.ZodType): JsonSchema => {
  const { $schema, ...rest } = z.toJSONSchema(schema);
  return rest;
};

export const describeAgents = (): AgentInfo[] =>
  Object.entries(agents).map(([name, spec]) => ({
    name,
    ...(spec.agent.description && { description: spec.agent.description }),
    inputSchema: toJsonSchema(spec.inputSchema),
    outputSchema: toJsonSchema(spec.outputSchema),
  }));

// Free-text agents (string input schema) take any message. Structured agents
// take a JSON message that must match their input schema.
export const checkInput = (spec: AgentSpec, message: string) => {
  if (toJsonSchema(spec.inputSchema).type === "string") return;
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    throw new Error("Input must be JSON matching the agent's input schema");
  }
  const result = spec.inputSchema.safeParse(value);
  if (!result.success)
    throw new Error(
      `Input does not match the agent's input schema: ${z.prettifyError(result.error)}`,
    );
};
