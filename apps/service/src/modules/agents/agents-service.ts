import { toAgentCard, type AgentRegistry } from "@stage/agents/agent-registry";

import { guard } from "../../errors";
import type { CloudRunJobs } from "../../platform/cloud-run-jobs-client";

export type AgentsServiceDeps = {
  cloudRunJobs: Pick<CloudRunJobs, "list" | "registerAgents">;
  agentRegistry: Pick<AgentRegistry, "list">;
  // The jobs that may be registered; undefined allows any.
  allowedJobs?: ReadonlySet<string>;
};

type Job = Awaited<ReturnType<CloudRunJobs["list"]>>[number];

// A job without its container env values, which can hold credentials: the env names only.
export const toJobSummary = (job: Job) => {
  const containers = job.template?.template?.containers ?? [];
  return {
    name: job.name,
    updateTime: job.updateTime,
    conditions: job.conditions,
    images: containers.map((container) => container.image),
    envNames: containers.flatMap((container) => (container.env ?? []).map((env) => env.name)),
  };
};

type AgentInfo = Awaited<ReturnType<AgentRegistry["list"]>>[number];

// The Cloud Run jobs and the agents each job has registered. A failing dependency
// throws a DependencyError.
export type AgentsService = {
  listJobs: () => Promise<ReturnType<typeof toJobSummary>[]>;
  listAgents: (jobName: string) => Promise<AgentInfo[]>;
  // The A2A-style Agent Card of a registered agent; undefined when the job has no such agent.
  agentCard: (
    jobName: string,
    agentName: string,
  ) => Promise<ReturnType<typeof toAgentCard> | undefined>;
  // Runs the job image in its `register` mode; returns the operation name, or undefined when
  // the job is not an allowed one.
  register: (jobName: string) => Promise<string | undefined>;
};

export const createAgentsService = ({
  cloudRunJobs,
  agentRegistry,
  allowedJobs,
}: AgentsServiceDeps): AgentsService => ({
  listJobs: () => guard("job_error", async () => (await cloudRunJobs.list()).map(toJobSummary)),
  listAgents: (jobName) => guard("agents_error", () => agentRegistry.list(jobName)),
  async agentCard(jobName, agentName) {
    const known = await guard("agents_error", () => agentRegistry.list(jobName));
    const agent = known.find((a) => a.name === agentName);
    return agent && toAgentCard(jobName, agent);
  },
  register: async (jobName) =>
    allowedJobs && !allowedJobs.has(jobName)
      ? undefined
      : guard("job_error", () => cloudRunJobs.registerAgents(jobName)),
});
