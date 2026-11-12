import type { BaseAgent } from "@google/adk";
import { z } from "zod";

import type { AgentInfo, JsonSchema } from "./agent-registry";

// An agent with the contract it is registered under: what a task's message to
// it should look like and what its final reply contains. Free-text agents use
// string schemas; the schemas are published in the registry as JSON Schema.
export type AgentSpec = {
  agent: BaseAgent;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
};

// The agents one job image holds. A task selects one by its `agentName`;
// `defaultAgent` runs when it names none.
export type AgentSet = {
  agents: Record<string, AgentSpec>;
  defaultAgent: string;
};

const toJsonSchema = (schema: z.ZodType): JsonSchema => {
  const { $schema, ...rest } = z.toJSONSchema(schema);
  return rest;
};

export const describeAgents = (agents: Record<string, AgentSpec>): AgentInfo[] =>
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
