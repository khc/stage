import { Elysia } from "elysia";

import { AgentsModel } from "./agents-model";
import type { AgentsService } from "./agents-service";

// Mounted at /jobs: the Cloud Run jobs, their registered agents and the agents' cards.
export const agentsController = (agentsService: AgentsService) =>
  new Elysia({ prefix: "/jobs" })
    .get("/", async () => ({ jobs: await agentsService.listJobs() }))
    .get(
      "/:jobName/agents",
      async ({ params }) => ({ agents: await agentsService.listAgents(params.jobName) }),
      { params: AgentsModel.jobParams },
    )
    .get(
      "/:jobName/agents/:agentName/card",
      async ({ params, status }) =>
        (await agentsService.agentCard(params.jobName, params.agentName)) ??
        status(404, { error: "agent_not_found" }),
      { params: AgentsModel.agentParams },
    )
    .post(
      "/:jobName/register",
      async ({ params, status }) =>
        status(202, { operation: await agentsService.register(params.jobName) }),
      { params: AgentsModel.jobParams },
    );
