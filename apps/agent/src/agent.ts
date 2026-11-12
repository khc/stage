import { FunctionTool, LlmAgent, type BaseAgent } from "@google/adk";
import { z } from "zod";
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

// Agents a task can select by its `agentName`; rootAgent is the default.
export const agents: Record<string, BaseAgent> = {
  [rootAgent.name]: rootAgent,
};
