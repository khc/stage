import { toAgentCard, type AgentRegistry } from "@stage/agents/agent-registry";

import { guard } from "../../errors";
import type { CloudRunJobs } from "../../platform/cloud-run-jobs-client";

export type AgentsServiceDeps = {
  cloudRunJobs: Pick<CloudRunJobs, "list" | "registerAgents">;
  agentRegistry: Pick<AgentRegistry, "list">;
};

type AgentInfo = Awaited<ReturnType<AgentRegistry["list"]>>[number];

// The Cloud Run jobs and the agents each job has registered. A failing dependency
// throws a DependencyError.
export type AgentsService = {
  listJobs: () => Promise<Awaited<ReturnType<CloudRunJobs["list"]>>>;
  listAgents: (jobName: string) => Promise<AgentInfo[]>;
  // The A2A-style Agent Card of a registered agent; undefined when the job has no such agent.
  agentCard: (
    jobName: string,
    agentName: string,
  ) => Promise<ReturnType<typeof toAgentCard> | undefined>;
  // Runs the job image in its `register` mode; returns the operation name.
  register: (jobName: string) => Promise<string>;
};

export const createAgentsService = ({
  cloudRunJobs,
  agentRegistry,
}: AgentsServiceDeps): AgentsService => ({
  listJobs: () => guard("job_error", cloudRunJobs.list),
  listAgents: (jobName) => guard("agents_error", () => agentRegistry.list(jobName)),
  async agentCard(jobName, agentName) {
    const known = await guard("agents_error", () => agentRegistry.list(jobName));
    const agent = known.find((a) => a.name === agentName);
    return agent && toAgentCard(jobName, agent);
  },
  register: (jobName) => guard("job_error", () => cloudRunJobs.registerAgents(jobName)),
});
