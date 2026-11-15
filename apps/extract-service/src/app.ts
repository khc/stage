import { errorHandler } from "@stage/http/errors";
import { requestId } from "@stage/http/request-id";
import { inRequestSpan, requestTelemetry } from "@stage/http/telemetry";
import { Elysia } from "elysia";

import { extractionsController } from "./modules/extractions/extractions-controller";
import type { ExtractionsService } from "./modules/extractions/extractions-service";
import { healthController } from "./modules/health/health-controller";
import type { HealthService } from "./modules/health/health-service";

// What the service needs from the outside; index.ts builds it.
export type AppDeps = {
  healthService: HealthService;
  extractionsService: ExtractionsService;
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
    .use(healthController(deps.healthService))
    .use(extractionsController(deps.extractionsService));

export type App = ReturnType<typeof createApp>;
