import { Elysia } from "elysia";

import { HealthModel } from "./health-model";
import type { HealthService } from "./health-service";

export const healthController = (healthService: HealthService) =>
  new Elysia().get("/health", () => healthService.check(), { response: HealthModel.ok });
