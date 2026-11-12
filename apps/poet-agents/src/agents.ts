import type { AgentSet } from "@agent-jobs/agents/spec";
import { haikuAgent, haikuInput, haikuOutput } from "./haiku-agent";

export const agentSet: AgentSet = {
  defaultAgent: haikuAgent.name,
  agents: {
    [haikuAgent.name]: {
      agent: haikuAgent,
      inputSchema: haikuInput,
      outputSchema: haikuOutput,
    },
  },
};
