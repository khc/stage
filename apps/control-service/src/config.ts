import { TypeCompiler } from "@sinclair/typebox/compiler";
import { createConfigLoader, serverConfig, serverDefaults } from "@stage/http/config";
import { t } from "elysia";

export const loadConfig = createConfigLoader(
  {
    ...serverConfig,
    // The Cloud Run project and region that hold the agent jobs.
    GCP_PROJECT: t.String({ minLength: 1 }),
    GCP_REGION: t.String({ minLength: 1 }),
    // Base URL of apps/extract-service. Without it the document routes answer 501.
    EXTRACT_URL: t.Optional(t.String({ minLength: 1 })),
    // Set on GCP, where extract is internal-only and needs a Google ID token for this audience
    // (its URL). Leave it unset for Floci and local runs, which send no credentials.
    EXTRACT_AUDIENCE: t.Optional(t.String({ minLength: 1 })),
    // Comma-separated Cloud Run job names that tasks may use and that may be registered, or `*`
    // for every job in the project (local runs). Required, so the open state is a choice.
    AGENT_JOBS: t.String({ minLength: 1 }),
    // The Pub/Sub topic the agents publish session events to. Without it, messages serve only stored events.
    PUBSUB_TOPIC: t.Optional(t.String({ minLength: 1 })),
    // The topic the service publishes its own events to and /events streams from. Without it, /events answers 501.
    PLATFORM_EVENTS_TOPIC: t.Optional(t.String({ minLength: 1 })),
    // The base URL the A2A Agent Cards advertise (set it to the address the orchestrator job uses). Without it, the origin of each request.
    PUBLIC_URL: t.Optional(t.String({ minLength: 1 })),
    // How long the A2A gateway waits for a delegated run, in milliseconds. Keep it below the service's request timeout and the 255 s idle limit of the A2A route (hence the maximum).
    A2A_TIMEOUT_MS: t.Optional(t.Numeric({ minimum: 1000, maximum: 250_000, multipleOf: 1 })),
    // Base URL that Cloud Scheduler calls to run a task (this service, as Scheduler reaches it). Without it, the schedule routes answer 501.
    SCHEDULER_TARGET_URL: t.Optional(t.String({ minLength: 1 })),
    // The service account Scheduler signs its ID token as. Set on GCP; leave it unset for Floci, which sends no credentials.
    SCHEDULER_INVOKER: t.Optional(t.String({ minLength: 1 })),
    // A JSON object of job name to the URL of that job's quick service (see parseAgentServices). Without it, quick runs are unavailable.
    AGENT_SERVICES: t.Optional(t.String({ minLength: 1 })),
    // Set on GCP, where the agent services are internal-only and need a Google ID token for their URL. Leave it unset for Floci and local runs, which send no credentials.
    AGENT_SERVICES_ID_TOKEN: t.Optional(t.BooleanString()),
    // How long a quick run may take, in milliseconds (60 000 when unset). Keep it below the Cloud Run timeout of the agent services; the maximum keeps a quick run inside the 255 s idle limit of the A2A route.
    QUICK_BUDGET_MS: t.Optional(t.Numeric({ minimum: 1000, maximum: 240_000, multipleOf: 1 })),
  },
  serverDefaults(3000),
);

// The jobs a task may use; undefined for `*`, which allows any job in the project.
export const parseAllowedJobs = (value: string): ReadonlySet<string> | undefined =>
  value.trim() === "*"
    ? undefined
    : new Set(
        value
          .split(",")
          .map((job) => job.trim())
          .filter(Boolean),
      );

const agentServices = TypeCompiler.Compile(
  t.Record(t.String({ pattern: "^.+$" }), t.String({ minLength: 1 }), {
    additionalProperties: false,
  }),
);

// The quick services by job name: AGENT_SERVICES is a JSON object of job name to service URL.
export const parseAgentServices = (value: string): Record<string, string> => {
  const parsed: unknown = JSON.parse(value);
  if (!agentServices.Check(parsed))
    throw new Error("AGENT_SERVICES must be a JSON object of job name to URL");
  for (const url of Object.values(parsed))
    if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol))
      throw new Error("AGENT_SERVICES URLs must be http or https URLs");
  return parsed;
};
