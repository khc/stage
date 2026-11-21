import type { AgentSet } from "@stage/agents/spec";

import { haikuAgent, haikuInput, haikuOutput } from "./haiku-agent";
import { limerickAgent, limerickInput, limerickOutput } from "./limerick-agent";

export const agentSet: AgentSet = {
  defaultAgent: haikuAgent.name,
  agents: {
    [haikuAgent.name]: {
      agent: haikuAgent,
      inputSchema: haikuInput,
      outputSchema: haikuOutput,
      // Quick runs on the agent service, workflow runs as a job (`agent_service_apps` in infra).
      modes: ["quick", "workflow"],
    },
    [limerickAgent.name]: {
      agent: limerickAgent,
      inputSchema: limerickInput,
      outputSchema: limerickOutput,
      // Quick runs on the agent service, workflow runs as a job (`agent_service_apps` in infra).
      modes: ["quick", "workflow"],
    },
  },
};
