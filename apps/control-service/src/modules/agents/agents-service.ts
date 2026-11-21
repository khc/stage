import { toAgentCard, type AgentRegistry } from "@stage/agents/agent-registry";

import { guard } from "../../errors";
import type { AgentServices } from "../../platform/agent-services-client";
import type { CloudRunJobs } from "../../platform/cloud-run-jobs-client";

export type AgentsServiceDeps = {
  cloudRunJobs: Pick<CloudRunJobs, "list" | "registerAgents">;
  agentRegistry: Pick<AgentRegistry, "list">;
  // Quick services configured for Cloud Run jobs; used to report service availability in listJobs.
  agentServices?: Pick<AgentServices, "has">;
  // The jobs that may be registered; undefined allows any.
  allowedJobs?: ReadonlySet<string>;
};

type Job = Awaited<ReturnType<CloudRunJobs["list"]>>[number];
export type JobSummary = Job & { quickService?: boolean };

// The job as Cloud Run reports it, but with only the names of the container env variables:
// their values (and secret references) can hold credentials and never leave the service.
export const toJobSummary = (job: Job, quickService?: boolean): JobSummary => ({
  ...job,
  ...(quickService !== undefined && { quickService }),
  template: job.template && {
    ...job.template,
    template: job.template.template && {
      ...job.template.template,
      containers: job.template.template.containers?.map((container) => ({
        ...container,
        env: container.env?.map(({ name }) => ({ name })),
      })),
    },
  },
});

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
  agentServices,
  allowedJobs,
}: AgentsServiceDeps): AgentsService => ({
  // Only the allowed jobs are listed, so a client never offers one the service would refuse.
  listJobs: () =>
    guard("job_error", async () =>
      (await cloudRunJobs.list())
        .filter((job) => !allowedJobs || allowedJobs.has(job.name?.split("/").at(-1) ?? ""))
        .map((job) =>
          toJobSummary(job, agentServices?.has(job.name?.split("/").at(-1) ?? "") ?? false),
        ),
    ),
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
