import { FunctionTool, LlmAgent } from "@google/adk";
import { createModel } from "@stage/agents/model";
import type { AgentSet } from "@stage/agents/spec";
import { z } from "zod";

import {
  documentAnalyserAgent,
  documentAnalyserInput,
  documentAnalyserOutput,
} from "./document-analyser";

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
      // A question is quick; a long request can run as a background workflow.
      modes: ["quick", "workflow"],
    },
    [documentAnalyserAgent.name]: {
      agent: documentAnalyserAgent,
      inputSchema: documentAnalyserInput,
      outputSchema: documentAnalyserOutput,
    },
  },
};
