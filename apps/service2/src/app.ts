import { Elysia } from "elysia";

import { healthController } from "./modules/health/controller";
import type { HealthService } from "./modules/health/service";

// What the service needs from the outside; index.ts builds it.
export type Deps = {
  healthService: HealthService;
};

// One controller per module, mounted here. Keep this one unbroken chain: Eden reads its type.
export const createApp = (deps: Deps) => new Elysia().use(healthController(deps.healthService));

export type App = ReturnType<typeof createApp>;
