import { createModel } from "@agent-jobs/agents/model";
import type { AgentSet } from "@agent-jobs/agents/spec";
import { FunctionTool, LlmAgent } from "@google/adk";
import { z } from "zod";

export const getCurrentTime = new FunctionTool({
  name: "get_current_time",
  description: "Returns the current time for a city.",
  parameters: z.object({
    city: z.string().describe("The city to get the current time for."),
  }),
  execute: ({ city }) => ({ city, time: new Date().toISOString() }),
});

export const assistantAgent = new LlmAgent({
  name: "assistant",
  model: createModel(process.env),
  description: "A simple assistant that can tell the current time.",
  instruction:
    "You are a helpful assistant. Use get_current_time when asked about the time in a city.",
  tools: [getCurrentTime],
});

export const agentSet: AgentSet = {
  defaultAgent: assistantAgent.name,
  agents: {
    [assistantAgent.name]: {
      agent: assistantAgent,
      inputSchema: z.string().describe("A question or request, in plain text."),
      outputSchema: z.string().describe("The assistant's plain-text reply."),
    },
  },
};
