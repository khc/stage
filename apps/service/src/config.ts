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
