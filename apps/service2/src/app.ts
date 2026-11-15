import { Elysia } from "elysia";

import { errorHandler } from "./http/errors";
import { healthController } from "./modules/health/health-controller";
import type { HealthService } from "./modules/health/health-service";
import { tasksController } from "./modules/tasks/tasks-controller";
import type { TasksService } from "./modules/tasks/tasks-service";

// What the service needs from the outside; index.ts builds it.
export type AppDeps = {
  healthService: HealthService;
  tasksService: TasksService;
};

// One controller per module, mounted here. Keep this one unbroken chain: Eden reads its type.
// errorHandler comes first: onError only covers what is added after it.
export const createApp = (deps: AppDeps) =>
  new Elysia()
    .use(errorHandler())
    .use(healthController(deps.healthService))
    .use(tasksController(deps.tasksService));

export type App = ReturnType<typeof createApp>;
