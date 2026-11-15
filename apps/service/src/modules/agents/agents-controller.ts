import { Elysia, t } from "elysia";

import { doc, errors } from "../../http/openapi";
import { AgentsModel } from "./agents-model";
import type { AgentsService } from "./agents-service";

const tag = "Jobs and agents";
const loose = t.Object({}, { additionalProperties: true });
const job = t.Object({
  name: t.Optional(t.String()),
  updateTime: t.Optional(t.Any()),
  conditions: t.Optional(t.Any()),
  images: t.Array(t.Optional(t.String())),
  envNames: t.Array(t.Optional(t.String())),
});

// Mounted at /jobs: the Cloud Run jobs, their registered agents and the agents' cards.
export const agentsController = (agentsService: AgentsService) =>
  new Elysia({ prefix: "/jobs" })
    .get("", async () => ({ jobs: await agentsService.listJobs() }), {
      ...doc(tag, "List the Cloud Run jobs", {
        200: {
          description:
            "The jobs of the configured project and region: name, update time, conditions, images and env names (never env values).",
          schema: t.Object({ jobs: t.Array(job) }),
        },
        502: errors.dependency,
      }),
    })
    .get(
      "/:jobName/agents",
      async ({ params }) => ({ agents: await agentsService.listAgents(params.jobName) }),
      {
        params: AgentsModel.jobParams,
        ...doc(tag, "List the agents a job has registered", {
          200: {
            description: "The agents with their input and output JSON Schemas.",
            schema: t.Object({ agents: t.Array(loose) }),
          },
          400: errors.invalid,
          502: errors.dependency,
        }),
      },
    )
    .get(
      "/:jobName/agents/:agentName/card",
      async ({ params, status }) =>
        (await agentsService.agentCard(params.jobName, params.agentName)) ??
        status(404, { error: "agent_not_found" }),
      {
        params: AgentsModel.agentParams,
        ...doc(tag, "Get the Agent Card of a registered agent", {
          200: { description: "An A2A-style Agent Card.", schema: loose },
          400: errors.invalid,
          404: {
            description: "The job has no such agent (`agent_not_found`).",
            schema: errors.invalid.schema,
          },
          502: errors.dependency,
        }),
      },
    )
    .post(
      "/:jobName/register",
      async ({ params, status }) => {
        const operation = await agentsService.register(params.jobName);
        return operation === undefined
          ? status(400, { error: "unknown_job" })
          : status(202, { operation });
      },
      {
        params: AgentsModel.jobParams,
        ...doc(tag, "Run a job in its register mode, which records its agents", {
          202: {
            description: "The Cloud Run execution was started.",
            schema: t.Object({ operation: t.String() }),
          },
          400: "Invalid job name, or a job that is not allowed (`unknown_job`).",
          502: errors.dependency,
        }),
      },
    );
