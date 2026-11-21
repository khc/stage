import { Elysia, t } from "elysia";

import { doc, errors } from "../../http/openapi";
import { A2A_MAX_BODY_BYTES, A2A_REQUEST_TIMEOUT_SECONDS, A2aModel } from "./a2a-model";
import type { A2aService } from "./a2a-service";

const tag = "A2A";
const loose = t.Object({}, { additionalProperties: true });
const notFound = {
  description: "The job has no such agent (`agent_not_found`).",
  schema: errors.invalid.schema,
};

// Mounted at /a2a/:jobName/:agentName: the A2A endpoint of each registered agent. `publicUrl` is the
// base the cards advertise; without it, the origin the request came to.
export const a2aController = (a2aService: A2aService, publicUrl?: string) => {
  const baseUrl = (request: Request) => publicUrl ?? new URL(request.url).origin;
  return new Elysia()
    .get(
      "/a2a/:jobName/:agentName/.well-known/agent-card.json",
      async ({ params, request, status }) =>
        (await a2aService.card(params.jobName, params.agentName, baseUrl(request))) ??
        status(404, { error: "agent_not_found" }),
      {
        params: A2aModel.agentParams,
        ...doc(tag, "Get the A2A Agent Card of a registered agent", {
          200: { description: "An A2A Agent Card with the agent's endpoint.", schema: loose },
          400: errors.invalid,
          404: notFound,
          502: errors.dependency,
        }),
      },
    )
    .post(
      "/a2a/:jobName/:agentName",
      async ({ params, body, request, server, status }) => {
        if (Number(request.headers.get("content-length")) > A2A_MAX_BODY_BYTES)
          return status(413, { error: "payload_too_large" });
        // A run is waited for longer than Elysia's 30 s idle timeout; without this the connection is reset.
        server?.timeout(request, A2A_REQUEST_TIMEOUT_SECONDS);
        return (
          (await a2aService.handle(params.jobName, params.agentName, baseUrl(request), body)) ??
          status(404, { error: "agent_not_found" })
        );
      },
      {
        params: A2aModel.agentParams,
        body: loose,
        ...doc(tag, "Send an A2A JSON-RPC request to a registered agent", {
          200: {
            description:
              "A JSON-RPC response. `message/send` runs the agent as a task and waits for its reply; streaming methods and `tasks/cancel` answer with a JSON-RPC error.",
            schema: loose,
          },
          400: errors.invalid,
          404: notFound,
          413: {
            description: "The body is over 64 KiB (`payload_too_large`).",
            schema: errors.invalid.schema,
          },
          502: errors.dependency,
        }),
      },
    );
};
