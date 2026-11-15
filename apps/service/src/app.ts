import { requestId } from "@stage/http/request-id";
import { inRequestSpan, requestTelemetry } from "@stage/http/telemetry";
import { Elysia } from "elysia";

import { errorHandler } from "./http/errors";
import { openapiDocs } from "./http/openapi";
import { agentsController } from "./modules/agents/agents-controller";
import type { AgentsService } from "./modules/agents/agents-service";
import { eventsController } from "./modules/events/events-controller";
import type { EventsService } from "./modules/events/events-service";
import { healthController } from "./modules/health/health-controller";
import type { HealthService } from "./modules/health/health-service";
import type { DocumentsService } from "./modules/tasks/documents/documents-service";
import type { SessionsService } from "./modules/tasks/sessions/sessions-service";
import { tasksController } from "./modules/tasks/tasks-controller";
import type { TasksService } from "./modules/tasks/tasks-service";

// What the service needs from the outside; index.ts builds it.
export type AppDeps = {
  healthService: HealthService;
  tasksService: TasksService;
  sessionsService: SessionsService;
  // Undefined when EXTRACT_URL is not set: the document routes answer 501.
  documentsService?: DocumentsService;
  agentsService: AgentsService;
  // Undefined when PLATFORM_EVENTS_TOPIC is not set: /events answers 501.
  eventsService?: EventsService;
};

// One controller per module, mounted here. Keep this one unbroken chain: Eden reads its type.
// The request id and the telemetry come first, so every request has an id and a span before
// anything else runs; errorHandler follows, because onError only covers what is added after it.
export const createApp = (deps: AppDeps) =>
  new Elysia()
    .use(requestId())
    .use(requestTelemetry())
    .wrap(inRequestSpan)
    .use(errorHandler())
    .use(openapiDocs())
    .use(healthController(deps.healthService))
    .use(agentsController(deps.agentsService))
    .use(eventsController(deps.eventsService))
    .use(tasksController(deps));

export type App = ReturnType<typeof createApp>;
