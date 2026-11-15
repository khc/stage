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
    // The Pub/Sub topic the agents publish session events to. Without it, messages serve only stored events.
    PUBSUB_TOPIC: t.Optional(t.String({ minLength: 1 })),
    // The topic the service publishes its own events to and /events streams from. Without it, /events answers 501.
    PLATFORM_EVENTS_TOPIC: t.Optional(t.String({ minLength: 1 })),
  },
  serverDefaults(3000),
);
