import { zValidator } from "@hono/zod-validator";
import { toAgentCard, type AgentRegistry } from "@stage/agents/agent-registry";
import { Hono } from "hono";

import { guard } from "../errors";
import type { CloudRunJobs } from "../platform/cloud-run-jobs";
import { agentParamSchema, jobParamSchema } from "../schemas";

export const jobRoute = (jobs: CloudRunJobs, registry: Pick<AgentRegistry, "list">) =>
  new Hono()
    .get("/", async (c) => c.json({ jobs: await guard("job_error", jobs.list) }))
    .get("/:jobName/agents", zValidator("param", jobParamSchema), async (c) => {
      const { jobName } = c.req.valid("param");
      const agents = await guard("agents_error", () => registry.list(jobName));
      return c.json({ agents });
    })
    .get("/:jobName/agents/:agentName/card", zValidator("param", agentParamSchema), async (c) => {
      const { jobName, agentName } = c.req.valid("param");
      const known = await guard("agents_error", () => registry.list(jobName));
      const agent = known.find((a) => a.name === agentName);
      if (!agent) return c.json({ error: "agent_not_found" }, 404);
      return c.json(toAgentCard(jobName, agent));
    })
    .post("/:jobName/register", zValidator("param", jobParamSchema), async (c) => {
      const operation = await guard("job_error", () =>
        jobs.registerAgents(c.req.valid("param").jobName),
      );
      return c.json({ operation }, 202);
    });
