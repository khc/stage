import { createAgentRegistry } from "@stage/agents/agent-registry";
import { Elysia } from "elysia";

import { createApp, type AppDeps } from "./app";
import { loadConfig, parseAllowedJobs } from "./config";
import { createA2aService } from "./modules/a2a/a2a-service";
import { createAgentsService } from "./modules/agents/agents-service";
import { createProvidersService } from "./modules/providers/providers-service";
import { createProvidersStore } from "./modules/providers/providers-store";
import { createEventsService } from "./modules/events/events-service";
import { createHealthService } from "./modules/health/health-service";
import { MAX_UPLOAD_BYTES } from "./modules/tasks/documents/documents-model";
import { createDocumentsService } from "./modules/tasks/documents/documents-service";
import { createDocumentsStore } from "./modules/tasks/documents/documents-store";
import { createSessionsService } from "./modules/tasks/sessions/sessions-service";
import { createSessionsStore } from "./modules/tasks/sessions/sessions-store";
import { createTasksService } from "./modules/tasks/tasks-service";
import { createTasksStore } from "./modules/tasks/tasks-store";
import { createCloudRunJobs, createJobsClient } from "./platform/cloud-run-jobs-client";
import { createExtractClient } from "./platform/extract-client";
import { createFirestoreClient } from "./platform/firestore-client";
import { createIdTokenAuthorization } from "./platform/id-token";
import { createPlatformEvents } from "./platform/platform-event-publisher";
import { createPlatformEventStream } from "./platform/platform-event-stream";
import { createPubSubClient } from "./platform/pubsub-client";
import { createSessionEventStream } from "./platform/session-event-stream";

const config = loadConfig(process.env);
const firestore = createFirestoreClient(config.GCP_PROJECT);
// Created only when a topic is configured, so a service nobody streams from never touches Pub/Sub.
const pubsub =
  config.PUBSUB_TOPIC || config.PLATFORM_EVENTS_TOPIC
    ? createPubSubClient(config.GCP_PROJECT)
    : undefined;
const platformEvents =
  pubsub && config.PLATFORM_EVENTS_TOPIC
    ? createPlatformEvents(pubsub, config.PLATFORM_EVENTS_TOPIC)
    : undefined;
// Each wrapped operation publishes one platform event after it succeeds.
const published = <T>(wrap: ((value: T) => T) | undefined, value: T) =>
  wrap ? wrap(value) : value;

const tasksStore = published(platformEvents?.tasksStore, createTasksStore(firestore));
const sessionsStore = createSessionsStore(firestore);
const documentsStore = config.EXTRACT_URL
  ? published(
      platformEvents?.documentsStore,
      createDocumentsStore({
        firestore,
        extractClient: createExtractClient(config.EXTRACT_URL, {
          authorization: config.EXTRACT_AUDIENCE
            ? createIdTokenAuthorization(config.EXTRACT_AUDIENCE)
            : undefined,
        }),
      }),
    )
  : undefined;
const agentRegistry = createAgentRegistry(firestore);
const cloudRunJobs = published(
  platformEvents?.cloudRunJobs,
  createCloudRunJobs(createJobsClient(process.env), {
    project: config.GCP_PROJECT,
    location: config.GCP_REGION,
  }),
);

const allowedJobs = parseAllowedJobs(config.AGENT_JOBS);
if (!allowedJobs) console.warn("AGENT_JOBS is *: any Cloud Run job in the project can be run");
const sessionEventStream =
  pubsub && config.PUBSUB_TOPIC ? createSessionEventStream(pubsub, config.PUBSUB_TOPIC) : undefined;
const platformEventStream =
  pubsub && config.PLATFORM_EVENTS_TOPIC
    ? createPlatformEventStream(pubsub, config.PLATFORM_EVENTS_TOPIC)
    : undefined;

const tasksService = createTasksService({
  tasksStore,
  agentRegistry,
  cloudRunJobs,
  sessionsStore,
  documentsStore,
  allowedJobs,
});
const agentsService = createAgentsService({ cloudRunJobs, agentRegistry, allowedJobs });
const providersService = createProvidersService({
  providersStore: createProvidersStore(firestore),
});

const appDeps: AppDeps = {
  healthService: createHealthService(),
  tasksService,
  sessionsService: createSessionsService({
    sessionsStore,
    sessionEventStream,
  }),
  documentsService: documentsStore && createDocumentsService({ documentsStore }),
  agentsService,
  providersService,
  a2aService: createA2aService(
    { agentsService, tasksService, sessionsStore, allowedJobs },
    { ...(config.A2A_TIMEOUT_MS && { timeoutMs: config.A2A_TIMEOUT_MS }) },
  ),
  ...(config.PUBLIC_URL && { publicUrl: config.PUBLIC_URL }),
  eventsService: platformEventStream && createEventsService({ platformEventStream }),
};

// Server options go in the constructor, as the Elysia docs show. Bun refuses a body over the
// cap before it is read; the documents route answers a declared oversize with a 413 JSON body.
const app = new Elysia({
  serve: { hostname: config.HOST, maxRequestBodySize: MAX_UPLOAD_BYTES + 1024 * 1024 },
})
  .use(createApp(appDeps))
  .listen(config.PORT);

console.log(`Started server: http://${app.server?.hostname}:${app.server?.port}`);

// Delete this process's Pub/Sub subscriptions instead of leaving them to expire.
process.once("SIGTERM", async () => {
  await Promise.allSettled([sessionEventStream?.stop?.(), platformEventStream?.stop?.()]);
  process.exit(0);
});
