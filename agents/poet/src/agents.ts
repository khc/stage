import type { AgentSet } from "@stage/agents/spec";

import { haikuAgent, haikuInput, haikuOutput } from "./haiku-agent";
import {
  limerickAgent,
  limerickInput,
  limerickOutput,
} from "./limerick-agent";

export const agentSet: AgentSet = {
  defaultAgent: haikuAgent.name,
  agents: {
    [haikuAgent.name]: {
      agent: haikuAgent,
      inputSchema: haikuInput,
      outputSchema: haikuOutput,
    },
    [limerickAgent.name]: {
      agent: limerickAgent,
      inputSchema: limerickInput,
      outputSchema: limerickOutput,
    },
  },
};
